/**
 * Just enough semver for "is this desktop build older than that one".
 *
 * Compares MAJOR.MINOR.PATCH numerically and ignores any pre-release suffix
 * (0.2.0-beta.1 compares as 0.2.0). Anything unparseable returns null, and
 * callers treat null as "do not block" — a malformed header must never lock a
 * consultant out of the app.
 */
export const parseVersion = (v) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? '').trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};

/** -1 / 0 / 1, or null when either side cannot be parsed. */
export const compareVersions = (a, b) => {
    const x = parseVersion(a);
    const y = parseVersion(b);
    if (!x || !y) return null;
    for (let i = 0; i < 3; i += 1) {
        if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    }
    return 0;
};
