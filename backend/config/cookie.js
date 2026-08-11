/**
 * ── THE AUTH COOKIE, IN ONE PLACE ─────────────────────────────────────
 *
 * Two files set these flags — authController (login, logout, me) and
 * verifyToken (clear-on-reject). They have to agree exactly: a browser only
 * overwrites a cookie when the replacement Set-Cookie matches on name, path
 * and domain, so flags that drift apart turn "log out" into a no-op against
 * the cookie the browser is actually holding.
 *
 * ── CROSS_SITE_COOKIE ─────────────────────────────────────────────────
 *
 * For split hosting: the SPA on one domain, the API on another. The browser
 * then treats every XHR as cross-site and refuses to attach a SameSite=Lax
 * cookie, so the request arrives with no token and a perfectly correct login
 * is followed by 401 on everything. SameSite=None is the fix, and browsers
 * reject SameSite=None unless Secure is also set — which is why the two move
 * together here rather than being configured separately.
 *
 * Leave it unset and behaviour is exactly what it was for local development:
 * Lax, with Secure only in production. Set it to "true" ONLY when the API is
 * served over HTTPS, because Secure cookies are dropped on plain HTTP.
 */

const isCrossSite = () => process.env.CROSS_SITE_COOKIE === 'true';

export const COOKIE_NAME = 'token';
export const ONE_DAY_MS = 86_400_000;

/** Flags for setting the cookie. */
export const cookieOptions = () => ({
    httpOnly: true,
    secure: isCrossSite() || process.env.NODE_ENV === 'production',
    sameSite: isCrossSite() ? 'None' : 'Lax',
    maxAge: ONE_DAY_MS,
    path: '/',
});

/**
 * The same flags, shaped to expire the cookie instead of setting it.
 * maxAge is cleared because it takes precedence over expires when both are
 * present, which would keep the cookie alive for another day.
 */
export const clearCookieOptions = () => ({
    ...cookieOptions(),
    expires: new Date(0),
    maxAge: undefined,
});
