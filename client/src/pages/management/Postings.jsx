import { useEffect, useState } from 'react';
import {
    Briefcase, Search, ExternalLink, Users, Eye, MapPin, Repeat, Clock,
} from 'lucide-react';
import api, { errorMessage } from '../../api/axios.js';
import PageLoader from '../../components/PageLoader.jsx';
import TableShell from '../../components/TableShell.jsx';
import Modal from '../../components/ui/Modal.jsx';
import {
    inputBase, badge, btnSm, sectionTitle, TONE, pageTitle, pageSubtitle,
    tableHead, tableHeadCell, tableBody, tableRow, tableCell, tableEmpty,
} from '../../design/tokens.js';

/**
 * How old the posting is, in the shortest form that is still honest.
 *
 * This is the column the JobsPipe trial exists to make visible: the whole
 * complaint that started it was that SerpApi returns roles that were published
 * a fortnight ago, and until now nothing on this screen said so — `posted_at`
 * was fetched and thrown away.
 *
 * Null is left as "not stated" rather than filled in with `first_seen_at`.
 * When we SAW a job is not when it was PUBLISHED, and quietly substituting one
 * for the other would make every board look equally fresh, which is precisely
 * the comparison this column is here to support.
 */
const postedAge = (iso) => {
    if (!iso) return null;
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return null;

    const hours = (Date.now() - then) / 3_600_000;
    // A future date means the board sent a deadline rather than a publication
    // date — measured at 44% of one JobsPipe page. Say so instead of rendering
    // a negative age.
    if (hours < 0) return { text: 'future-dated', tone: 'warning', hours };
    if (hours < 1) return { text: `${Math.max(1, Math.round(hours * 60))}m ago`, tone: 'success', hours };
    if (hours < 24) return { text: `${Math.round(hours)}h ago`, tone: 'success', hours };

    const days = Math.round(hours / 24);
    if (days <= 3) return { text: `${days}d ago`, tone: 'info', hours };
    if (days <= 14) return { text: `${days}d ago`, tone: 'neutral', hours };
    return { text: `${days}d ago`, tone: 'warning', hours };
};

/**
 * Which door this posting came through, and which run — when there was one.
 *
 * A JobsPipe posting has no `discovery_runs` row BY DESIGN: the webhook and the
 * poller both write `run_id = NULL` so they cannot race the scheduler's
 * one-open-run constraint. So a missing run here is not missing data, and
 * rendering it as "—" would read as a fault. It gets named for what it is.
 */
const originOf = (p) => {
    if (p.run_no) {
        return {
            label: `Run #${p.run_no}`,
            title: `${p.run_trigger === 'MANUAL' ? 'Manual' : 'Scheduled'} discovery run`
                + (p.run_started_at ? ` · ${new Date(p.run_started_at).toLocaleString()}` : ''),
        };
    }
    if (p.source_name === 'JOBSPIPE') {
        return { label: 'pushed / polled', title: 'JobsPipe writes no discovery run by design' };
    }
    return { label: null, title: null };
};

/** "USD 60–75 / hour", or nothing if the board did not say. */
const payText = (p) => {
    if (p.pay_min == null && p.pay_max == null) return null;
    const range = p.pay_min && p.pay_max && p.pay_min !== p.pay_max
        ? `${Number(p.pay_min).toLocaleString()}–${Number(p.pay_max).toLocaleString()}`
        : Number(p.pay_max ?? p.pay_min).toLocaleString();
    return `${p.pay_currency ?? 'USD'} ${range} / ${p.pay_unit === 'HOURLY' ? 'hour' : 'year'}`;
};

/**
 * The posting pool — everything discovery has found.
 *
 * The two columns that earn their place are **Seen** and **Matched**: a posting
 * seen five times across three boards is one row here rather than five, which
 * is R-15 working, and the match count answers "did this job suit anybody?"
 * without opening it.
 */
const Postings = () => {
    const [postings, setPostings] = useState(null);
    const [search, setSearch] = useState('');
    const [error, setError] = useState('');
    const [detail, setDetail] = useState(null);
    const [loadingDetail, setLoadingDetail] = useState(false);

    const load = async (term = '') => {
        try {
            const { data } = await api.get('/management/postings', {
                params: { search: term || undefined, limit: 100 },
            });
            setPostings(data.postings);
        } catch (err) {
            setError(errorMessage(err));
        }
    };

    useEffect(() => { load(); }, []);

    const open = async (id) => {
        setLoadingDetail(true);
        try {
            const { data } = await api.get(`/management/postings/${id}`);
            setDetail(data);
        } catch (err) {
            setError(errorMessage(err, 'Could not open that posting.'));
        } finally {
            setLoadingDetail(false);
        }
    };

    if (error) return <p className="text-sm text-danger-700">{error}</p>;
    if (!postings) return <PageLoader />;

    return (
        <div>
            <h1 className={pageTitle}>Job postings</h1>
            <p className={pageSubtitle}>
                Everything discovery has found. One row per job — a posting seen on
                several boards is de-duplicated, not repeated.
            </p>

            <form
                onSubmit={(e) => { e.preventDefault(); load(search); }}
                className="mt-5 flex gap-2"
            >
                <div className="relative flex-1">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                    <input
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Search company or title…"
                        className={`${inputBase} pl-9`}
                    />
                </div>
                <button type="submit" className={btnSm.secondary}>Search</button>
            </form>

            <TableShell className="mt-4" minWidth={1060}>
                <thead className={tableHead}>
                    <tr>
                        <th className={tableHeadCell}>Job</th>
                        <th className={tableHeadCell}>Location</th>
                        <th className={tableHeadCell}>Pay</th>
                        <th className={tableHeadCell}>Posted</th>
                        <th className={tableHeadCell}>Source &amp; run</th>
                        <th className={tableHeadCell}>Seen</th>
                        <th className={tableHeadCell}>Matched</th>
                        <th className={tableHeadCell} />
                    </tr>
                </thead>
                <tbody className={tableBody}>
                    {postings.length === 0 && (
                        <tr>
                            <td colSpan={8} className="px-4 py-12 text-center">
                                <Briefcase className="mx-auto h-8 w-8 text-slate-300" />
                                <p className="mt-2 text-sm text-slate-500">
                                    {search ? 'No postings match that.' : 'No postings found yet.'}
                                </p>
                                {!search && (
                                    <p className="mt-1 text-xs text-slate-400">
                                        Enable a board on the Job discovery page and run it.
                                    </p>
                                )}
                            </td>
                        </tr>
                    )}

                    {postings.map((p) => (
                        <tr key={p.id} className={tableRow}>
                            <td className={tableCell}>
                                <p className="font-medium text-slate-900">{p.title}</p>
                                <p className="text-xs text-slate-500">{p.company}</p>
                            </td>
                            <td className={`${tableCell} text-slate-600`}>
                                <span className="flex items-center gap-1.5">
                                    {p.is_remote
                                        ? <span className={`${badge} ${TONE.info}`}>Remote</span>
                                        : <><MapPin className="h-3.5 w-3.5 text-slate-400" />{p.location_text ?? '—'}</>}
                                </span>
                            </td>
                            <td className={`${tableCell} whitespace-nowrap text-slate-600`}>
                                {payText(p) ?? <span className="text-slate-300">not stated</span>}
                            </td>
                            <td className={`${tableCell} whitespace-nowrap`}>
                                {(() => {
                                    const age = postedAge(p.posted_at);
                                    if (!age) {
                                        return <span className="text-xs text-slate-300">not stated</span>;
                                    }
                                    return (
                                        <span
                                            className={`${badge} ${TONE[age.tone]}`}
                                            title={new Date(p.posted_at).toLocaleString()}
                                        >
                                            <Clock className="h-3 w-3" />
                                            {age.text}
                                        </span>
                                    );
                                })()}
                            </td>
                            <td className={`${tableCell} whitespace-nowrap`}>
                                {(() => {
                                    const origin = originOf(p);
                                    return (
                                        <>
                                            <span className={`${badge} ${
                                                p.source_name === 'JOBSPIPE' ? TONE.brand : TONE.neutral}`}
                                            >
                                                {p.source_name === 'JOBSPIPE' ? 'JobsPipe' : (p.source_label ?? '—')}
                                            </span>
                                            {/*
                                              The BOARD, beside the door that delivered it.
                                              SerpApi needs no such pairing — its board IS the
                                              source row — but every JobsPipe posting shares one
                                              source row, so without this a LinkedIn job and an
                                              Indeed job are indistinguishable on this screen.
                                            */}
                                            {p.origin_board && (
                                                <span
                                                    className={`${badge} ${TONE.info} ml-1`}
                                                    title={`Listed on ${p.origin_board}`}
                                                >
                                                    {p.origin_board}
                                                </span>
                                            )}
                                            {origin.label && (
                                                <span
                                                    className="mt-0.5 block text-xs text-slate-400"
                                                    title={origin.title ?? undefined}
                                                >
                                                    {origin.label}
                                                </span>
                                            )}
                                        </>
                                    );
                                })()}
                            </td>
                            <td className={tableCell}>
                                <span className="flex items-center gap-1 text-xs text-slate-500">
                                    <Repeat className="h-3.5 w-3.5" /> {p.times_seen}×
                                </span>
                            </td>
                            <td className={tableCell}>
                                {p.match_count > 0 ? (
                                    <span className={`${badge} ${p.queued_count > 0 ? TONE.success : TONE.warning}`}>
                                        <Users className="h-3 w-3" />
                                        {p.match_count} matched
                                        {p.queued_count > 0 && ` · ${p.queued_count} queued`}
                                    </span>
                                ) : (
                                    <span className="text-xs text-slate-400">nobody</span>
                                )}
                            </td>
                            <td className={`${tableCell} text-right`}>
                                <button type="button" onClick={() => open(p.id)} className={btnSm.secondary}>
                                    <Eye className="h-3.5 w-3.5" /> Open
                                </button>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </TableShell>

            {(detail || loadingDetail) && (
                <Modal
                    size="lg"
                    title={detail?.posting?.title ?? 'Loading…'}
                    subtitle={detail?.posting?.company}
                    onClose={() => setDetail(null)}
                >
                    {!detail ? <PageLoader /> : (
                        <>
                            <div className="flex flex-wrap gap-2">
                                {detail.posting.is_remote && (
                                    <span className={`${badge} ${TONE.info}`}>Remote</span>
                                )}
                                {detail.posting.location_text && (
                                    <span className={`${badge} ${TONE.neutral}`}>{detail.posting.location_text}</span>
                                )}
                                {detail.posting.work_type_label && (
                                    <span className={`${badge} ${TONE.brand}`}>{detail.posting.work_type_label}</span>
                                )}
                                {payText(detail.posting) && (
                                    <span className={`${badge} ${TONE.success}`}>{payText(detail.posting)}</span>
                                )}
                            </div>

                            <a
                                href={detail.posting.source_url}
                                target="_blank" rel="noreferrer"
                                className="mt-3 inline-flex items-center gap-1.5 text-sm text-brand-700 hover:underline"
                            >
                                <ExternalLink className="h-4 w-4" /> Open on the job board
                            </a>

                            {/* Who this job is useful for — the whole point of the phase. */}
                            <h3 className={`mt-5 ${sectionTitle}`}>
                                Useful for ({detail.matches.length})
                            </h3>
                            {detail.matches.length === 0 ? (
                                <p className="mt-1 text-sm text-slate-400">
                                    No consultant's criteria matched this posting.
                                </p>
                            ) : (
                                <div className="mt-2 space-y-2">
                                    {detail.matches.map((m) => (
                                        <div key={m.consultant_id} className="rounded-lg border border-line p-3">
                                            <div className="flex flex-wrap items-center justify-between gap-2">
                                                <p className="text-sm font-medium text-slate-900">
                                                    {m.consultant_name}
                                                </p>
                                                <span className="flex items-center gap-1.5">
                                                    <span className={`${badge} ${m.score >= 70 ? TONE.success : TONE.warning}`}>
                                                        score {m.score}
                                                    </span>
                                                    <span className={`${badge} ${TONE.neutral}`}>{m.status}</span>
                                                </span>
                                            </div>
                                            <p className="mt-1 text-xs text-slate-600">{m.reason}</p>
                                            {m.criteria_version_no && (
                                                <p className="mt-1 text-xs text-slate-400">
                                                    Matched against criteria v{m.criteria_version_no}
                                                </p>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            )}

                            <h3 className={`mt-5 ${sectionTitle}`}>
                                Seen {detail.posting.times_seen}× ({detail.sightings.length} recorded)
                            </h3>
                            <ul className="mt-2 space-y-1">
                                {detail.sightings.map((s, i) => (
                                    <li key={i} className="text-xs text-slate-500">
                                        {new Date(s.seen_at).toLocaleString()} · {s.source_label}
                                    </li>
                                ))}
                            </ul>

                            {detail.posting.description && (
                                <>
                                    <h3 className={`mt-5 ${sectionTitle}`}>Description</h3>
                                    <p className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-sm text-slate-700">
                                        {detail.posting.description}
                                    </p>
                                </>
                            )}
                        </>
                    )}
                </Modal>
            )}
        </div>
    );
};

export default Postings;
