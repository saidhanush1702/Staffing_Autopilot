/**
 * Layer 0 — authentication.
 *
 * Reads the JWT from the httpOnly `token` cookie, verifies it, and attaches
 * req.user = { id, role, orgId }.
 *
 * orgId comes from the SIGNED TOKEN and nowhere else. Never read it from the
 * request body, query string, or route params — that is the whole basis of
 * tenant isolation.
 */
import jwt from 'jsonwebtoken';

export const verifyToken = (req, res, next) => {
    const token = req.cookies?.token;

    if (!token) {
        return res.status(401).json({ error: 'Not authenticated. Please log in.' });
    }

    try {
        const payload = jwt.verify(token, process.env.JWT_SECRET);
        req.user = {
            id: payload.id,
            role: payload.role,
            orgId: payload.orgId ?? null,
        };
        return next();
    } catch (err) {
        const expired = err.name === 'TokenExpiredError';
        return res.status(401).json({
            error: expired ? 'Session expired. Please log in again.' : 'Invalid session.',
        });
    }
};
