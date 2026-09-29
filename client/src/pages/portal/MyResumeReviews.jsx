import ResumeReview from '../management/ResumeReview.jsx';

/**
 * The consultant's view of a flagged resume.
 *
 * ── WHY IT IS THE SAME COMPONENT ──────────────────────────────────────
 *
 * The screen a consultant needs is the screen a reviewer needs: the claims that
 * were flagged, in their own resume, next to the base resume they came from.
 * Building a second, simpler version would mean showing the person whose name
 * is on the application less than the person reviewing it — and would leave two
 * highlighters, two flag lists, and two chances for them to disagree about what
 * was flagged.
 *
 * What a consultant may DO is narrower, and that narrowing is enforced by the
 * server: `/api/portal/resume-reviews` scopes to their own items, and the
 * payload comes back with `canApprove: false`, so the approve button is absent
 * because the API said so. There is no portal route that approves; hiding a
 * button was never the control.
 */
const MyResumeReviews = () => <ResumeReview scope="portal" />;

export default MyResumeReviews;
