import { useState } from 'react';
import { FileText, Download, Maximize2, AlertCircle } from 'lucide-react';
import Modal from './ui/Modal.jsx';
import { card, btnSm, TONE_TEXT } from '../design/tokens.js';

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
            <div className={`overflow-hidden ${card}`}>
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
                                className={btnSm.secondary}
                            >
                                <Maximize2 className="h-3.5 w-3.5" /> Full screen
                            </button>
                        )}
                        <a href={dl} className={btnSm.secondary}>
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
                        <AlertCircle className={`h-7 w-7 ${TONE_TEXT.warning}`} />
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
                <Modal variant="viewer" title={fileName} onClose={() => setExpanded(false)}>
                    <iframe
                        src={src}
                        title={`Resume full screen — ${fileName}`}
                        className="flex-1 rounded-lg border-0 bg-white"
                    />
                </Modal>
            )}
        </>
    );
};

export default ResumePreview;
