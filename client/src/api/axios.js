import axios from 'axios';

/**
 * Where the API lives. One definition — anything needing a raw URL rather than
 * this axios instance (the resume preview builds <iframe> and download links)
 * imports it from here instead of rebuilding the string.
 *
 * Empty in a production build, so requests go to the origin the app was served
 * from and the host forwards /api to the backend. That keeps the session cookie
 * FIRST-PARTY, which matters for more than tidiness: a cookie on a different
 * domain is a third-party cookie, blocked outright by Safari and increasingly
 * by Chrome, and never sent from inside the preview iframe.
 *
 * Set VITE_BACKEND_URL to point at another origin instead. The backend then
 * needs CROSS_SITE_COOKIE=true and that origin listed in CLIENT_ORIGIN.
 */
export const API_ROOT = import.meta.env.VITE_BACKEND_URL
    ?? (import.meta.env.DEV ? 'http://localhost:5000' : '');

/**
 * Shared axios instance.
 *
 * withCredentials: true is what sends the httpOnly `token` cookie. There is no
 * Authorization header anywhere in this app, and no token in localStorage.
 */
const api = axios.create({
    baseURL: `${API_ROOT}/api`,
    withCredentials: true,
    headers: { 'Content-Type': 'application/json' },
});

/**
 * On 401 anywhere, clear the local display hint and bounce to login —
 * except on /auth/me, which AuthContext calls deliberately to probe whether
 * a session exists.
 */
api.interceptors.response.use(
    (response) => response,
    (error) => {
        const status = error.response?.status;
        const url = error.config?.url ?? '';

        if (status === 401 && !url.includes('/auth/me')) {
            localStorage.removeItem('userRole');
            if (window.location.pathname !== '/') window.location.href = '/';
        }
        return Promise.reject(error);
    },
);

/** Pull a usable message out of an axios error. */
export const errorMessage = (err, fallback = 'Something went wrong.') =>
    err?.response?.data?.error
    ?? err?.response?.data?.details?.[0]?.message
    ?? fallback;

export default api;
