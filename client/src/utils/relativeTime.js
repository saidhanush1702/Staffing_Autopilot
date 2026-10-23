/**
 * "3 min ago", "in 2 h", "1m 30s" — the small durations the live mirror lives on.
 *
 * Separate from datetime.js on purpose: that file is about the AGENCY'S clock
 * (formatting an instant in its timezone). These are distances between two
 * instants, which have no timezone and read the same everywhere.
 */

const plural = (n, unit) => `${n} ${unit}`;

/** A length of time in seconds → "45s", "3m 20s", "2h 5m", "4d 3h". */
export const formatDuration = (seconds) => {
    if (seconds === null || seconds === undefined || Number.isNaN(Number(seconds))) return '—';
    const s = Math.max(0, Math.round(Number(seconds)));
    if (s < 60) return `${s}s`;
    if (s < 3600) {
        const m = Math.floor(s / 60);
        const rest = s % 60;
        return rest ? `${m}m ${rest}s` : `${m}m`;
    }
    if (s < 86_400) {
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        return m ? `${h}h ${m}m` : `${h}h`;
    }
    const d = Math.floor(s / 86_400);
    const h = Math.floor((s % 86_400) / 3600);
    return h ? `${d}d ${h}h` : `${d}d`;
};

const asMs = (value) => {
    if (!value) return null;
    const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
    return Number.isNaN(t) ? null : t;
};

/** An instant in the past → "just now", "45s ago", "3 min ago", "2 h ago", "4 d ago". */
export const timeAgo = (value, now = Date.now()) => {
    const t = asMs(value);
    if (t === null) return 'never';
    const s = Math.round((now - t) / 1000);
    if (s < 5) return 'just now';
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${plural(Math.round(s / 60), 'min')} ago`;
    if (s < 86_400) return `${plural(Math.round(s / 3600), 'h')} ago`;
    return `${plural(Math.round(s / 86_400), 'd')} ago`;
};

/** An instant in the future → "due now", "in 45s", "in 3 min", "in 2 h". */
export const timeUntil = (value, now = Date.now()) => {
    const t = asMs(value);
    if (t === null) return '—';
    const s = Math.round((t - now) / 1000);
    if (s <= 0) return 'due now';
    if (s < 60) return `in ${s}s`;
    if (s < 3600) return `in ${plural(Math.round(s / 60), 'min')}`;
    if (s < 86_400) return `in ${plural(Math.round(s / 3600), 'h')}`;
    return `in ${plural(Math.round(s / 86_400), 'd')}`;
};

/** Bytes → "0 B", "850 B", "12 KB", "3.4 MB". */
export const formatBytes = (bytes) => {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0) return '0 B';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
};
