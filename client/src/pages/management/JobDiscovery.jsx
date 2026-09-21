import { useState } from 'react';
import { Radar, Zap } from 'lucide-react';
import AuditLogPanel from '../../components/layout/AuditLogPanel.jsx';
import SchedulePanel from '../../components/discovery/SchedulePanel.jsx';
import SerpApiPullPanel from '../../components/discovery/SerpApiPullPanel.jsx';
import JobsPipePullPanel from '../../components/discovery/JobsPipePullPanel.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import {
    pageTitle, pageSubtitle, tabBar, tabNav, tabItem, tabActive, tabIdle,
} from '../../design/tokens.js';

/**
 * Job discovery — the operator screen.
 *
 * Three jobs: show whether each source is actually able to run, let boards be
 * accepted or rejected, and show what the last runs did.
 *
 * The per-stage counts matter more than they look. A run that queued nothing
 * because there was nothing new, a run that queued nothing because every board
 * is switched off, and a run that queued nothing because the API key expired
 * are indistinguishable from a success flag alone — these numbers are the only
 * way to tell them apart.
 *
 * One tab per ingestion door. Each has its own Run button, board list and run
 * history, billed against its own allowance — stacking both on one page read as
 * every section appearing twice. Both tabs are laid out the same way (see
 * SerpApiPullPanel), so moving between them changes the data and nothing else.
 */
const SOURCE_TABS = [
    { key: 'SERPAPI', label: 'SerpApi · Google Jobs', icon: Radar },
    { key: 'JOBSPIPE', label: 'JobsPipe', icon: Zap },
];

const JobDiscovery = () => {
    const { user } = useAuth();
    const isAdmin = user?.role === 'ORG_ADMIN';

    const [tab, setTab] = useState('SERPAPI');
    // Bumped when the scheduled cycle fires while this page is open, so the
    // SerpApi tab reloads its runs without a manual refresh.
    const [refreshKey, setRefreshKey] = useState(0);

    return (
        <div>
            <h1 className={pageTitle}>Job discovery</h1>
            <p className={pageSubtitle}>
                Finds postings through Google Jobs and works out which consultant
                each one suits.
            </p>

            <SchedulePanel canEdit={isAdmin} onCycleFired={() => setRefreshKey((k) => k + 1)} />

            {/* ── source tabs ────────────────────────────────────── */}
            <div className={`mt-8 ${tabBar}`}>
                <nav className={tabNav} aria-label="Discovery sources">
                    {SOURCE_TABS.map((t) => (
                        <button
                            key={t.key}
                            type="button"
                            onClick={() => setTab(t.key)}
                            aria-current={tab === t.key ? 'page' : undefined}
                            className={`${tabItem} ${tab === t.key ? tabActive : tabIdle}`}
                        >
                            <t.icon className="h-4 w-4" />
                            {t.label}
                        </button>
                    ))}
                </nav>
            </div>

            {tab === 'JOBSPIPE' && <JobsPipePullPanel canEdit={isAdmin} />}
            {tab === 'SERPAPI' && <SerpApiPullPanel canEdit={isAdmin} refreshKey={refreshKey} />}

            <AuditLogPanel module="discovery" />
        </div>
    );
};

export default JobDiscovery;
