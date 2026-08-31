/**
 * ── HANDLER REGISTRATION ──────────────────────────────────────────────
 *
 * Importing this file is what teaches the worker which job kinds it can run.
 *
 * ── WHY THIS FILE EXISTS AT ALL ───────────────────────────────────────
 *
 * The worker looks handlers up by `kind`, a plain string on the job row. That
 * keeps adding a handler down to adding a file — but it also means a handler
 * nobody imported simply does not exist as far as the worker is concerned. The
 * failure is quiet and misleading: jobs are claimed, find no handler, and
 * dead-letter one by one, which reads on a dashboard as a broken pipeline
 * rather than as a missing import.
 *
 * So there is exactly one place that does the importing, server.js imports it
 * once, and a new handler is registered here in the same commit that writes it.
 */
import { registerHandler } from '../worker.js';
import * as tailorResume from './tailorResume.js';
import * as discoverContact from './discoverContact.js';

registerHandler(tailorResume.KIND, tailorResume.handle);
registerHandler(discoverContact.KIND, discoverContact.handle);

export const HANDLER_KINDS = [tailorResume.KIND, discoverContact.KIND];
