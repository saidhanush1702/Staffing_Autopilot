import { useEffect, useState } from 'react';
import {
    Search, Loader2, Check, UserPlus, AlertCircle, MapPin, PauseCircle,
} from 'lucide-react';
import api, { errorMessage } from '../../api/axios.js';
import Modal from '../ui/Modal.jsx';
import { inputBase, btn, btnSm, badge, TONE } from '../../design/tokens.js';

/**
 * Put one job into one consultant's queue, by hand.
 *
 * ── WHY EVERY CONSULTANT IS LISTED, NOT ONLY GOOD MATCHES ─────────────
 *
 * The entire reason this dialog exists is that the matcher said no. Filtering
 * this list by the matcher's opinion would reproduce the decision the person
 * opened it to overrule.
 *
 * What each row carries instead is the CONTEXT for the choice — what that
 * consultant is searching for and where. Picking a name off a bare list is no
 * better informed than the matcher was; seeing "React Developer · Hyderabad"
 * beside a React job in Texas is the whole decision, made visible.
 */
const LinkToConsultant = ({ posting, onClose, onLinked }) => {
    const [data, setData] = useState(null);
    const [term, setTerm] = useState('');
    const [error, setError] = useState('');
    const [busyId, setBusyId] = useState(null);
    const [done, setDone] = useState(null);

    const load = async (search = '') => {
        try {
            const { data: res } = await api.get(
                `/management/postings/${posting.id}/link-candidates`,
                { params: { search: search || undefined } },
            );
            setData(res);
        } catch (err) {
            setError(errorMessage(err));
        }
    };

    useEffect(() => { load(); }, [posting.id]);

    // Debounced: a request per keystroke fires six times for "priya", and the
    // answers can land out of order, so the list settles on whichever response
    // was slowest rather than the one for what is now in the box.
    useEffect(() => {
        const t = setTimeout(() => { load(term); }, 200);
        return () => clearTimeout(t);
    }, [term]);

    const link = async (consultant) => {
        setBusyId(consultant.id);
        setError('');
        try {
            const { data: res } = await api.post(
                `/management/postings/${posting.id}/link`,
                { consultantId: consultant.id },
            );
            setDone({ name: res.consultant, channel: res.channel });
            await load(term);
            onLinked?.(res);
        } catch (err) {
            setError(errorMessage(err));
        } finally {
            setBusyId(null);
        }
    };

    const list = data?.consultants ?? [];

    return (
        <Modal
            title="Link this job to a consultant"
            subtitle={`${posting.title} · ${posting.company}`}
            icon={UserPlus}
            size="lg"
            onClose={onClose}
        >
            {done && (
                <div className={`mb-4 flex items-start gap-2 rounded-lg px-3 py-2 text-sm ${TONE.success}`}>
                    <Check className="mt-0.5 h-4 w-4 shrink-0" />
                    <p>
                        Queued for <strong>{done.name}</strong>. It will be prepared like any
                        other job — tailored resume, fabrication check — and then
                        {done.channel === 'BOT'
                            ? ' picked up by their desktop app.'
                            : ' shown to them to apply by hand.'}
                    </p>
                </div>
            )}

            {error && (
                <div className={`mb-4 flex items-start gap-2 rounded-lg px-3 py-2 text-sm ${TONE.danger}`}>
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <p>{error}</p>
                </div>
            )}

            <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4
                                   -translate-y-1/2 text-slate-400" />
                <input
                    value={term}
                    onChange={(e) => setTerm(e.target.value)}
                    placeholder="Search consultants by name or email…"
                    className={`${inputBase} pl-9`}
                    autoFocus
                />
            </div>

            {!data && (
                <div className="flex justify-center py-10">
                    <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
                </div>
            )}

            {data && list.length === 0 && (
                <p className="py-10 text-center text-sm text-slate-500">
                    {term ? 'No consultant matches that.' : 'No active consultants to link to.'}
                </p>
            )}

            <ul className="mt-3 max-h-[26rem] divide-y divide-line overflow-auto">
                {list.map((c) => (
                    <li key={c.id} className="flex items-center justify-between gap-4 py-3">
                        <div className="min-w-0">
                            <p className="flex items-center gap-2 font-medium text-slate-900">
                                {c.name}
                                {c.is_paused && (
                                    <span className={`${badge} ${TONE.warning}`}>
                                        <PauseCircle className="mr-1 h-3 w-3" />paused
                                    </span>
                                )}
                            </p>

                            {/* The context that makes this a decision rather than
                                a guess: what they want, and where. */}
                            <p className="truncate text-xs text-slate-500">
                                {c.wanted_titles || <span className="text-slate-400">no search criteria set</span>}
                            </p>
                            {c.wanted_locations && (
                                <p className="flex items-center gap-1 text-xs text-slate-400">
                                    <MapPin className="h-3 w-3" />{c.wanted_locations}
                                </p>
                            )}
                        </div>

                        {c.already_queued ? (
                            <span className={`${badge} ${TONE.neutral} shrink-0`}>
                                already queued · {c.queue_status}
                            </span>
                        ) : (
                            <button
                                type="button"
                                className={`${btnSm.secondary} shrink-0`}
                                disabled={busyId !== null}
                                onClick={() => link(c)}
                            >
                                {busyId === c.id
                                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    : <UserPlus className="h-3.5 w-3.5" />}
                                Link
                            </button>
                        )}
                    </li>
                ))}
            </ul>

            <p className="mt-4 border-t border-line pt-3 text-xs text-slate-500">
                Linking by hand bypasses the matcher — nothing else. The job still gets a
                tailored resume and the no-fabrication check, and who linked it is recorded.
            </p>
        </Modal>
    );
};

export default LinkToConsultant;
