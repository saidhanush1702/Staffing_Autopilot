import ConsultantJobs from '../../components/queue/ConsultantJobs.jsx';
import { pageTitle, pageSubtitle } from '../../design/tokens.js';

/**
 * The consultant's own pipeline.
 *
 * ── WHY THEY GET THE SAME SCREEN AS THEIR RECRUITER ───────────────────
 *
 * Until now a consultant could see a dashboard summary and nothing else: no
 * route existed for them to look at the jobs matched to them, what stage any of
 * them had reached, or whether an application had actually gone out. The people
 * whose names are on these applications were the only people who could not see
 * them.
 *
 * It is the same question a recruiter asks, so it is the same screen. The
 * server pins the consultant id to the session — the portal route has no id
 * segment to pass — and the only thing withheld is the management action
 * drawer, because looking at your own pipeline and re-queueing yourself are
 * different things.
 */
const MyJobs = () => (
    <div className="mx-auto max-w-5xl">
        <h1 className={pageTitle}>My jobs</h1>
        <p className={pageSubtitle}>
            Every job matched to you, what stage it has reached, and what was sent.
            Jobs are ready with your base resume — tick the ones you want a tailored resume for.
        </p>

        <div className="mt-6">
            <ConsultantJobs scope="portal" />
        </div>
    </div>
);

export default MyJobs;
