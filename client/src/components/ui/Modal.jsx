import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import {
    MODAL_BACKDROP, MODAL_PANEL, MODAL_SECTION, MODAL_SIZE,
    TONE_TEXT, btn,
} from '../../design/tokens.js';

/**
 * THE dialog. Every popup in the app is this component — there is no second
 * modal implementation, and adding one is a bug.
 *
 * What it guarantees, identically everywhere:
 *   · portalled to <body>, so a table's `overflow` cannot clip it
 *   · one backdrop colour, one z-index, one panel radius and shadow
 *   · one width scale (see MODAL_SIZE) — sm | md | lg, plus `viewer`
 *   · Escape closes it, backdrop click closes it, and there is always an X
 *   · the page behind it cannot scroll while it is open
 *   · header / body / footer separated by the same borders and padding
 *
 * The portal matters: a `fixed` overlay nested inside a table is laid out
 * against the nearest positioned or transformed ancestor and clipped by any
 * `overflow` on the way up. That is why an earlier dialog came out
 * mis-centred and cropped.
 *
 *   <Modal title="Reset password" size="sm" onClose={close}
 *          as="form" onSubmit={save}
 *          footer={<ModalActions onCancel={close} confirmLabel="Reset" />}>
 *       …fields…
 *   </Modal>
 *
 * `variant="viewer"` is the full-viewport case (a resume preview): same
 * shell, same behaviours, no white card — because forcing a document
 * preview into a 384px box would be worse, not more consistent.
 */
const Modal = ({
    title,
    subtitle,
    icon: Icon,
    tone = 'neutral',
    size = 'md',
    variant = 'panel',
    as: Tag = 'div',
    onSubmit,
    onClose,
    footer,
    children,
    bodyClassName = '',
    scrollBody = false,
}) => {
    // Escape to close, and freeze the page behind the dialog.
    useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('keydown', onKey);

        const previous = document.body.style.overflow;
        document.body.style.overflow = 'hidden';

        return () => {
            document.removeEventListener('keydown', onKey);
            document.body.style.overflow = previous;
        };
    }, [onClose]);

    if (variant === 'viewer') {
        return createPortal(
            <div
                role="dialog"
                aria-modal="true"
                aria-label={title}
                className="fixed inset-0 z-50 flex flex-col bg-slate-900/80 p-4"
                onClick={onClose}
            >
                <div className="mb-2 flex items-center justify-between gap-3">
                    <p className="truncate text-sm font-medium text-white">{title}</p>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label="Close"
                        className="shrink-0 rounded-lg bg-white/10 p-2 text-white hover:bg-white/20"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>
                <div className="flex min-h-0 flex-1" onClick={(e) => e.stopPropagation()}>
                    {children}
                </div>
            </div>,
            document.body,
        );
    }

    return createPortal(
        <div
            role="dialog"
            aria-modal="true"
            aria-label={title}
            className={MODAL_BACKDROP}
            onClick={onClose}
        >
            <Tag
                onClick={(e) => e.stopPropagation()}
                onSubmit={onSubmit}
                className={`${MODAL_PANEL} ${MODAL_SIZE[size] ?? MODAL_SIZE.md}`}
            >
                <div className={`flex items-start justify-between gap-3 border-b border-slate-200 ${MODAL_SECTION}`}>
                    <div className="flex min-w-0 items-start gap-2">
                        {Icon && <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${TONE_TEXT[tone]}`} />}
                        <div className="min-w-0">
                            <h2 className="text-base font-semibold text-slate-900">{title}</h2>
                            {subtitle && <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p>}
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label="Close"
                        className="shrink-0 rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                    >
                        <X className="h-5 w-5" />
                    </button>
                </div>

                <div className={[
                    scrollBody ? 'min-h-0 flex-1 overflow-y-auto' : `${MODAL_SECTION} overflow-y-auto`,
                    bodyClassName,
                ].join(' ')}>
                    {children}
                </div>

                {footer && (
                    <div className={`border-t border-slate-200 ${MODAL_SECTION}`}>
                        {footer}
                    </div>
                )}
            </Tag>
        </div>,
        document.body,
    );
};

/**
 * The standard footer button pair, so Cancel and Confirm sit in the same
 * place with the same emphasis in every dialog.
 *
 * Stacked on phones (confirm on top, reachable by thumb), side by side from
 * `sm` up with confirm last. `extra` fills the left-hand side — a selection
 * count, a hint, anything that is not an action.
 */
export const ModalActions = ({
    onCancel,
    onConfirm,
    confirmLabel = 'Save',
    cancelLabel = 'Cancel',
    variant = 'primary',
    busy = false,
    disabled = false,
    confirmType = 'button',
    confirmTitle,
    extra = null,
}) => (
    <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
        <span className="text-xs text-slate-400">{extra}</span>
        <span className="flex flex-col-reverse gap-2 sm:flex-row">
            <button type="button" onClick={onCancel} className={btn.secondary}>
                {cancelLabel}
            </button>
            <button
                type={confirmType}
                onClick={onConfirm}
                disabled={busy || disabled}
                title={confirmTitle}
                className={btn[variant] ?? btn.primary}
            >
                {busy && <Spinner />}
                {confirmLabel}
            </button>
        </span>
    </div>
);

const Spinner = () => (
    <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
);

export default Modal;
