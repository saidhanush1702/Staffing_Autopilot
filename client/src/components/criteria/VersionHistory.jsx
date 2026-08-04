import { useState } from 'react';
import { History, Eye, RotateCcw, GitCompare, Loader2 } from 'lucide-react';
import api, { errorMessage } from '../../api/axios.js';
import Modal, { ModalActions } from '../ui/Modal.jsx';
import CriteriaView, { VersionByline, describeLocation, describePay } from './CriteriaView.jsx';
import {
    card, cardPad, sectionTitle, btnSm, badge, TONE, TONE_ALERT, tableHead,
    tableHeadCell, tableBody, tableRow, tableCell, tableEmpty,
} from '../../design/tokens.js';
import { useLookups } from '../../context/LookupContext.jsx';

/** Added / removed between two string lists, in one pass. */
const listDiff = (before, after) => ({
    added: after.filter((v) => !before.includes(v)),
    removed: before.filter((v) => !after.includes(v)),
});

const DiffRow = ({ label, before, after }) => {
    const { added, removed } = listDiff(before, after);
    const reordered = added.length === 0 && removed.length === 0
        && JSON.stringify(before) !== JSON.stringify(after);

    if (!added.length && !removed.length && !reordered) return null;

    return (
        <div className="py-2">
            <p className="text-xs uppercase tracking-wide text-slate-400">{label}</p>
            <div className="mt-1 flex flex-wrap gap-1.5">
                {added.map((v) => (
                    <span key={`a-${v}`} className={`${badge} ${TONE.success}`}>+ {v}</span>
                ))}
                {removed.map((v) => (
                    <span key={`r-${v}`} className={`${badge} ${TONE.danger}`}>− {v}</span>
                ))}
                {reordered && <span className={`${badge} ${TONE.warning}`}>reordered</span>}
            </div>
        </div>
    );
};

/**
 * Side-by-side comparison of two versions.
 *
 * Shows only what MOVED. A full dump of both versions side by side is more
 * information and less understanding — the question being asked here is
 * "what changed?", not "what does v2 contain?", which the viewer answers.
 */
const VersionDiff = ({ older, newer }) => {
    const { labelById } = useLookups();

    const payBefore = describePay(older.minPay);
    const payAfter = describePay(newer.minPay);
    const locBefore = older.locations.map(describeLocation);
    const locAfter = newer.locations.map(describeLocation);
    const wtBefore = older.workTypeIds.map((id) => labelById('workTypes', id));
    const wtAfter = newer.workTypeIds.map((id) => labelById('workTypes', id));

    const rows = [
        ['Job titles', older.jobTitles, newer.jobTitles],
        ['Include keywords', older.keywordsInclude, newer.keywordsInclude],
        ['Exclude keywords', older.keywordsExclude, newer.keywordsExclude],
        ['Excluded companies', older.excludedCompanies, newer.excludedCompanies],
        ['Locations', locBefore, locAfter],
        ['Work types', wtBefore, wtAfter],
    ];

    const anyListChanged = rows.some(([, b, a]) => JSON.stringify(b) !== JSON.stringify(a));
    const payChanged = payBefore !== payAfter;

    return (
        <div>
            <p className="mb-3 text-sm text-slate-600">
                What changed from <strong>v{older.versionNo}</strong> to <strong>v{newer.versionNo}</strong>:
            </p>

            {!anyListChanged && !payChanged && (
                <p className="text-sm text-slate-400">Nothing differs between these two versions.</p>
            )}

            <div className="divide-y divide-slate-100">
                {rows.map(([label, b, a]) => (
                    <DiffRow key={label} label={label} before={b} after={a} />
                ))}

                {payChanged && (
                    <div className="py-2">
                        <p className="text-xs uppercase tracking-wide text-slate-400">Minimum pay</p>
                        <p className="mt-1 text-sm">
                            <span className="text-danger-700 line-through">{payBefore ?? 'none'}</span>
                            {' → '}
                            <span className="text-success-700">{payAfter ?? 'none'}</span>
                        </p>
                    </div>
                )}
            </div>
        </div>
    );
};

/**
 * The audit trail of a criteria set: who changed it, when, and what moved.
 *
 * Restore copies a version FORWARD as a new one rather than rewinding the
 * pointer, so "we reverted to v2 on Tuesday" stays visible as v5 instead of
 * disappearing from the record.
 */
const VersionHistory = ({ consultantId, versions, currentVersion, canEdit, onRestored }) => {
    const [viewing, setViewing] = useState(null);      // expanded version object
    const [comparing, setComparing] = useState(null);  // expanded version object
    const [restoreTarget, setRestoreTarget] = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    const fetchVersion = async (versionId) => {
        const { data } = await api.get(
            `/management/consultants/${consultantId}/criteria/versions/${versionId}`,
        );
        return data.version;
    };

    const open = async (versionId, setter) => {
        setError('');
        try {
            setter(await fetchVersion(versionId));
        } catch (err) {
            setError(errorMessage(err, 'Could not load that version.'));
        }
    };

    const restore = async () => {
        setBusy(true);
        setError('');
        try {
            await api.post(
                `/management/consultants/${consultantId}/criteria/versions/${restoreTarget.id}/restore`,
                {},
            );
            setRestoreTarget(null);
            await onRestored();
        } catch (err) {
            setError(errorMessage(err, 'Could not restore that version.'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className={`${card} ${cardPad}`}>
            <h2 className={`flex items-center gap-2 ${sectionTitle}`}>
                <History className="h-4 w-4 text-slate-400" />
                Version history
            </h2>
            <p className="mt-1 text-xs text-slate-500">
                Every save creates a version. Nothing is ever overwritten, so
                “why did this job match?” stays answerable later.
            </p>

            {error && (
                <p className={`mt-3 rounded-lg p-2 text-xs ${TONE_ALERT.danger}`}>{error}</p>
            )}

            <div className="mt-3 overflow-x-auto">
                <table className="w-full text-sm" style={{ minWidth: 640 }}>
                    <thead className={tableHead}>
                        <tr>
                            <th className={tableHeadCell}>Version</th>
                            <th className={tableHeadCell}>Saved by</th>
                            <th className={tableHeadCell}>When</th>
                            <th className={tableHeadCell}>Contents</th>
                            <th className={tableHeadCell} />
                        </tr>
                    </thead>
                    <tbody className={tableBody}>
                        {versions.length === 0 && (
                            <tr><td colSpan={5} className={tableEmpty}>Nothing saved yet.</td></tr>
                        )}
                        {versions.map((v) => (
                            <tr key={v.id} className={tableRow}>
                                <td className={`${tableCell} whitespace-nowrap`}>
                                    <span className="font-medium text-slate-900">v{v.versionNo}</span>
                                    {v.isCurrent && (
                                        <span className={`ml-2 ${badge} ${TONE.success}`}>Current</span>
                                    )}
                                </td>
                                <td className={tableCell}>
                                    <p className="text-slate-800">{v.createdByName ?? 'Unknown'}</p>
                                    <p className="text-xs text-slate-400">{v.createdByRole}</p>
                                </td>
                                <td className={`${tableCell} whitespace-nowrap text-slate-500`}>
                                    {new Date(v.createdAt).toLocaleString()}
                                </td>
                                <td className={`${tableCell} text-xs text-slate-500`}>
                                    {v.titleCount} titles · {v.keywordCount} keywords · {v.locationCount} locations
                                    {v.changeNote && (
                                        <span className="block italic text-slate-400">“{v.changeNote}”</span>
                                    )}
                                </td>
                                <td className={`${tableCell} whitespace-nowrap text-right`}>
                                    <span className="flex flex-wrap justify-end gap-1.5">
                                        <button
                                            type="button" className={btnSm.secondary}
                                            onClick={() => open(v.id, setViewing)}
                                        >
                                            <Eye className="h-3.5 w-3.5" /> View
                                        </button>
                                        {!v.isCurrent && currentVersion?.id && (
                                            <button
                                                type="button" className={btnSm.secondary}
                                                onClick={() => open(v.id, setComparing)}
                                            >
                                                <GitCompare className="h-3.5 w-3.5" /> Compare
                                            </button>
                                        )}
                                        {!v.isCurrent && canEdit && (
                                            <button
                                                type="button" className={btnSm.caution}
                                                onClick={() => setRestoreTarget(v)}
                                            >
                                                <RotateCcw className="h-3.5 w-3.5" /> Restore
                                            </button>
                                        )}
                                    </span>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {viewing && (
                <Modal
                    size="lg"
                    title={`Version ${viewing.versionNo}`}
                    subtitle="Exactly as it was saved — read only."
                    onClose={() => setViewing(null)}
                >
                    <VersionByline version={viewing} />
                    <div className="mt-4">
                        <CriteriaView version={viewing} />
                    </div>
                </Modal>
            )}

            {comparing && currentVersion && (
                <Modal
                    size="lg"
                    title={`Compare v${comparing.versionNo} with the current v${currentVersion.versionNo}`}
                    onClose={() => setComparing(null)}
                >
                    <VersionDiff older={comparing} newer={currentVersion} />
                </Modal>
            )}

            {restoreTarget && (
                <Modal
                    size="sm"
                    tone="warning"
                    icon={RotateCcw}
                    title={`Restore version ${restoreTarget.versionNo}?`}
                    onClose={() => setRestoreTarget(null)}
                    footer={(
                        <ModalActions
                            onCancel={() => setRestoreTarget(null)}
                            onConfirm={restore}
                            confirmLabel="Restore as a new version"
                            variant="caution"
                            busy={busy}
                        />
                    )}
                >
                    <p className="text-sm text-slate-600">
                        Its contents become the criteria in force. The history is not rewound —
                        this is saved as a <strong>new</strong> version, so the record still shows
                        that you restored it today.
                    </p>
                    {error && (
                        <p className={`mt-3 rounded-lg p-2 text-xs ${TONE_ALERT.danger}`}>{error}</p>
                    )}
                </Modal>
            )}
        </div>
    );
};

export default VersionHistory;
