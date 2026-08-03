/**
 * Offset pagination for list endpoints.
 *
 * Offset rather than cursor because every list here is sorted by a stable
 * human-meaningful column (name, submitted_at) and the page sizes are small.
 * Cursor pagination would be the right call for an append-only feed; it is
 * over-engineering for a few hundred rows.
 */
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;

/** Read and clamp ?limit / ?page (or ?offset) from a request. */
export const readPaging = (req) => {
    const limit = Math.min(
        Math.max(Number(req.query.limit) || DEFAULT_LIMIT, 1),
        MAX_LIMIT,
    );
    const offset = req.query.offset !== undefined
        ? Math.max(Number(req.query.offset) || 0, 0)
        : (Math.max(Number(req.query.page) || 1, 1) - 1) * limit;

    return { limit, offset };
};

/**
 * Build the response envelope.
 * `total` comes from a COUNT(*) OVER () window on the same query, so the
 * count and the page are always consistent — no second round trip, and no
 * chance of the two disagreeing if a row is inserted between them.
 */
export const pageResult = (rows, { limit, offset }) => {
    const total = rows.length ? Number(rows[0].total_count ?? rows.length) : 0;
    return {
        data: rows.map(({ total_count, ...rest }) => rest),
        page: {
            limit,
            offset,
            total,
            pageCount: Math.max(Math.ceil(total / limit), 1),
            currentPage: Math.floor(offset / limit) + 1,
            hasMore: offset + rows.length < total,
        },
    };
};
