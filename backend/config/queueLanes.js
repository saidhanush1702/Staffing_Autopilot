/**
 * ── WHICH LANE A NEW QUEUE ITEM STARTS IN ─────────────────────────────
 *
 *   BOT    the portal has a coded recipe in the desktop app
 *   AGENT  it does not, and this organisation lets the AI agent try
 *   HUMAN  it does not, and nothing automated will try
 *
 * One function for both places items are created — the discovery run and the
 * JobsPipe listener — so the two can never disagree about where a job goes.
 *
 * An AGENT item is not a promise that the agent will finish it. The desktop
 * asks the hub before every run, and anything refused or left unfinished moves
 * to HUMAN through the same reclassify route a failed recipe uses. Switching
 * the agent off therefore strands nothing: the next time the app sees one of
 * these, it hands it straight over.
 */
import { query } from '../db.js';

/**
 * @param orgId        the organisation the item belongs to
 * @param automatable  lkp_portal_types.is_automatable for the posting's portal
 */
export const laneFor = async (orgId, automatable) => {
    if (automatable) return 'BOT';
    const { rows } = await query('SELECT agent_mode FROM organizations WHERE id = $1', [orgId]);
    const mode = rows[0]?.agent_mode ?? 'OFF';
    return mode === 'OFF' ? 'HUMAN' : 'AGENT';
};
