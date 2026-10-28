/**
 * ── WHICH LANE A NEW QUEUE ITEM STARTS IN ─────────────────────────────
 *
 *   BOT    the portal has a coded recipe in the desktop app
 *   AGENT  it does not, so the AI agent reads the page and fills it
 *
 * Every job is applied to by the desktop app. There used to be a third lane,
 * HUMAN, for "the consultant applies by hand"; it is gone, because the
 * product's rule is that nothing is left for a consultant to apply to on their
 * own. A job nothing can finish is SKIPPED with the reason written on it, where
 * a recruiter can see it and put it back with Requeue.
 *
 * One function for both places items are created — the discovery run and the
 * JobsPipe listener — so the two can never disagree about where a job goes.
 *
 * An AGENT item is not a promise that the agent will finish it. The desktop
 * asks the hub before every run. While the organisation has the agent switched
 * off the item simply waits, untouched, and is picked up when it is switched
 * on; nothing is stranded and nothing is handed to a person.
 */
/**
 * @param orgId        the organisation the item belongs to
 * @param automatable  lkp_portal_types.is_automatable for the posting's portal
 */
// eslint-disable-next-line no-unused-vars
export const laneFor = async (orgId, automatable) => (automatable ? 'BOT' : 'AGENT');
