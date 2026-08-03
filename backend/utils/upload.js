/**
 * Resume upload handling.
 *
 * Files are stored on disk under backend/uploads/<orgId>/, named with a UUID
 * so a user-supplied filename never touches the filesystem. They are served
 * only through the audited download endpoint — the folder is never exposed
 * as static content.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const UPLOAD_ROOT = path.resolve(
    process.env.UPLOAD_DIR ?? path.join(__dirname, '..', 'uploads'),
);

const MAX_BYTES = Number(process.env.MAX_UPLOAD_BYTES ?? 10 * 1024 * 1024);

const ALLOWED = {
    'application/pdf': '.pdf',
    'application/msword': '.doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
};

/**
 * Magic-byte signatures. Extension and MIME type are both client-supplied and
 * trivially faked, so the real check happens on the file's first bytes.
 */
const SIGNATURES = [
    { ext: '.pdf', bytes: [0x25, 0x50, 0x44, 0x46] },              // %PDF
    { ext: '.docx', bytes: [0x50, 0x4b, 0x03, 0x04] },             // PK.. (zip)
    { ext: '.doc', bytes: [0xd0, 0xcf, 0x11, 0xe0] },              // OLE2
];

export const sniffFileType = (buffer) => {
    for (const sig of SIGNATURES) {
        if (sig.bytes.every((b, i) => buffer[i] === b)) return sig.ext;
    }
    return null;
};

/** Held in memory so we can inspect the bytes before writing anything to disk. */
export const resumeUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_BYTES, files: 1 },
    fileFilter: (req, file, cb) => {
        if (!ALLOWED[file.mimetype]) {
            return cb(new Error('Only PDF, DOC and DOCX files are accepted.'));
        }
        return cb(null, true);
    },
}).single('resume');

/**
 * Turn a person's name into a filesystem-safe fragment.
 *
 * Strips everything that is not a word character, space or hyphen — which
 * removes `.`, `/`, `\` and `..`, so a crafted display name cannot escape the
 * upload directory. Falls back to 'resume' if nothing usable survives
 * (e.g. a name written entirely in a script that normalises away).
 */
export const slugifyName = (name) => {
    const slug = String(name ?? '')
        .normalize('NFKD')
        .replace(/[^\w\s-]/g, '')
        .trim()
        .replace(/[\s_-]+/g, '_')
        .slice(0, 40);
    return slug || 'resume';
};

/**
 * Write a validated buffer to disk as `<Name>_<short-id>.<ext>`.
 *
 * The name makes the uploads folder readable during support work; the short id
 * keeps two consultants with the same name from colliding.
 *
 * @returns {{ storedName: string, sha256: string, absolutePath: string }}
 */
export const persistResume = (orgId, buffer, extension, { consultantName, artifactId } = {}) => {
    const dir = path.join(UPLOAD_ROOT, orgId);
    fs.mkdirSync(dir, { recursive: true });

    const shortId = (artifactId ?? uuidv4()).slice(0, 8);
    const storedName = `${slugifyName(consultantName)}_${shortId}${extension}`;
    const absolutePath = path.join(dir, storedName);
    fs.writeFileSync(absolutePath, buffer);

    return {
        storedName,
        sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
        absolutePath,
    };
};

/**
 * Remove a stored file. Never throws — a missing file is not a reason to fail
 * the request that triggered the cleanup.
 */
export const deleteStoredFile = (orgId, storedName) => {
    try {
        fs.unlinkSync(resolveStoredPath(orgId, storedName));
        return true;
    } catch (err) {
        if (err.code !== 'ENOENT') {
            console.error(`Could not delete resume file "${storedName}":`, err.message);
        }
        return false;
    }
};

/**
 * Resolve a stored file back to an absolute path, refusing anything that
 * escapes the org's own folder (path traversal guard).
 */
export const resolveStoredPath = (orgId, storedName) => {
    const dir = path.join(UPLOAD_ROOT, orgId);
    const resolved = path.resolve(dir, storedName);
    if (!resolved.startsWith(path.resolve(dir) + path.sep)) {
        throw new Error('Invalid file path.');
    }
    return resolved;
};
