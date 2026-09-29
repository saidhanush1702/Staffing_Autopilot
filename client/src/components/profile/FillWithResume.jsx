import { useRef, useState } from 'react';
import { FileUp, Loader2, Sparkles, CheckCircle2, AlertCircle } from 'lucide-react';
import api, { errorMessage } from '../../api/axios.js';
import { card, cardPad, btn } from '../../design/tokens.js';

/**
 * ── "FILL WITH RESUME" ────────────────────────────────────────────────
 *
 * Pick a resume from your own computer and the form fills itself in. The file is
 * read and dropped — it is not uploaded as your base resume, and nothing is saved
 * until you press Submit for approval like any other change.
 *
 * Every value lands in the ordinary editable fields, and only in fields that are
 * still empty, so it can never overwrite something already typed. What a resume
 * cannot tell us (work authorization, most obviously) is left for you rather
 * than guessed.
 *
 * `onApply(data)` puts the values into the form and returns a summary of what it
 * actually did, which is what this card then reports back.
 */
const FillWithResume = ({ onApply, disabled = false }) => {
    const inputRef = useRef(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [summary, setSummary] = useState(null);

    const pick = async (e) => {
        const file = e.target.files?.[0];
        // Cleared so choosing the SAME file again still fires onChange.
        e.target.value = '';
        if (!file) return;

        setBusy(true);
        setError('');
        setSummary(null);
        try {
            const body = new FormData();
            body.append('resume', file);
            const { data } = await api.post('/portal/profile/prefill-from-resume', body, {
                headers: { 'Content-Type': 'multipart/form-data' },
            });
            setSummary({ ...onApply(data), unreadable: data.report?.unreadable ?? 0 });
        } catch (err) {
            setError(errorMessage(err, 'We could not read that resume.'));
        } finally {
            setBusy(false);
        }
    };

    const parts = summary && [
        summary.fields > 0 && `${summary.fields} detail${summary.fields === 1 ? '' : 's'}`,
        summary.skills > 0 && `${summary.skills} skill${summary.skills === 1 ? '' : 's'}`,
        summary.experience > 0 && `${summary.experience} work entr${summary.experience === 1 ? 'y' : 'ies'}`,
        summary.education > 0 && `${summary.education} education entr${summary.education === 1 ? 'y' : 'ies'}`,
        summary.projects > 0 && `${summary.projects} project${summary.projects === 1 ? '' : 's'}`,
        summary.certifications > 0 && `${summary.certifications} certification${summary.certifications === 1 ? '' : 's'}`,
    ].filter(Boolean);

    return (
        <div className={`mt-5 ${card} ${cardPad} border-brand-200`}>
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 items-start gap-3">
                    <span className="mt-0.5 rounded-lg bg-brand-50 p-2 text-brand-600">
                        <Sparkles className="h-4 w-4" />
                    </span>
                    <div className="min-w-0">
                        <p className="text-sm font-semibold text-slate-900">Fill with resume</p>
                        <p className="mt-0.5 text-xs text-slate-500">
                            Choose a resume from your computer (PDF or DOCX) and we'll fill in what we can.
                            Everything stays editable, and nothing is saved until you submit.
                        </p>
                    </div>
                </div>

                <button
                    type="button"
                    className={btn.primary}
                    disabled={busy || disabled}
                    onClick={() => inputRef.current?.click()}
                    title={disabled ? 'Your profile is awaiting approval — withdraw it first to edit.' : undefined}
                >
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileUp className="h-4 w-4" />}
                    {busy ? 'Reading your resume…' : 'Choose resume'}
                </button>
                <input
                    ref={inputRef}
                    type="file"
                    accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                    className="hidden"
                    onChange={pick}
                />
            </div>

            {error && (
                <p className="mt-3 flex items-start gap-1.5 text-xs font-medium text-danger-700">
                    <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {error}
                </p>
            )}

            {summary && (
                <div className="mt-3 rounded-lg bg-success-50 p-3 text-xs text-success-800">
                    <p className="flex items-start gap-1.5 font-medium">
                        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        {parts.length > 0
                            ? `Filled in ${parts.join(', ')} from your resume.`
                            : 'We read your resume but everything it held was already filled in.'}
                    </p>
                    <ul className="mt-1.5 list-disc space-y-0.5 pl-9">
                        <li>Please check every value, and fill in anything missing — your work authorization is never guessed.</li>
                        {summary.kept.length > 0 && (
                            <li>Kept what you already had in {summary.kept.join(', ')}.</li>
                        )}
                        {summary.unreadable > 0 && (
                            <li>{summary.unreadable} entr{summary.unreadable === 1 ? 'y' : 'ies'} could not be read and {summary.unreadable === 1 ? 'was' : 'were'} left out.</li>
                        )}
                        <li>Then press Submit for approval at the bottom.</li>
                    </ul>
                </div>
            )}
        </div>
    );
};

export default FillWithResume;
