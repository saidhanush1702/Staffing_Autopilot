import { useState } from 'react';
import { ClipboardCheck, MessageSquare } from 'lucide-react';
import ProfileApprovals from './ProfileApprovals.jsx';
import AnswerInbox from './AnswerInbox.jsx';
import { pageTitle, pageSubtitle, tabBar, tabNav, tabItem, tabActive, tabIdle } from '../../design/tokens.js';

/**
 * ── ONE REVIEW DESTINATION, TWO QUEUES ─────────────────────────────────
 *
 * Profile changes and answer approvals used to be two sidebar items (plus a
 * third, resume review, now dropped from navigation — see App.jsx). Both are
 * "things waiting on this reviewer", so they are now one destination with two
 * sections, the same shape Job Discovery already uses for its two sources.
 *
 * Each section is still its own component with its own state, its own load()
 * and its own internal status tabs (Pending/Approved/... for profile changes,
 * whatever AnswerInbox already had) — nothing about either flow changed, only
 * where the top-level page title lives.
 */
const SECTION_TABS = [
    { key: 'PROFILE', label: 'Approvals', icon: ClipboardCheck },
    { key: 'ANSWERS', label: 'Answer approvals', icon: MessageSquare },
];

const Approvals = ({ initialSection = 'PROFILE' }) => {
    const [section, setSection] = useState(initialSection);

    return (
        <div>
            <h1 className={pageTitle}>Approvals</h1>
            <p className={pageSubtitle}>
                Everything waiting on you as a reviewer — profile changes and
                answers. Each is decided the same way: read it, then approve or reject.
            </p>

            <div className={`mt-8 ${tabBar}`}>
                <nav className={tabNav} aria-label="Approval queues">
                    {SECTION_TABS.map((t) => (
                        <button
                            key={t.key}
                            type="button"
                            onClick={() => setSection(t.key)}
                            aria-current={section === t.key ? 'page' : undefined}
                            className={`${tabItem} ${section === t.key ? tabActive : tabIdle}`}
                        >
                            <t.icon className="h-4 w-4" />
                            {t.label}
                        </button>
                    ))}
                </nav>
            </div>

            <div className="mt-6">
                {section === 'PROFILE' && <ProfileApprovals />}
                {section === 'ANSWERS' && <AnswerInbox />}
            </div>
        </div>
    );
};

export default Approvals;
