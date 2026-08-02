import axios from 'axios';

/**
 * Shared axios instance.
 *
 * withCredentials: true is what sends the httpOnly `token` cookie. There is no
 * Authorization header anywhere in this app, and no token in localStorage.
 */
const api = axios.create({
    baseURL: `${import.meta.env.VITE_BACKEND_URL ?? 'http://localhost:5000'}/api`,
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
