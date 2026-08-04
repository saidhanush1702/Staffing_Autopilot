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

/* ─────────────────────── consultant portal ─────────────────────── */

app.get('/api/portal/me', [verifyToken, isConsultant], myProfile);
app.get('/api/portal/criteria', [verifyToken, isConsultant], getMyCriteria);
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

    app.listen(PORT, () => {
        console.log(`✅ API listening on http://localhost:${PORT}`);
        console.log(`   CORS allowlist: ${allowlist.join(', ') || '(none)'}`);
    });
};

start();
