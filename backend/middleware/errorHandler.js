/** 404 for unmatched routes. Registered after all route definitions. */
export const notFound = (req, res) => {
    res.status(404).json({ error: `Route not found: ${req.method} ${req.originalUrl}` });
};

/**
 * Central error handler. Must be the LAST app.use().
 * Never leaks a stack trace to the client; logs it instead.
 */
export const errorHandler = (err, req, res, _next) => {
    const status = err.status ?? 500;

    console.error(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
    console.error(err.stack ?? err.message);

    // Postgres error codes worth translating into something actionable.
    if (err.code === '23505') {
        return res.status(409).json({ error: 'That record already exists.' });
    }
    if (err.code === '23503') {
        return res.status(409).json({ error: 'Referenced record does not exist.' });
    }
    if (err.code === '23514') {
        return res.status(422).json({ error: 'Value violates a database constraint.' });
    }

    return res.status(status).json({
        error: status === 500 ? 'Internal server error.' : err.message,
    });
};
