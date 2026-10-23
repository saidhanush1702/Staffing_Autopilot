import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Gauge, Building2, Radio, Activity } from 'lucide-react';
import api, { errorMessage } from '../../api/axios.js';
import PageLoader from '../../components/PageLoader.jsx';
import Alert from '../../components/ui/Alert.jsx';
import AtsOverview from '../../components/ats/AtsOverview.jsx';
import AtsBoards from '../../components/ats/AtsBoards.jsx';
import AtsFeed from '../../components/ats/AtsFeed.jsx';
import AtsActivity from '../../components/ats/AtsActivity.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import {
    pageTitle, pageSubtitle, tabBar, tabNav, tabItem, tabActive, tabIdle,
} from '../../design/tokens.js';

const TABS = [
    { key: 'overview', label: 'Overview', icon: Gauge },
    { key: 'boards', label: 'Employer boards', icon: Building2 },
    { key: 'feed', label: 'Live feed', icon: Radio },
    { key: 'activity', label: 'Activity', icon: Activity },
];

/**
 * Live Mirror — jobs read straight from employers' own career systems.
 *
 * ── HOW THIS DIFFERS FROM THE OTHER SOURCING SCREENS ──────────────────
 *
 * Job Discovery and JobsPipe both ASK a third party what jobs exist and pay for
 * the answer. This screen is about a different arrangement: a list of employers,
 * each read directly and for free, over and over, noticing what is new.
 *
 * So the questions it answers are different too. Not "how many credits are
 * left", but:
 *   · how long after an employer publishes a job do we notice it?   (Overview)
 *   · which employers are we watching, and are they healthy?        (Boards)
 *   · what did we just notice?                                      (Live feed)
 *   · what did every read actually do?                              (Activity)
 *
 * It sits beside the other two sources rather than inside either, because they
 * are independent doors with separate settings and separate failure modes, and
 * one screen showing all three would hide which of them a quiet queue is the
 * fault of.
 */
const AtsMirror = () => {
    const { user } = useAuth();
    const isAdmin = user?.role === 'ORG_ADMIN';
    const [params, setParams] = useSearchParams();
    const tab = TABS.some((t) => t.key === params.get('tab')) ? params.get('tab') : 'overview';

    const [data, setData] = useState(null);
    const [error, setError] = useState('');

    const load = useCallback(async () => {
        try {
            const { data: d } = await api.get('/management/ats');
            setData(d);
            setError('');
        } catch (err) {
            setError(errorMessage(err));
        }
    }, []);

    useEffect(() => {
        load();
        const id = setInterval(load, 30_000);
        return () => clearInterval(id);
    }, [load]);

    const go = (key) => setParams(key === 'overview' ? {} : { tab: key }, { replace: true });

    if (error && !data) return <Alert tone="danger">{error}</Alert>;
    if (!data) return <PageLoader />;

    return (
        <div>
            <h1 className={pageTitle}>Live mirror</h1>
            <p className={pageSubtitle}>
                Jobs read straight from employers&apos; own career systems — Greenhouse, Lever, Ashby, Workday and
                SmartRecruiters — minutes after they are published. Free to run, and it feeds the same
                de-duplication and matching as every other source.
            </p>

            <div className={`mt-6 ${tabBar}`}>
                <nav className={tabNav} aria-label="Live mirror sections">
                    {TABS.map((t) => (
                        <button
                            key={t.key} type="button" onClick={() => go(t.key)}
                            aria-current={tab === t.key ? 'page' : undefined}
                            className={`${tabItem} ${tab === t.key ? tabActive : tabIdle}`}
                        >
                            <t.icon className="h-4 w-4" />
                            {t.label}
                        </button>
                    ))}
                </nav>
            </div>

            <div className="mt-6">
                {tab === 'overview' && (
                    <AtsOverview data={data} isAdmin={isAdmin} onChanged={load} goToBoards={() => go('boards')} />
                )}
                {tab === 'boards' && <AtsBoards isAdmin={isAdmin} families={data.families} onChanged={load} />}
                {tab === 'feed' && <AtsFeed />}
                {tab === 'activity' && <AtsActivity />}
            </div>
        </div>
    );
};

export default AtsMirror;
