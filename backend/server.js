/**
 * SmartApply — API server.
 *
 * URL namespaces (Layer 1 enforcement is visible right here in the route table):
 *   /api/auth/*         public (login) or any authenticated user
 *   /api/super-admin/*  SUPER_ADMIN only
 *   /api/management/*   ORG_ADMIN + RECRUITER
 *   /api/portal/*       CONSULTANT only, filtered by req.user.id
 *   /api/lookups        any authenticated tenant user
 */
import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import hpp from 'hpp';
import rateLimit from 'express-rate-limit';

import { assertDbConnection } from './db.js';
import { verifyToken } from './middleware/verifyToken.js';
import {
    isSuperAdmin, isOrgAdmin, isManagement, isConsultant, isTenantUser,
} from './middleware/roleGuards.js';
import { validate } from './middleware/validate.js';
import { notFound, errorHandler } from './middleware/errorHandler.js';

import {
    login, logout, me, changePassword,
    loginSchema, changePasswordSchema,
} from './controllers/authController.js';
import {
    listOrganizations, getOrganization, createOrganization,
    updateOrganization, toggleOrganizationActive, platformStats,
    createOrgSchema, updateOrgSchema,
} from './controllers/superAdminController.js';
import {
    listUsers, createUser, updateUser,
    suspendUser, reactivateUser, terminateUser,
    revealUserPassword, resetUserPassword,
    listAssignments, assignConsultant, orgStats,
    setRecruiterRoster, setConsultantRecruiter,
    createUserSchema, updateUserSchema, assignSchema, resetPasswordSchema,
    lifecycleSchema, recruiterRosterSchema, consultantRecruiterSchema,
} from './controllers/managementController.js';
import {
    getCriteria, saveCriteria, toggleCriteriaActive,
    listCriteriaVersions, getCriteriaVersion, restoreCriteriaVersion, getMyCriteria,
} from './controllers/criteriaController.js';
import {
    criteriaSchema, toggleActiveSchema, restoreSchema,
} from './config/criteriaSchema.js';
import {
    myQuestions, myOutstandingCount, submitAnswer,
    listAnswersForReview, pendingAnswerCount, reviewAnswer, listConsultantAnswers,
    submitAnswerSchema, reviewAnswerSchema,
} from './controllers/answerController.js';
import {
    listQuestions, createQuestion, updateQuestion, raiseQuestionForConsultant,
    createQuestionSchema, updateQuestionSchema, raiseQuestionSchema,
} from './controllers/questionController.js';
import {
    triggerRun, listRuns, listSources, getSchedule, updateSchedule, scheduleSchema,
} from './controllers/discoveryController.js';
import {
    listPostings, getPosting, listConsultantQueue, updateSource, toggleSourceSchema,
} from './controllers/postingController.js';
import {
    getQueueItem, skipItem, requeueItem, transitionItem, cancelItem, transitionSchema,
    listApplications, getApplication,
} from './controllers/queueController.js';
import { verifyDevice } from './middleware/verifyDevice.js';
import {
    activate, activateSchema, heartbeat, deviceQueue,
    leaseItem, reportFilled, reportParked, reportSkipped, reclassify,
    reportSubmitted, reportSchema, reportBoardStatus, boardStatusSchema,
    listDevices, issueDevice, issueDeviceSchema, revokeDevice,
} from './controllers/deviceController.js';
import { startDiscoveryScheduler } from './jobs/discoveryScheduler.js';
import { startQueueMaintenance } from './jobs/queueMaintenance.js';
import { myDashboard } from './controllers/portalController.js';
import { getLookups } from './controllers/lookupController.js';
import { getModuleAuditLogs } from './controllers/auditLogController.js';
import {
    getProfileSchema, listConsultants, getConsultantProfile,
    adminUpdateProfile, myProfile, adminUpdateProfileSchema,
} from './controllers/profileController.js';
import {
    submitChangeRequest, withdrawChangeRequest, listChangeRequests,
    reviewChangeRequest, pendingCount,
    submitChangeSchema, reviewSchema,
} from './controllers/profileChangeController.js';
import { uploadResume, downloadResume, listResumes } from './controllers/resumeController.js';
import { resumeUpload } from './utils/upload.js';

const app = express();
const PORT = Number(process.env.PORT ?? 5000);

/* ─────────────────────────── hardening ─────────────────────────── */

app.set('trust proxy', 1);
app.use(helmet());
app.use(hpp());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(cookieParser());

// Credentials are sent with every request, so '*' is not permitted here.
const allowlist = (process.env.CLIENT_ORIGIN ?? '')
    .split(',').map((o) => o.trim()).filter(Boolean);

app.use(cors({
    origin(origin, callback) {
        if (!origin) return callback(null, true);          // curl / same-origin
        if (allowlist.includes(origin)) return callback(null, true);
        return callback(new Error(`Origin ${origin} not allowed by CORS`));
    },
    credentials: true,
}));

app.use('/api', rateLimit({
    windowMs: 60_000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Please slow down.' },
}));

/**
 * Coarse volumetric backstop only — it counts failures per IP.
 *
 * The precise control is the per-account lockout in authController
 * (checkLockout / login_attempts), which is what actually stops someone
 * grinding a single account. This limit exists purely to blunt high-volume
 * spray from one address, so it is set well above what a shared office NAT
 * produces in normal use: several colleagues each fumbling a password must
 * never lock out the whole building, which was half of finding A-2.
 */
const loginLimiter = rateLimit({
    windowMs: 15 * 60_000,
    max: 60,
    skipSuccessfulRequests: true,
    message: { error: 'Too many login attempts from this network. Try again later.' },
});

/* ───────────────────────────── health ──────────────────────────── */

app.get('/api/health', async (req, res) => {
    try {
        const db = await assertDbConnection();
        res.json({ status: 'ok', db: 'ok', connectedAs: db.current_user });
    } catch (err) {
        res.status(503).json({ status: 'degraded', db: 'unreachable', error: err.message });
    }
});

/* ────────────────────────────── auth ───────────────────────────── */

app.post('/api/auth/login', [loginLimiter, validate(loginSchema)], login);
app.post('/api/auth/logout', logout);
app.get('/api/auth/me', [verifyToken], me);
app.post('/api/auth/change-password',
    [verifyToken, validate(changePasswordSchema)], changePassword);

/* ─────────────────────────── lookups ───────────────────────────── */

app.get('/api/lookups', [verifyToken], getLookups);

/* ───────────────────────── super admin ─────────────────────────── */

app.get('/api/super-admin/stats', [verifyToken, isSuperAdmin], platformStats);
app.get('/api/super-admin/organizations', [verifyToken, isSuperAdmin], listOrganizations);
app.get('/api/super-admin/organizations/:id', [verifyToken, isSuperAdmin], getOrganization);
app.post('/api/super-admin/organizations',
    [verifyToken, isSuperAdmin, validate(createOrgSchema)], createOrganization);
app.patch('/api/super-admin/organizations/:id',
    [verifyToken, isSuperAdmin, validate(updateOrgSchema)], updateOrganization);
app.post('/api/super-admin/organizations/:id/toggle-active',
    [verifyToken, isSuperAdmin], toggleOrganizationActive);

/* ───────────────────────── management ──────────────────────────── */

app.get('/api/management/stats', [verifyToken, isManagement], orgStats);

// Read is open to management; write and disable are ORG_ADMIN only.
app.get('/api/management/users', [verifyToken, isManagement], listUsers);
app.post('/api/management/users',
    [verifyToken, isOrgAdmin, validate(createUserSchema)], createUser);
app.patch('/api/management/users/:id',
    [verifyToken, isOrgAdmin, validate(updateUserSchema)], updateUser);
// Employment lifecycle. Suspend is reversible; terminate is not.
app.post('/api/management/users/:id/suspend',
    [verifyToken, isOrgAdmin, validate(lifecycleSchema)], suspendUser);
app.post('/api/management/users/:id/reactivate',
    [verifyToken, isOrgAdmin], reactivateUser);
app.post('/api/management/users/:id/terminate',
    [verifyToken, isOrgAdmin, validate(lifecycleSchema)], terminateUser);

// Password reveal / reset — ORG_ADMIN only, org-scoped, every reveal audited.
// One user per request by design: never bundled into the /users list payload.
app.get('/api/management/users/:id/password',
    [verifyToken, isOrgAdmin], revealUserPassword);
app.post('/api/management/users/:id/reset-password',
    [verifyToken, isOrgAdmin, validate(resetPasswordSchema)], resetUserPassword);

app.get('/api/management/assignments', [verifyToken, isManagement], listAssignments);
app.post('/api/management/assignments',
    [verifyToken, isOrgAdmin, validate(assignSchema)], assignConsultant);

// Bulk edit from either end. Both take the desired end state and reconcile,
// so replaying a stale payload changes nothing.
app.put('/api/management/assignments/recruiter/:recruiterId',
    [verifyToken, isOrgAdmin, validate(recruiterRosterSchema)], setRecruiterRoster);
app.put('/api/management/assignments/consultant/:consultantId',
    [verifyToken, isOrgAdmin, validate(consultantRecruiterSchema)], setConsultantRecruiter);

app.get('/api/management/audit-logs/:module', [verifyToken, isOrgAdmin], getModuleAuditLogs);

/* ──────────────── consultant profiles (Phase 2) ────────────────── */

// The field registry, so the client renders forms from the server's definition.
app.get('/api/profile-schema', [verifyToken], getProfileSchema);

app.get('/api/management/consultants', [verifyToken, isManagement], listConsultants);
app.get('/api/management/consultants/:id', [verifyToken, isManagement], getConsultantProfile);
app.put('/api/management/consultants/:id/profile',
    [verifyToken, isOrgAdmin, validate(adminUpdateProfileSchema)], adminUpdateProfile);

// ── change requests ──
// Reviewing is open to ORG_ADMIN and RECRUITER; a recruiter is narrowed to
// their assigned consultants inside the controller.
app.get('/api/management/profile-changes', [verifyToken, isManagement], listChangeRequests);
app.get('/api/management/profile-changes/count', [verifyToken, isManagement], pendingCount);
app.post('/api/management/profile-changes/:id/review',
    [verifyToken, isManagement, validate(reviewSchema)], reviewChangeRequest);

// ── resumes ──
app.get('/api/management/consultants/:id/resumes', [verifyToken, isManagement], listResumes);
app.post('/api/management/consultants/:id/resume',
    [verifyToken, isManagement], resumeUpload, uploadResume);
app.get('/api/resumes/:artifactId/download', [verifyToken], downloadResume);

/* ──────────────── search criteria (Phase 3) ────────────────────── */
//
// isManagement, NOT isOrgAdmin: P-10 gives a recruiter edit rights over their
// own consultants. The narrowing to *their* consultants happens in the
// controller via canAccessConsultant, which is also what makes an out-of-scope
// id return 404 instead of leaking that it exists.
//
// There is no consultant-facing WRITE route here or anywhere else. R-23 is
// enforced by the endpoint not existing.

app.get('/api/management/consultants/:id/criteria',
    [verifyToken, isManagement], getCriteria);
app.put('/api/management/consultants/:id/criteria',
    [verifyToken, isManagement, validate(criteriaSchema)], saveCriteria);
app.post('/api/management/consultants/:id/criteria/toggle-active',
    [verifyToken, isManagement, validate(toggleActiveSchema)], toggleCriteriaActive);

app.get('/api/management/consultants/:id/criteria/versions',
    [verifyToken, isManagement], listCriteriaVersions);
app.get('/api/management/consultants/:id/criteria/versions/:versionId',
    [verifyToken, isManagement], getCriteriaVersion);
app.post('/api/management/consultants/:id/criteria/versions/:versionId/restore',
    [verifyToken, isManagement, validate(restoreSchema)], restoreCriteriaVersion);

/* ─────────────── answer bank (Phase 4) ─────────────────────────── */
//
// isManagement on the review routes, NOT isOrgAdmin: P-04 lets a recruiter
// approve for their own consultants. The two narrowings that matter happen
// inside the controller, because neither can be expressed as a route guard:
//
//   scope    canAccessConsultant — a recruiter only their assigned people
//   routing  R-07 — a category with requires_owner_approval is ORG_ADMIN only,
//            and a recruiter must still SEE those items (flagged, locked) so
//            they know what their consultant is waiting on
//
// There is no consultant-facing review route anywhere. R-06 additionally
// refuses a reviewer who wrote the answer.

app.get('/api/management/answers', [verifyToken, isManagement], listAnswersForReview);
app.get('/api/management/answers/count', [verifyToken, isManagement], pendingAnswerCount);
app.post('/api/management/answers/:id/review',
    [verifyToken, isManagement, validate(reviewAnswerSchema)], reviewAnswer);

app.get('/api/management/consultants/:id/answers',
    [verifyToken, isManagement], listConsultantAnswers);
app.post('/api/management/consultants/:id/questions',
    [verifyToken, isManagement, validate(raiseQuestionSchema)], raiseQuestionForConsultant);

// The bank itself is ORG_ADMIN's to curate — recruiters raise questions at a
// consultant (above) rather than editing the shared set.
app.get('/api/management/questions', [verifyToken, isManagement], listQuestions);
app.post('/api/management/questions',
    [verifyToken, isOrgAdmin, validate(createQuestionSchema)], createQuestion);
app.patch('/api/management/questions/:id',
    [verifyToken, isOrgAdmin, validate(updateQuestionSchema)], updateQuestion);

/* ─────────────── job discovery (Phase 5) ───────────────────────── */
//
// Triggering a run reaches out to the open web and consumes rate budget at
// every enabled board, so it is ORG_ADMIN only. Reading run history and board
// health is open to management, because a recruiter wondering why their
// consultant's queue is empty should be able to see that a source is failing.

app.post('/api/management/discovery/run', [verifyToken, isOrgAdmin], triggerRun);
app.get('/api/management/discovery/runs', [verifyToken, isManagement], listRuns);
app.get('/api/management/discovery/sources', [verifyToken, isManagement], listSources);
// Enabling a board is when this system starts reaching out to the open web,
// so it is ORG_ADMIN only and audited.
app.patch('/api/management/discovery/sources/:id',
    [verifyToken, isOrgAdmin, validate(toggleSourceSchema)], updateSource);

// The automatic 4-hour cycle. Readable by management so a recruiter can see
// whether it is on; switching it belongs to ORG_ADMIN, like enabling a board.
app.get('/api/management/discovery/schedule', [verifyToken, isManagement], getSchedule);
app.patch('/api/management/discovery/schedule',
    [verifyToken, isOrgAdmin, validate(scheduleSchema)], updateSchedule);

app.get('/api/management/postings', [verifyToken, isManagement], listPostings);
app.get('/api/management/postings/:id', [verifyToken, isManagement], getPosting);
app.get('/api/management/consultants/:id/queue', [verifyToken, isManagement], listConsultantQueue);

/* ──────────────────────── the queue (portal) ───────────────────── */
//
// Same state machine the desktop app calls, so a move that is illegal for one
// is illegal for the other. Cancelling is ORG_ADMIN only: it voids a queue
// rather than declining a job.
//
// Nothing here moves an item to a different consultant. R-03 is enforced by the
// absence of a route, not by a permission check.
app.get('/api/management/queue/:id', [verifyToken, isManagement], getQueueItem);
app.post('/api/management/queue/:id/skip',
    [verifyToken, isManagement, validate(transitionSchema)], skipItem);
app.post('/api/management/queue/:id/requeue',
    [verifyToken, isManagement, validate(transitionSchema)], requeueItem);
app.post('/api/management/queue/:id/transition',
    [verifyToken, isManagement, validate(transitionSchema)], transitionItem);
// The permanent record. Read-only by construction: no route edits or deletes
// one, and the database refuses it regardless of who asks.
app.get('/api/management/consultants/:id/applications',
    [verifyToken, isManagement], listApplications);
app.get('/api/management/applications/:id', [verifyToken, isManagement], getApplication);

app.post('/api/management/queue/:id/cancel',
    [verifyToken, isOrgAdmin, validate(transitionSchema)], cancelItem);

/* ─────────────── consultant desktop app (device auth) ──────────── */
//
// A separate identity from the browser session: `verifyDevice` authenticates a
// MACHINE and yields exactly one consultant, so nothing here can reach another
// person's data or any management route. Activation is the only open route,
// and it trades a one-time code issued by the owner for a bound device token.

app.post('/api/device/activate', [validate(activateSchema)], activate);

app.get('/api/device/heartbeat', [verifyDevice], heartbeat);
app.get('/api/device/queue', [verifyDevice], deviceQueue);

// Every state change goes through the shared queue state machine, so the app
// cannot reach a state the portal would refuse.
app.post('/api/device/queue/:id/lease', [verifyDevice], leaseItem);
app.post('/api/device/queue/:id/filled', [verifyDevice, validate(reportSchema)], reportFilled);
app.post('/api/device/queue/:id/parked', [verifyDevice, validate(reportSchema)], reportParked);
app.post('/api/device/queue/:id/skipped', [verifyDevice, validate(reportSchema)], reportSkipped);
app.post('/api/device/queue/:id/reclassify', [verifyDevice, validate(reportSchema)], reclassify);
// R-02: this RECORDS a submission the consultant already made. It never causes
// one, and it is the only route that can create an application record.
app.post('/api/device/queue/:id/submitted',
    [verifyDevice, validate(reportSchema)], reportSubmitted);

app.post('/api/device/board-status',
    [verifyDevice, validate(boardStatusSchema)], reportBoardStatus);

/* ─────────────── desktop app access (owner-managed) ────────────── */
//
// R-21: only the owner grants access, one live device per consultant, revocable
// instantly. Issuing replaces whatever that consultant had before.
app.get('/api/management/devices', [verifyToken, isManagement], listDevices);
app.post('/api/management/devices',
    [verifyToken, isOrgAdmin, validate(issueDeviceSchema)], issueDevice);
app.delete('/api/management/devices/:id', [verifyToken, isOrgAdmin], revokeDevice);

/* ─────────────────────── consultant portal ─────────────────────── */

app.get('/api/portal/me', [verifyToken, isConsultant], myProfile);
app.get('/api/portal/criteria', [verifyToken, isConsultant], getMyCriteria);
app.get('/api/portal/questions', [verifyToken, isConsultant], myQuestions);
app.get('/api/portal/answers/count', [verifyToken, isConsultant], myOutstandingCount);
app.post('/api/portal/answers',
    [verifyToken, isConsultant, validate(submitAnswerSchema)], submitAnswer);
app.get('/api/portal/dashboard', [verifyToken, isConsultant], myDashboard);
app.post('/api/portal/resume', [verifyToken, isConsultant], resumeUpload, uploadResume);
app.post('/api/portal/profile/change-request',
    [verifyToken, isConsultant, validate(submitChangeSchema)], submitChangeRequest);
app.delete('/api/portal/profile/change-request',
    [verifyToken, isConsultant], withdrawChangeRequest);

/* ───────────────────────────── tail ────────────────────────────── */

app.use(notFound);
app.use(errorHandler);

const start = async () => {
    try {
        const db = await assertDbConnection();
        console.log(`✅ Database connected as "${db.current_user}" → ${db.current_database}`);
    } catch (err) {
        console.error('❌ Database unreachable at boot:', err.message);
        process.exit(1);
    }

    for (const key of ['JWT_SECRET', 'PASSWORD_ENC_KEY']) {
        if (!process.env[key]) {
            console.error(`❌ ${key} is not set. Copy .env.example to .env and fill it in.`);
            process.exit(1);
        }
    }

    startDiscoveryScheduler();
    // Deliberately NOT gated on DISCOVERY_ENABLED: expiring an abandoned lease
    // or releasing a stale cap slot is repair work on state we already hold,
    // not a reason to reach out to a provider.
    startQueueMaintenance();

    app.listen(PORT, () => {
        console.log(`✅ API listening on http://localhost:${PORT}`);
        console.log(`   CORS allowlist: ${allowlist.join(', ') || '(none)'}`);
    });
};

start();
