/**
 * Small text helpers shared by the acquisition layer.
 *
 * `plain()` is the one survivor of the v1 scraping connectors. Google Jobs
 * descriptions are usually plain text, but a minority arrive with the markup
 * the originating board wrapped them in — <br>, <li>, the occasional entity.
 * Storing that raw would put tags in front of the keyword matcher, which then
 * matches "strong" against <strong>.
 */

/** Strip tags and decode the handful of entities that actually show up. */
export const plain = (html) => {
    if (!html) return null;
    return String(html)
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/[ \t]+/g, ' ')
        // Removing an inline tag leaves a gap before the punctuation that
        // followed it — "Build <b>things</b>." would become "Build things .".
        .replace(/[ \t]+([.,;:!?)\]])/g, '$1')
        .replace(/([([])[ \t]+/g, '$1')
        .replace(/\n{3,}/g, '\n\n')
        .trim() || null;
};

/** Collapse whitespace in a single-line field. Google pads `location`. */
export const tidy = (s) => {
    if (s === null || s === undefined) return null;
    return String(s).replace(/\s+/g, ' ').trim() || null;
};
