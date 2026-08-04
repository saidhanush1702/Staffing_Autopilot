import { Upload, FileText, Loader2 } from 'lucide-react';
import { useState } from 'react';
import api, { errorMessage } from '../api/axios.js';

/**
 * Renders one profile field from the server's registry (GET /api/profile-schema).
 *
 * Adding a new field to backend/config/profileFields.js makes it appear here
 * automatically — nothing in this component needs to change.
 */
const ProfileField = ({ name, field, value, onChange, lookups, disabled, currentFileName }) => {
    const [uploading, setUploading] = useState(false);
    const [uploadError, setUploadError] = useState('');
    const [uploadedName, setUploadedName] = useState('');

    const base = 'mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500';

    const handleFile = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        setUploading(true);
        setUploadError('');
        try {
            const fd = new FormData();
            fd.append('resume', file);
            const { data } = await api.post('/portal/resume', fd, {
                headers: { 'Content-Type': 'multipart/form-data' },
            });
            setUploadedName(data.originalName);
            onChange(name, data.artifactId);
        } catch (err) {
            setUploadError(errorMessage(err, 'Upload failed.'));
        } finally {
            setUploading(false);
        }
    };

    const label = (
        <span className="text-sm font-medium text-slate-700">
            {field.label}
            {field.required && <span className="ml-1 text-red-500">*</span>}
        </span>
    );

    if (field.type === 'file') {
        return (
            <div>
                {label}
                <div className="mt-1 flex items-center gap-3 rounded-lg border border-dashed border-slate-300 p-3">
                    <FileText className="h-5 w-5 shrink-0 text-slate-400" />
                    <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-slate-700">
                            {uploadedName || currentFileName || 'No resume uploaded'}
                        </p>
                        {uploadedName && (
                            <p className="text-xs text-amber-600">New file — submit to send for approval</p>
                        )}
                        {uploadError && <p className="text-xs text-red-600">{uploadError}</p>}
                    </div>
                    <label className={`shrink-0 cursor-pointer rounded-lg border border-slate-300 px-3 py-1.5 text-xs ${disabled ? 'pointer-events-none opacity-50' : 'hover:bg-slate-50'}`}>
                        {uploading
                            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            : <span className="flex items-center gap-1.5"><Upload className="h-3.5 w-3.5" /> Choose file</span>}
                        <input
                            type="file"
                            accept=".pdf,.doc,.docx"
                            className="hidden"
                            disabled={disabled || uploading}
                            onChange={handleFile}
                        />
                    </label>
                </div>
                <p className="mt-1 text-xs text-slate-400">PDF, DOC or DOCX · max 10 MB</p>
            </div>
        );
    }

    if (field.type === 'lookup') {
        const options = lookups?.[field.lookup] ?? [];
        return (
            <label className="block">
                {label}
                <select
                    value={value ?? ''}
                    disabled={disabled}
                    onChange={(e) => onChange(name, e.target.value === '' ? null : Number(e.target.value))}
                    className={base}
                >
                    <option value="">Select…</option>
                    {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
            </label>
        );
    }

    if (field.type === 'textarea') {
        return (
            <label className="block sm:col-span-2">
                {label}
                <textarea
                    rows={3}
                    value={value ?? ''}
                    disabled={disabled}
                    maxLength={field.maxLength}
                    placeholder={field.placeholder}
                    onChange={(e) => onChange(name, e.target.value)}
                    className={base}
                />
            </label>
        );
    }

    /**
     * The rule comes from the server's field registry (GET /api/profile-schema),
     * so this is the same regex the server will enforce — not a second copy that
     * can drift. Shown live rather than only on submit, since a wrong phone
     * number is worth catching before it becomes an approval request.
     */
    const invalid = field.pattern
        && value
        && !new RegExp(field.pattern).test(String(value));

    return (
        <label className="block">
            {label}
            <input
                type={field.type === 'url' ? 'url' : 'text'}
                value={value ?? ''}
                disabled={disabled}
                maxLength={field.maxLength}
                placeholder={field.placeholder}
                inputMode={field.inputMode}
                pattern={field.pattern}
                aria-invalid={invalid || undefined}
                title={field.patternMessage}
                onChange={(e) => onChange(name, e.target.value)}
                className={`${base} ${invalid ? 'border-red-400 focus:border-red-500 focus:ring-red-100' : ''}`}
            />
            {invalid && (
                <span className="mt-1 block text-xs text-red-600">{field.patternMessage}</span>
            )}
        </label>
    );
};

export default ProfileField;
