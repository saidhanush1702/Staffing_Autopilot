/**
 * ── GETTING WORDS OUT OF A RESUME FILE ────────────────────────────────
 *
 * PDF and DOCX in, plain text out. Nothing here interprets a resume — that is
 * the parse stage's job. This only answers "what does the document say".
 *
 * ── WHY .doc IS REFUSED RATHER THAN ATTEMPTED ─────────────────────────
 *
 * A legacy .doc is an OLE2 compound file, and there is no sound pure-JavaScript
 * reader for one. The available options are a native binary (which this
 * deployment is deliberately free of) or a best-effort byte scrape that returns
 * a plausible-looking mixture of real text and formatting garbage.
 *
 * The second option is the dangerous one. It does not fail — it produces
 * something, that something goes to a model, and the model tailors a resume out
 * of noise. A refusal is visible; a bad extraction is not, and it ends up in
 * front of an employer under a real person's name.
 *
 * So .doc is refused, the queue item is marked UNPARSEABLE_RESUME, the
 * application still goes out with the original file attached, and the
 * consultant is asked for a PDF or DOCX.
 */
import { extractRawText, convertToHtml } from 'mammoth';

/** File signatures. Extension and MIME type are both client-supplied. */
export const sniffKind = (buffer) => {
    if (!buffer || buffer.length < 4) return null;
    if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) {
        return 'pdf';
    }
    if (buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) {
        return 'docx';
    }
    if (buffer[0] === 0xd0 && buffer[1] === 0xcf && buffer[2] === 0x11 && buffer[3] === 0xe0) {
        return 'doc';
    }
    return null;
};

/**
 * Tidy extracted text without changing what it says.
 *
 * Collapses the runs of blank lines and stray whitespace both extractors
 * produce. Deliberately conservative: line breaks carry the section structure
 * the parse stage depends on, so they are normalised, never removed.
 */
export const normaliseText = (raw) => String(raw ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/ /g, ' ')
    // Ligatures and the private-use glyphs some PDF producers emit for them.
    .replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/** A real web address, not a mailto:, tel: or javascript: pseudo-link. */
const WEB_LINK = /^https?:\/\//i;

/** How many hyperlink URLs are worth carrying into the parse step at all. */
const MAX_LINKS = 20;

const extractPdf = async (buffer) => {
    // Imported here rather than at module load: pdfjs is heavy, and the server
    // boots on machines that will never tailor a resume.
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

    // The LOADING TASK owns the worker and is what has to be destroyed.
    // PDFDocumentProxy carries no destroy() in current pdfjs, and calling one on
    // it threw — which, because the throw happened after every page had been
    // read, failed the whole extraction for what was only cleanup.
    const loadingTask = pdfjs.getDocument({
        data: new Uint8Array(buffer),
        // A resume needs none of these, and each one is an attack surface on a
        // file that arrived from outside.
        disableFontFace: true,
        isEvalSupported: false,
        useSystemFonts: false,
    });
    const doc = await loadingTask.promise;

    const pages = [];
    const links = [];
    for (let n = 1; n <= doc.numPages; n += 1) {
        const page = await doc.getPage(n);
        const content = await page.getTextContent();

        // ── A LINK THE VISIBLE TEXT DOES NOT SAY ───────────────────────
        //
        // The text stream above holds only what is drawn — the word
        // "LinkedIn", say — never the address a click on it would open. A
        // Link annotation carries that address as its own object, entirely
        // separate from the page's text content, so it is read here and
        // handed to the parse model as extra evidence rather than lost.
        try {
            const annotations = await page.getAnnotations();
            for (const a of annotations) {
                const url = a?.url ?? a?.unsafeUrl;
                if (a?.subtype === 'Link' && typeof url === 'string' && WEB_LINK.test(url)) {
                    links.push(url);
                }
            }
        } catch { /* a page whose annotations cannot be read still has its text */ }

        // pdfjs hands back positioned fragments, not lines. Without rebuilding
        // lines from the Y coordinate, a two-column resume interleaves into
        // nonsense and every heading fuses to the paragraph beside it.
        let line = [];
        let lastY = null;
        const out = [];

        for (const item of content.items) {
            if (typeof item.str !== 'string') continue;
            const y = item.transform?.[5];

            if (lastY !== null && Math.abs(y - lastY) > 2) {
                out.push(line.join('').trim());
                line = [];
            }
            line.push(item.str);
            if (item.hasEOL) {
                out.push(line.join('').trim());
                line = [];
            }
            lastY = y;
        }
        if (line.length) out.push(line.join('').trim());

        pages.push(out.filter(Boolean).join('\n'));
        page.cleanup();
    }

    // Best effort. A cleanup failure must never turn a successful extraction
    // into a failed one — that was exactly this function's first bug.
    try { await loadingTask.destroy(); } catch { /* the worker is going anyway */ }
    return { text: pages.join('\n\n'), links };
};

/**
 * ── A LINK THE VISIBLE TEXT DOES NOT SAY, DOCX'S VERSION ────────────────
 *
 * `extractRawText` reads only the words a person sees — hyperlinked text
 * comes back as its own display words, "LinkedIn" or "GitHub", with the
 * address behind it thrown away. A consultant's contact links are very often
 * written exactly that way: a short label hyperlinked to a profile, not the
 * bare URL typed out. `convertToHtml`, run on the same bytes, keeps the
 * `href` an `extractRawText` pass discards, so both are read and the address
 * rides alongside the visible text rather than being lost.
 */
const extractDocx = async (buffer) => {
    const [{ value: text }, { value: html }] = await Promise.all([
        extractRawText({ buffer }),
        convertToHtml({ buffer }),
    ]);
    const links = [...html.matchAll(/href="([^"]+)"/gi)]
        .map((m) => m[1])
        .filter((href) => WEB_LINK.test(href));
    return { text, links };
};

/**
 * Hyperlink addresses the visible text never spelled out, appended as their
 * own clearly-marked block so the parse model can still find a consultant's
 * LinkedIn or GitHub even when the document only hyperlinked a word.
 *
 * A `mailto:` link is excluded — the email address is already in the visible
 * contact line whenever the document states one, and a link's OWN presence
 * is never treated as proof it belongs to this person; PARSE_SYSTEM decides
 * that from what is nearby, the same as it would for any other fact.
 */
export const appendLinkBlock = (text, links) => {
    const seen = new Set();
    const kept = [];
    for (const raw of links ?? []) {
        const url = String(raw ?? '').trim();
        if (!url || !WEB_LINK.test(url)) continue;
        const key = url.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        kept.push(url);
        if (kept.length >= MAX_LINKS) break;
    }
    if (kept.length === 0) return text;
    return `${text}\n\nHYPERLINKS FOUND IN THE DOCUMENT\n${kept.join('\n')}`;
};

/**
 * Extract the text of a resume.
 *
 * Never throws — a corrupt upload is an ordinary event and the caller needs a
 * reason it can put on a screen, not a stack trace.
 *
 * @returns {{ok: true, text, kind, chars}} | {{ok: false, reason, error}}
 *   `reason` is one of UNSUPPORTED_FORMAT | EMPTY_DOCUMENT | EXTRACTION_FAILED,
 *   which maps directly onto queue_items.tailoring_skip_reason.
 */
export const extractResumeText = async (buffer) => {
    const kind = sniffKind(buffer);

    if (kind === null) {
        return {
            ok: false,
            reason: 'UNSUPPORTED_FORMAT',
            error: 'The file is not a PDF or DOCX. Renaming a file does not change its type.',
        };
    }

    if (kind === 'doc') {
        return {
            ok: false,
            reason: 'UNSUPPORTED_FORMAT',
            error: 'Legacy .doc files cannot be read reliably. '
                + 'Please re-save the resume as PDF or DOCX and upload it again.',
        };
    }

    try {
        const { text: raw, links } = kind === 'pdf' ? await extractPdf(buffer) : await extractDocx(buffer);
        const text = normaliseText(raw);

        // A PDF of scanned images extracts cleanly to nothing. Without this
        // check that becomes an empty resume sent to a model, which returns a
        // confident, entirely invented one. Measured before any hyperlink
        // block is appended — a scanned resume with one embedded link must
        // still be refused as unreadable, not accepted on that link alone.
        if (text.length < 200) {
            return {
                ok: false,
                reason: 'EMPTY_DOCUMENT',
                error: `Only ${text.length} characters of text could be read. `
                    + 'The resume may be a scan or an image rather than a text document.',
            };
        }

        const withLinks = appendLinkBlock(text, links);
        return { ok: true, text: withLinks, kind, chars: withLinks.length };
    } catch (err) {
        return {
            ok: false,
            reason: 'EXTRACTION_FAILED',
            error: `The document could not be read: ${err.message}`,
        };
    }
};
