/**
 * Resume upload and download.
 *
 * Two rules carried from the build specification (§3.2, §6):
 *   1. ONE file per request. There is no bulk-download endpoint for any role.
 *   2. EVERY download is audited with actor, file, and IP.
 *
 * Uploading does not change the live profile. It creates an artifact and
 * returns its id; for a consultant that id then goes into a change request
 * like any other field, and only becomes the base resume on approval.
 */
import fs from 'node:fs';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../db.js';
import {
    sniffFileType, persistResume, resolveStoredPath, deleteStoredFile,
} from '../utils/upload.js';
import { canAccessConsultant } from '../utils/scope.js';
import { logAction } from './auditLogController.js';

const EXT_TO_MIME = {
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/**
 * Keep exactly one resume per consultant — delete every other base resume,
 * file and row.
 *
 * `keepIds` normally holds one id. It holds TWO only while a change request is
 * in flight: the live resume, plus the one the consultant proposed. Both must
 * survive until the reviewer decides, or approving would resolve to a file
 * that no longer exists.
 *
 * Called after every event that changes which resume is current:
 * upload, approve, reject, withdraw.
 */
export const pruneResumes = async (orgId, consultantId, keepIds = []) => {
    const keep = keepIds.filter(Boolean);

    const { rows } = await query(
        `SELECT id, stored_name, original_name
           FROM resume_artifacts
          WHERE organization_id = $1
            AND consultant_id   = $2
            AND kind = 'base'
            AND NOT (id = ANY($3::char(36)[]))`,
        [orgId, consultantId, keep.length ? keep : ['-']],
    );
    if (rows.length === 0) return 0;

    for (const r of rows) deleteStoredFile(orgId, r.stored_name);

    await query(
        'DELETE FROM resume_artifacts WHERE id = ANY($1::char(36)[])',
        [rows.map((r) => r.id)],
    );
    return rows.length;
};

/**
 * POST /api/resumes/upload      (consultant, own)
 * POST /api/management/consultants/:id/resume   (admin/recruiter)
 *
 * `consultantId` is resolved by the caller's role, never taken from the body.
 */
export const uploadResume = async (req, res, next) => {
    try {
        const { orgId } = req.user;
        const consultantId = req.user.role === 'CONSULTANT' ? req.user.id : req.params.id;

        if (req.user.role !== 'CONSULTANT'
            && !(await canAccessConsultant(req.user, consultantId))) {
            return res.status(403).json({ error: 'You do not have access to this consultant.' });
        }
        if (!req.file) {
            return res.status(422).json({ error: 'No file received. Attach a PDF, DOC or DOCX.' });
        }

        // Extension and MIME type are both client-supplied. Trust the bytes.
        const sniffed = sniffFileType(req.file.buffer);
        if (!sniffed) {
            return res.status(422).json({
                error: 'That file is not a valid PDF, DOC or DOCX. Renaming a file does not change its type.',
            });
        }

        // Name the file after the consultant so the uploads folder is readable.
        const { rows: whoRows } = await query(
            `SELECT u.name, p.base_resume_artifact_id AS current_id
               FROM users u
          LEFT JOIN consultant_profiles p ON p.user_id = u.id
              WHERE u.id = $1 AND u.organization_id = $2`,
            [consultantId, orgId],
        );
        const consultantName = whoRows[0]?.name;
        const currentId = whoRows[0]?.current_id ?? null;

        const artifactId = uuidv4();
        const { storedName, sha256 } = persistResume(
            orgId, req.file.buffer, sniffed, { consultantName, artifactId },
        );

        await query(
            `INSERT INTO resume_artifacts
                (id, organization_id, consultant_id, kind, original_name, stored_name,
                 mime_type, size_bytes, sha256, uploaded_by, created_by)
             VALUES ($1,$2,$3,'base',$4,$5,$6,$7,$8,$9,$9)`,
            [artifactId, orgId, consultantId, req.file.originalname, storedName,
                EXT_TO_MIME[sniffed], req.file.size, sha256, req.user.id],
        );

        // An admin upload takes effect immediately; a consultant upload has to
        // travel through the approval flow like any other proposed change.
        let applied = false;
        if (req.user.role !== 'CONSULTANT') {
            await query(
                `UPDATE consultant_profiles
                    SET base_resume_artifact_id = $1, updated_by = $2
                  WHERE user_id = $3 AND organization_id = $4`,
                [artifactId, req.user.id, consultantId, orgId],
            );
            applied = true;
        }

        // Any artifact a PENDING change request points at must survive, even
        // through an admin upload. Deleting it would leave the request
        // referencing a row that no longer exists, and approving it would then
        // fail on the foreign key.
        const { rows: pendingRows } = await query(
            `SELECT f.new_value
               FROM profile_change_request_fields f
               JOIN profile_change_requests c ON c.id = f.change_request_id
              WHERE c.consultant_id = $1
                AND c.status = 'PENDING'
                AND f.field_name = 'base_resume_artifact_id'
                AND f.new_value IS NOT NULL`,
            [consultantId],
        );
        const pendingIds = pendingRows.map((r) => r.new_value);

        // Only one resume survives, plus anything still awaiting review.
        // An admin upload replaces the live one outright; a consultant upload
        // keeps the live one until their proposal is reviewed.
        const removed = await pruneResumes(
            orgId, consultantId,
            [...(applied ? [artifactId] : [currentId, artifactId]), ...pendingIds],
        );

        logAction({
            orgId, module: 'resumes', action: 'Added Resume',
            entityType: 'ResumeArtifact', entityId: artifactId,
            entityName: req.file.originalname,
            performedBy: req.user.id, performedByRole: req.user.role,
            description: applied
                ? `Uploaded base resume "${req.file.originalname}"${removed ? ` (replaced ${removed} earlier file)` : ''}`
                : `Uploaded resume "${req.file.originalname}" pending approval`,
            ipAddress: req.ip,
        }).catch(() => {});

        return res.status(201).json({
            message: applied
                ? 'Resume uploaded.'
                : 'Resume uploaded. Submit your profile changes to send it for approval.',
            artifactId,
            originalName: req.file.originalname,
            sizeBytes: req.file.size,
            applied,
        });
    } catch (err) {
        return next(err);
    }
};

/**
 * GET /api/resumes/:artifactId/download
 * One file per request. Every call is audited.
 */
export const downloadResume = async (req, res, next) => {
    try {
        const { orgId } = req.user;

        const { rows } = await query(
            `SELECT r.*, u.name AS consultant_name
               FROM resume_artifacts r
               JOIN users u ON u.id = r.consultant_id
              WHERE r.id = $1 AND r.organization_id = $2`,
            [req.params.artifactId, orgId],
        );
        const artifact = rows[0];
        if (!artifact) return res.status(404).json({ error: 'Resume not found.' });

        const allowed = req.user.role === 'CONSULTANT'
            ? artifact.consultant_id === req.user.id
            : await canAccessConsultant(req.user, artifact.consultant_id);
        if (!allowed) {
            return res.status(403).json({ error: 'You do not have access to this resume.' });
        }

        const absolutePath = resolveStoredPath(orgId, artifact.stored_name);
        if (!fs.existsSync(absolutePath)) {
            return res.status(410).json({ error: 'The stored file is missing from disk.' });
        }

        logAction({
            orgId, module: 'resumes', action: 'Sent Resume',
            entityType: 'ResumeArtifact', entityId: artifact.id,
            entityName: artifact.original_name,
            performedBy: req.user.id, performedByRole: req.user.role,
            description: `Downloaded resume "${artifact.original_name}" of ${artifact.consultant_name}`,
            ipAddress: req.ip,
        }).catch(() => {});

        // ?disposition=inline renders in an <iframe> preview instead of
        // triggering a download. Same authorisation, same audit row — only the
        // response headers differ.
        const inline = req.query.disposition === 'inline';

        res.setHeader('Content-Type', artifact.mime_type);
        res.setHeader('Content-Disposition',
            `${inline ? 'inline' : 'attachment'}; filename="${artifact.original_name.replace(/"/g, '')}"`);
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

        if (inline) {
            // helmet defaults block framing entirely: X-Frame-Options SAMEORIGIN
            // plus frame-ancestors 'self'. The client runs on a different PORT,
            // which makes it a different ORIGIN, so both refuse and the browser
            // shows "localhost refused to connect".
            //
            // X-Frame-Options has no per-origin form browsers still honour
            // (ALLOW-FROM is dead), so drop it and let CSP decide — that one
            // does take an explicit origin list.
            //
            // Relaxed for THIS response only. Every other route keeps the
            // full helmet defaults.
            const allowed = (process.env.CLIENT_ORIGIN ?? '')
                .split(',').map((o) => o.trim()).filter(Boolean).join(' ');

            res.removeHeader('X-Frame-Options');
            res.setHeader(
                'Content-Security-Policy',
                `frame-ancestors 'self' ${allowed}`.trim(),
            );
        }

        return fs.createReadStream(absolutePath).pipe(res);
    } catch (err) {
        return next(err);
    }
};

/** GET /api/management/consultants/:id/resumes — history for one consultant. */
export const listResumes = async (req, res, next) => {
    try {
        if (!(await canAccessConsultant(req.user, req.params.id))) {
            return res.status(403).json({ error: 'You do not have access to this consultant.' });
        }
        const { rows } = await query(
            `SELECT r.id, r.original_name, r.size_bytes, r.mime_type, r.created_at,
                    up.name AS uploaded_by_name,
                    (p.base_resume_artifact_id = r.id) AS is_current
               FROM resume_artifacts r
          LEFT JOIN users up ON up.id = r.uploaded_by
          LEFT JOIN consultant_profiles p ON p.user_id = r.consultant_id
              WHERE r.consultant_id = $1 AND r.organization_id = $2 AND r.kind = 'base'
              ORDER BY r.created_at DESC`,
            [req.params.id, req.user.orgId],
        );
        return res.json({ resumes: rows });
    } catch (err) {
        return next(err);
    }
};
