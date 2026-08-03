import { useState } from 'react';
import { FileText, Download, Maximize2, X, AlertCircle } from 'lucide-react';

const API = import.meta.env.VITE_BACKEND_URL ?? 'http://localhost:5001';

/**
 * Inline resume preview.
 *
 * PDFs render in an <iframe> straight from the audited download endpoint with
 * ?disposition=inline. The session cookie rides along because the API and the
 * client are the same site (different ports do not make a different site), so
 * no token has to be put in the URL.
 *
 * Word files have no browser renderer — those fall back to a download prompt.
 */
const ResumePreview = ({ artifactId, fileName, uploadedAt, compact = false }) => {
    const [expanded, setExpanded] = useState(false);

    if (!artifactId) {
        return (
            <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-slate-300 bg-white py-10">
                <FileText className="h-8 w-8 text-slate-300" />
                <p className="text-sm text-slate-500">No resume uploaded yet</p>
            </div>
        );
    }

    const src = `${API}/api/resumes/${artifactId}/download?disposition=inline`;
    const dl = `${API}/api/resumes/${artifactId}/download`;
    const isPdf = (fileName ?? '').toLowerCase().endsWith('.pdf');

    return (
        <>
            <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2.5">
                    <div className="flex min-w-0 items-center gap-2">
                        <FileText className="h-4 w-4 shrink-0 text-slate-400" />
                        <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-slate-800">{fileName}</p>
                            {uploadedAt && (
                                <p className="text-xs text-slate-400">
                                    Uploaded {new Date(uploadedAt).toLocaleDateString()}
                                </p>
                            )}
                        </div>
                    </div>
                    <div className="flex shrink-0 gap-2">
                        {isPdf && (
                            <button
                                type="button"
                                onClick={() => setExpanded(true)}
                                className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-2.5 py-1 text-xs text-slate-600 hover:bg-white"
                            >
                                <Maximize2 className="h-3.5 w-3.5" /> Full screen
                            </button>
                        )}
                        <a
                            href={dl}
                            className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-2.5 py-1 text-xs text-slate-600 hover:bg-white"
                        >
                            <Download className="h-3.5 w-3.5" /> Download
                        </a>
                    </div>
                </div>

                {isPdf ? (
                    <iframe
                        src={src}
                        title={`Resume — ${fileName}`}
                        className={`w-full border-0 bg-slate-100 ${compact ? 'h-80' : 'h-[38rem]'}`}
                    />
                ) : (
                    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
                        <AlertCircle className="h-7 w-7 text-amber-500" />
                        <p className="text-sm text-slate-600">
                            Word documents cannot be previewed in the browser.
                        </p>
                        <a href={dl} className="text-sm text-brand-700 hover:underline">
                            Download to view
                        </a>
                    </div>
                )}
            </div>

            {expanded && (
                <div className="fixed inset-0 z-50 flex flex-col bg-slate-900/80 p-4">
                    <div className="mb-2 flex items-center justify-between">
                        <p className="text-sm font-medium text-white">{fileName}</p>
                        <button
                            type="button"
                            onClick={() => setExpanded(false)}
                            className="rounded-lg bg-white/10 p-2 text-white hover:bg-white/20"
                        >
                            <X className="h-4 w-4" />
                        </button>
                    </div>
                    <iframe
                        src={src}
                        title={`Resume full screen — ${fileName}`}
                        className="flex-1 rounded-lg border-0 bg-white"
                    />
                </div>
            )}
        </>
    );
};

export default ResumePreview;
