/** True when `current` is an older MAJOR.MINOR.PATCH than `latest`. Unparseable = false. */
export const isOlder = (current, latest) => {
    const parse = (v) => {
        const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? '').trim());
        return m ? m.slice(1).map(Number) : null;
    };
    const a = parse(current);
    const b = parse(latest);
    if (!a || !b) return false;
    for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] < b[i];
    return false;
};
