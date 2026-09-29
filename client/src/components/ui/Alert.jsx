import { AlertCircle, AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import { alertShell, TONE_ALERT, TONE_TEXT } from '../../design/tokens.js';

/**
 * The block-level notice. Every banner, error and confirmation in the app is
 * one of these, so a failure never arrives looking like a different product.
 *
 * The icon is chosen BY THE TONE, not passed in: an alert whose icon and
 * colour disagree is worse than one with no icon at all.
 */
const ICON = {
    success: CheckCircle2,
    warning: AlertTriangle,
    danger: AlertCircle,
    info: Info,
    brand: Info,
    neutral: Info,
};

const Alert = ({ tone = 'info', title, onDismiss, className = '', children }) => {
    const Icon = ICON[tone] ?? Info;

    return (
        <div role="alert" className={`${alertShell} ${TONE_ALERT[tone] ?? TONE_ALERT.info} ${className}`}>
            <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${TONE_TEXT[tone] ?? TONE_TEXT.info}`} />
            <div className="min-w-0 flex-1">
                {title && <p className="font-semibold">{title}</p>}
                <div className={title ? 'mt-0.5' : undefined}>{children}</div>
            </div>
            {onDismiss && (
                <button
                    type="button"
                    onClick={onDismiss}
                    aria-label="Dismiss"
                    className="-mr-1 -mt-1 shrink-0 rounded-md p-1 opacity-60 transition hover:opacity-100"
                >
                    <X className="h-3.5 w-3.5" />
                </button>
            )}
        </div>
    );
};

export default Alert;
