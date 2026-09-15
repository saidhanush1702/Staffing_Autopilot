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
    previewQueries,
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
    leaseItem, reportFilled, reportParked, reportSkipped, reclassify, askQuestions,
    reportSubmitted, reportSchema, reportBoardStatus, boardStatusSchema,
    listDevices, issueDevice, issueDeviceSchema, revokeDevice, deviceResume,
    deviceApplications, deviceQuestions, deviceAnswerQuestion, deviceAnswerSchema,
    deviceAnswers,
    revealActivationCode,
} from './controllers/deviceController.js';
import {
    receiveWebhook as jobspipeWebhook,
    getSettings as getJobsPipeSettings,
    rotateToken as rotateJobsPipeToken,
    revealToken as revealJobsPipeToken,
    setEnabled as setJobsPipeEnabled,
    listEvents as listJobsPipeEvents,
    sendTestEvent as sendJobsPipeTest,
    enabledSchema as jobspipeEnabledSchema,
} from './controllers/jobspipeListener.js';
import {
    getPullStatus, previewPoll, runPollNow, setPullEnabled,
    pollSchema, pullEnabledSchema,
} from './controllers/jobspipePullController.js';
import { startDiscoveryScheduler } from './jobs/discoveryScheduler.js';
import { startQueueMaintenance } from './jobs/queueMaintenance.js';
import { startWorker } from './jobs/worker.js';
// The JobsPipe PULL path (Phase 5c). A third ingestion door: the webhook needs
// a paid plan, so the search API is the only JobsPipe surface that can be
// trialled. Off unless JOBSPIPE_POLL_ENABLED=true — see jobs/jobspipePoller.js.
import { startJobsPipePoller } from './jobs/jobspipePoller.js';
// Importing the handler modules is what registers them with the worker.
// Without this line the worker starts, claims a tailoring job, finds no
// handler for its kind, and dead-letters it — which looks exactly like a
// broken pipeline rather than a missing import.
import './jobs/handlers/index.js';
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
import {
    listReviews, reviewCount, getReview, approveReview, rejectReview, retryReview,
    reviewDecisionSchema,
} from './controllers/resumeReviewController.js';
import {
    listContacts, queueItemContacts, applicationContacts, deviceQueueContacts,
    findContactNow, setDoNotContact, contactUsage, dncSchema,
} from './controllers/contactController.js';
import { aiUsage } from './controllers/aiUsageController.js';
import {
    agentStart, agentStep, agentFinish, getAgentSettings, updateAgentSettings,
    agentStartSchema, agentStepSchema, agentFinishSchema, agentSettingsSchema,
} from './controllers/agentController.js';
import {
    questionSuggestions, questionSuggestionsSchema,
} from './controllers/questionSuggestionController.js';
import { listConsultantJobs } from './controllers/consultantJobsController.js';
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
// What a run would ask the provider for, before spending anything on it.
app.get('/api/management/discovery/preview',
    [verifyToken, isOrgAdmin], previewQueries);
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

/* ────── JobsPipe real-time push (Phase 5b — parallel trial) ────── */
//
// A SECOND ingestion path, beside the scheduled cycle above and changing
// nothing about it. The cycle pulls on a heartbeat and pays per page; this is
// pushed to as jobs are published and costs nothing per job. Both feed the same
// pool through the same de-duplication, the same pre-filter and the same
// preparation gate — see controllers/jobspipeListener.js.
//
// ── WHY THE WEBHOOK IS NOT BEHIND verifyToken ────────────────────────
//
// It is the one write route in this API with no user and no cookie: JobsPipe is
// a server posting to a public URL. The per-agency shared secret in the header
// is the identity, and it decides BOTH admission and which tenant's pool the
// job lands in. That is why it sits outside the /api/management block rather
// than being given a weaker guard inside it.
//
// It keeps the standard /api rate limit — a push feed that suddenly sends 300
// deliveries a minute is a runaway sender or somebody else, and neither should
// be absorbed silently.
app.post('/api/webhooks/jobspipe', jobspipeWebhook);

// The operator surface. Reading the funnel is management, because a recruiter
// wondering why a queue is quiet should be able to see whether the feed is
// arriving. Everything that changes the credential or turns the feed on is
// ORG_ADMIN and audited, exactly as enabling a board is.
app.get('/api/management/jobspipe', [verifyToken, isManagement], getJobsPipeSettings);
app.get('/api/management/jobspipe/events', [verifyToken, isManagement], listJobsPipeEvents);
app.post('/api/management/jobspipe/token', [verifyToken, isOrgAdmin], rotateJobsPipeToken);
app.get('/api/management/jobspipe/token', [verifyToken, isOrgAdmin], revealJobsPipeToken);
app.patch('/api/management/jobspipe',
    [verifyToken, isOrgAdmin, validate(jobspipeEnabledSchema)], setJobsPipeEnabled);
app.post('/api/management/jobspipe/test', [verifyToken, isOrgAdmin], sendJobsPipeTest);

/* ────── JobsPipe PULL path (Phase 5c — the search API) ────────── */
//
// The third ingestion door, and the operator surface deliberately mirrors
// SerpApi's so the two read the same way on the Job Discovery screen:
//
//   SerpApi    POST /api/management/discovery/run
//   JobsPipe   POST /api/management/jobspipe/poll
//
// Both spend real money and both write into the same pool through the same
// fingerprint and matcher, so both are ORG_ADMIN and both are audited.
//
// `/poll/preview` is declared BEFORE `/poll` would shadow it, and is GET
// because it spends nothing: it answers "what would a run ask for" without
// buying the answer. On a 100-credit month that distinction is the difference
// between configuring this feed and paying to configure it.
app.get('/api/management/jobspipe/pull', [verifyToken, isManagement], getPullStatus);
app.get('/api/management/jobspipe/poll/preview', [verifyToken, isManagement], previewPoll);
app.post('/api/management/jobspipe/poll',
    [verifyToken, isOrgAdmin, validate(pollSchema)], runPollNow);
app.patch('/api/management/jobspipe/pull',
    [verifyToken, isOrgAdmin, validate(pullEnabledSchema)], setPullEnabled);

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
// Every job for one consultant, queued and submitted alike, on one screen.
// The consultant reaches the same view through /api/portal/jobs below.
app.get('/api/management/consultants/:id/jobs',
    [verifyToken, isManagement], listConsultantJobs);
app.get('/api/management/applications/:id', [verifyToken, isManagement], getApplication);

app.post('/api/management/queue/:id/cancel',
    [verifyToken, isOrgAdmin, validate(transitionSchema)], cancelItem);

/* ──────────── the fabrication review gate (Phase 7) ────────────── */
//
// A tailored resume whose independent check found a claim it could not trace
// back to the base resume stops here instead of going out.
//
// isManagement, not isOrgAdmin: a recruiter reviews their own consultants'
// resumes, narrowed inside the controller by canAccessConsultant — the same
// split profile changes and the answer bank already use.
//
// Approving is management's. The consultant gets the parallel portal routes
// below, where they can see every flag and REJECT, but not approve: the person
// whose name is on the document may refuse what was written under it, and the
// reviewer is somebody else, exactly as with every other approval here.

app.get('/api/management/resume-reviews', [verifyToken, isManagement], listReviews);
app.get('/api/management/resume-reviews/count', [verifyToken, isManagement], reviewCount);
app.get('/api/management/resume-reviews/:itemId', [verifyToken, isManagement], getReview);
app.post('/api/management/resume-reviews/:itemId/approve',
    [verifyToken, isManagement, validate(reviewDecisionSchema)], approveReview);
app.post('/api/management/resume-reviews/:itemId/reject',
    [verifyToken, isManagement, validate(reviewDecisionSchema)], rejectReview);
app.post('/api/management/resume-reviews/:itemId/retry',
    [verifyToken, isManagement, validate(reviewDecisionSchema)], retryReview);

/* ─────────────────────────── contacts ───────────────────────────── */
//
// Every read here writes an audit row, and there is deliberately no route that
// returns the whole store in one call — see controllers/contactController.js.
// `/usage` is declared before `/:id` so that "usage" is not read as an id.

// What the AI stage cost this month, and whether caching and the flag rate
// are where they should be. Read-only — the budget itself is an org setting.
app.get('/api/management/ai-usage', [verifyToken, isManagement], aiUsage);
// Whether the AI agent may fill forms, and its per-job limits. Anyone in
// management can read it; only an organisation admin can change it.
app.get('/api/management/ai-agent', [verifyToken, isManagement], getAgentSettings);
app.put('/api/management/ai-agent',
    [verifyToken, isOrgAdmin, validate(agentSettingsSchema)], updateAgentSettings);

app.get('/api/management/contacts', [verifyToken, isManagement], listContacts);
app.get('/api/management/contacts/usage', [verifyToken, isManagement], contactUsage);
app.post('/api/management/contacts/:id/do-not-contact',
    [verifyToken, isManagement, validate(dncSchema)], setDoNotContact);
app.get('/api/management/queue/:id/contacts', [verifyToken, isManagement], queueItemContacts);
app.get('/api/management/applications/:id/contacts',
    [verifyToken, isManagement], applicationContacts);
// The on-demand lookup: one job, one credit, for a recruiter who wants the
// contact before the application goes out rather than after it.
app.post('/api/management/queue/:id/find-contact',
    [verifyToken, isManagement], findContactNow);

/* ─────────────── consultant desktop app (device auth) ──────────── */
//
// A separate identity from the browser session: `verifyDevice` authenticates a
// MACHINE and yields exactly one consultant, so nothing here can reach another
// person's data or any management route. Activation is the only open route,
// and it trades a one-time code issued by the owner for a bound device token.

app.post('/api/device/activate', [validate(activateSchema)], activate);

app.get('/api/device/heartbeat', [verifyDevice], heartbeat);
app.get('/api/device/queue', [verifyDevice], deviceQueue);
// What this consultant has already applied to, so the app can show its own
// history rather than forgetting each application the moment it is submitted.
app.get('/api/device/applications', [verifyDevice], deviceApplications);

// Questions with an application waiting on them, answered where the job is.
// These need no second approval: a consultant answering about their own notice
// period, to send their own application, is not the case two-person review was
// written for — and waiting for it let jobs close. Profile changes still are.
app.get('/api/device/questions', [verifyDevice], deviceQuestions);
// The whole bank — what the app actually types into applications.
app.get('/api/device/answers', [verifyDevice], deviceAnswers);
app.post('/api/device/questions/:id/answer',
    [verifyDevice, validate(deviceAnswerSchema)], deviceAnswerQuestion);

// Every state change goes through the shared queue state machine, so the app
// cannot reach a state the portal would refuse.
app.post('/api/device/queue/:id/lease', [verifyDevice], leaseItem);
// Per job, never in bulk (spec §6) — the queue item is part of the path, and
// every delivery is audited with the device that asked.
app.get('/api/device/queue/:id/resume', [verifyDevice], deviceResume);
// Same rule as the resume: one job per call, audited with the device that
// asked. The device identity is a single consultant, so there is nothing wider
// this could reach.
app.get('/api/device/queue/:id/contacts', [verifyDevice], deviceQueueContacts);
app.post('/api/device/queue/:id/filled', [verifyDevice, validate(reportSchema)], reportFilled);
// Raise the questions a form asked WITHOUT giving the job up. The device
// calls this the moment it meets one it cannot answer, shows the consultant a
// countdown, and only calls `parked` below if nobody answers in time.
app.post('/api/device/queue/:id/questions', [verifyDevice, validate(reportSchema)], askQuestions);
app.post('/api/device/queue/:id/parked', [verifyDevice, validate(reportSchema)], reportParked);
app.post('/api/device/queue/:id/skipped', [verifyDevice, validate(reportSchema)], reportSkipped);
app.post('/api/device/queue/:id/reclassify', [verifyDevice, validate(reportSchema)], reclassify);

// The AI agent: fills an application when a coded recipe cannot. The loop runs
// on the device, where the signed-in browser is; every model call comes through
// here, where the key, the budget and the ledger are. See agentController.js.
app.post('/api/device/queue/:id/agent/start',
    [verifyDevice, validate(agentStartSchema)], agentStart);
app.post('/api/device/agent/runs/:runId/step',
    [verifyDevice, validate(agentStepSchema)], agentStep);
app.post('/api/device/agent/runs/:runId/finish',
    [verifyDevice, validate(agentFinishSchema)], agentFinish);
// Differently-worded questions that an existing approved answer may already
// cover. Suggestions only — nothing is answered until the consultant accepts.
app.post('/api/device/questions/suggestions',
    [verifyDevice, validate(questionSuggestionsSchema)], questionSuggestions);
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
// Shown again on demand, like a user's password. ORG_ADMIN only, and audited
// every time — reading a credential is an event somebody may need to account for.
app.get('/api/management/devices/:id/activation-code',
    [verifyToken, isOrgAdmin], revealActivationCode);
app.delete('/api/management/devices/:id', [verifyToken, isOrgAdmin], revokeDevice);

/* ─────────────────────── consultant portal ─────────────────────── */

app.get('/api/portal/me', [verifyToken, isConsultant], myProfile);
app.get('/api/portal/criteria', [verifyToken, isConsultant], getMyCriteria);
app.get('/api/portal/questions', [verifyToken, isConsultant], myQuestions);
app.get('/api/portal/answers/count', [verifyToken, isConsultant], myOutstandingCount);
app.post('/api/portal/answers',
    [verifyToken, isConsultant, validate(submitAnswerSchema)], submitAnswer);
app.get('/api/portal/dashboard', [verifyToken, isConsultant], myDashboard);
// The consultant's own jobs. Same handler and same payload management gets —
// the id is taken from the session, so there is nothing here to tamper with.
app.get('/api/portal/jobs', [verifyToken, isConsultant], listConsultantJobs);

// The consultant's own view of a flagged resume. Same payload the reviewer
// sees, minus the ability to approve it.
app.get('/api/portal/resume-reviews', [verifyToken, isConsultant], listReviews);
app.get('/api/portal/resume-reviews/count', [verifyToken, isConsultant], reviewCount);
app.get('/api/portal/resume-reviews/:itemId', [verifyToken, isConsultant], getReview);
app.post('/api/portal/resume-reviews/:itemId/reject',
    [verifyToken, isConsultant, validate(reviewDecisionSchema)], rejectReview);
// One application at a time, their own only. There is no portal route that
// lists the contact store — see controllers/contactController.js.
app.get('/api/portal/applications/:id/contacts',
    [verifyToken, isConsultant], applicationContacts);
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
    // The AI preparation and contact-discovery worker. Off unless
    // WORKER_ENABLED=true, so a fresh checkout never spends money on its own.
    startWorker();
    // The JobsPipe pull path. Off unless JOBSPIPE_POLL_ENABLED=true, for the
    // same reason: 1 credit = 1 request on a 100-a-month plan, so a server
    // that polls the moment it boots has spent somebody's allowance by lunch.
    startJobsPipePoller();

    app.listen(PORT, () => {
        console.log(`✅ API listening on http://localhost:${PORT}`);
        console.log(`   CORS allowlist: ${allowlist.join(', ') || '(none)'}`);
    });
};

start();
