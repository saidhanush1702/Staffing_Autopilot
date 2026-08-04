import { useEffect, useState } from 'react';
import { Search, Lock, Pause, CheckCircle2 } from 'lucide-react';
import api, { errorMessage } from '../../api/axios.js';
import PageLoader from '../../components/PageLoader.jsx';
import CriteriaView, { VersionByline } from '../../components/criteria/CriteriaView.jsx';
import {
    card, cardPad, badge, TONE, TONE_ALERT, pageTitle, pageSubtitle, sectionTitle,
} from '../../design/tokens.js';

/**
 * The consultant's own search criteria — READ ONLY, always.
 *
 * There is no edit control here and no write endpoint behind one. R-23 makes
 * criteria a recruiter's decision: they are a judgement about how to spend the
 * application budget, not a fact about the consultant to assert. This page
 * exists so the consultant can SEE what is being searched for on their behalf
 * and raise it with their recruiter if it looks wrong.
 */
const MyCriteria = () => {
    const [data, setData] = useState(null);
    const [error, setError] = useState('');

    useEffect(() => {
        api.get('/portal/criteria')
            .then(({ data: d }) => setData(d))
            .catch((err) => setError(errorMessage(err)));
    }, []);

    if (error) return <p className="text-sm text-danger-700">{error}</p>;
    if (!data) return <PageLoader />;

    const { criteria, version } = data;

    return (
        <div>
            <h1 className={pageTitle}>My search criteria</h1>
            <p className={pageSubtitle}>
                What your recruiter is looking for on your behalf.
            </p>

            <div className={`mt-5 flex items-start gap-2 rounded-lg p-3 text-sm ${TONE_ALERT.info}`}>
                <Lock className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                    This is read-only. Your recruiter sets and maintains these criteria —
                    if something looks wrong, tell them and they will update it.
                </span>
            </div>

            <div className={`mt-5 ${card} ${cardPad}`}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <h2 className={`flex items-center gap-2 ${sectionTitle}`}>
                        <Search className="h-4 w-4 text-slate-400" /> Currently being searched
                    </h2>
                    {!criteria.configured ? (
                        <span className={`${badge} ${TONE.neutral}`}>Not set up yet</span>
                    ) : criteria.isActive ? (
                        <span className={`${badge} ${TONE.success}`}>
                            <CheckCircle2 className="h-3.5 w-3.5" /> Active
                        </span>
                    ) : (
                        <span className={`${badge} ${TONE.warning}`}>
                            <Pause className="h-3.5 w-3.5" /> Paused
                        </span>
                    )}
                </div>

                {!criteria.configured ? (
                    <p className="mt-4 text-sm text-slate-500">
                        Your recruiter has not set up your search criteria yet. Nothing is
                        being searched for until they do.
                    </p>
                ) : (
                    <>
                        {!criteria.isActive && (
                            <p className={`mt-3 rounded-lg p-2 text-xs ${TONE_ALERT.warning}`}>
                                Discovery is paused, so no new jobs are being found right now.
                                Your criteria are saved and will resume unchanged.
                            </p>
                        )}
                        <div className="mt-4">
                            <VersionByline version={version} />
                        </div>
                        <div className="mt-4">
                            <CriteriaView version={version} />
                        </div>
                    </>
                )}
            </div>
        </div>
    );
};

export default MyCriteria;
