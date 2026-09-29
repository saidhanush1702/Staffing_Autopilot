/**
 * ── RENDERING THE TAILORED RESUME ─────────────────────────────────────
 *
 * Structured resume in, PDF on disk out.
 *
 * ── WHY THE LAYOUT IS THIS PLAIN ──────────────────────────────────────
 *
 * Every visual device that makes a resume look designed is a device that makes
 * it harder to parse. Applicant tracking systems read PDFs by pulling text in
 * document order, and they are defeated by exactly the things a designer
 * reaches for:
 *
 *   TWO COLUMNS   read across, so a sidebar's first line lands in the middle
 *                 of the first body line and both become nonsense
 *   TABLES        cells emerge in storage order, not visual order
 *   TEXT BOXES    frequently emitted outside the main content stream and
 *                 dropped entirely
 *   HEADERS AND
 *   FOOTERS       repeat on every page and are commonly read as body text
 *   ICONS FOR
 *   CONTACT INFO  a phone glyph is not the word "phone", so the number arrives
 *                 with no label
 *
 * So: one column, real text, standard headings, no graphics. It looks ordinary
 * to a person and parses perfectly to a machine, which is the correct trade for
 * a document whose first reader is software.
 *
 * The consultant's own visual design is not preserved — that was a deliberate
 * decision, recorded as D1 in the plan. What IS preserved is the thing that
 * carries meaning: their section order, their headings, and their voice.
 *
 * A colour, a font family and a margin ARE preserved, per template — that is
 * furniture, not design-in-the-ATS-hostile sense. A navy rule under a heading
 * or Times New Roman instead of Arial is still one column of real text in
 * document order; a parser extracts identical words either way.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import PDFDocument from 'pdfkit';
import { UPLOAD_ROOT } from '../utils/upload.js';
import { getTemplate } from '../config/resumeTemplates.js';
import { careerLevel, categoriseSkills, periodFor, projectPeriod } from '../config/resumeLayout.js';

/** Where tailored files live — deliberately not beside the base resumes. */
export const tailoredDir = (orgId) => path.join(UPLOAD_ROOT, orgId, 'tailored');

const DEFAULT_MARGIN = 54;       // 0.75in — the fallback when a template sets none
const RULE_COLOUR = '#999999';

/**
 * PDFKit's 14 standard fonts cover both families the three templates need,
 * with no font file to embed or license: Times for the serif template,
 * Helvetica for the two sans ones. A template names a family, never a font —
 * so "what font does CLASSIC use" has one answer, here.
 */
const FONT_FAMILIES = {
    times: {
        regular: 'Times-Roman', bold: 'Times-Bold',
        italic: 'Times-Italic', boldItalic: 'Times-BoldItalic',
    },
    helvetica: {
        regular: 'Helvetica', bold: 'Helvetica-Bold',
        italic: 'Helvetica-Oblique', boldItalic: 'Helvetica-BoldOblique',
    },
};
const fontsFor = (st) => FONT_FAMILIES[st.fontFamily] ?? FONT_FAMILIES.helvetica;

/**
 * Type sizes and colours, supplied by the template.
 *
 * A module-level constant was the obvious first cut, and it meant every
 * template printed identically no matter what its config said — which makes
 * the config a lie. They are threaded through instead, so CLASSIC genuinely
 * runs in Times New Roman at 0.5" margins while MODERN runs in Helvetica with
 * a navy accent, rather than all three sharing one look with different labels.
 */
const DEFAULT_STYLE = {
    fontFamily: 'helvetica',
    margin: DEFAULT_MARGIN,
    bodySize: 10, headingSize: 11, nameSize: 18,
    justify: false,
    headingStyle: 'rule', headerAlign: 'center', headerRule: true,
    headingGap: 0.6, afterHeadingGap: 0.5,
    headingColor: '#000000', ruleColor: RULE_COLOUR,
    bodyColor: '#000000', nameColor: '#000000',
    roleBulletsLabel: null, skillsBulleted: false,
    // Multiplies every gap the renderer leaves between lines and blocks. 1 is
    // the template as designed; the fit loop below moves it to make a resume
    // fill exactly one page or stop spilling a few lines onto a second.
    gapScale: 1,
};

/** A gap, in the template's own units, scaled by the fit loop. */
const gapOf = (st, n) => n * (st.gapScale ?? 1);

/**
 * ── WHY SOME GAPS HAVE A FLOOR, IN ABSOLUTE POINTS ────────────────────
 *
 * On a dense fresher's resume the fit loop can pick a gap scale as small as
 * 0.5 to make everything sit on one page. Measured on a real generated file
 * (MODERN, squeezed to 0.7): "TECHNICAL SKILLS" and the line under it were
 * 13.1pt apart baseline to baseline — against an ordinary line-to-line gap of
 * 11.0pt in the SAME document — because MODERN's own `afterHeadingGap` is
 * already a small fraction of a line (0.25) by design, being the "compact"
 * template, and 0.7 of a small number is smaller still: under 2pt of true
 * whitespace between a heading and the text under it.
 *
 * A SCALED floor does not fix that — clamping the 0.7 up to, say, 0.78 is
 * still 0.78 of a number that was too small to begin with. So this floor is
 * in POINTS, not a fraction of anything: however far the fit loop squeezes
 * type size, margins or the ordinary gap scale, the space before and after a
 * heading, the header block's own lines, and the space between one entry and
 * the next never drop below `STRUCTURAL_GAP_MIN_PT`. The denser, closer
 * spacing inside one entry's own bullets — which a reader already reads as
 * one continuous block, not as separate things needing a boundary — keeps
 * the full squeeze range, because that is where the page actually has room
 * to give.
 */
const STRUCTURAL_GAP_MIN_PT = 4.5;

/** The points a structural gap costs — the floor applied, never simulated. */
const structuralCost = (doc, st, n) => Math.max(gapOf(st, n) * doc.currentLineHeight(), STRUCTURAL_GAP_MIN_PT);

/** Move down by a structural gap, at whichever font is active at the call site. */
const moveDownStructural = (doc, st, n) => { doc.y += structuralCost(doc, st, n); };

/** Headings, in the wording a parser expects to meet. */
const SECTION_LABELS = {
    summary: 'PROFESSIONAL SUMMARY',
    skills: 'TECHNICAL SKILLS',
    experience: 'PROFESSIONAL EXPERIENCE',
    projects: 'PROJECTS',
    education: 'EDUCATION',
    certifications: 'CERTIFICATIONS',
    additional: 'ADDITIONAL INFORMATION',
};

/**
 * `Company_Title_Date.pdf`, safe on every filesystem.
 *
 * The name is part of the deliverable — a recruiter opening a downloads folder
 * should be able to tell which application a file belongs to without opening it.
 */
export const buildFilename = (company, title, when = new Date()) => {
    const clean = (s) => String(s ?? '')
        .normalize('NFKD')
        .replace(/[^\w\s-]/g, '')
        .trim()
        .replace(/[\s_-]+/g, '_')
        .slice(0, 40) || 'Job';

    const date = when.toISOString().slice(0, 10);
    return `${clean(company)}_${clean(title)}_${date}.pdf`;
};

const dateRange = (start, end) => {
    if (!start && !end) return '';
    if (start && end) return `${start} – ${end}`;
    return start || end;
};

/**
 * A date range with how long that is, the way a person reads one — "Sep 2024
 * – Present (11 mos)" rather than making the reader do the subtraction
 * themselves. Only appended when it can be computed from readable dates; see
 * `periodFor`/`projectPeriod` in config/resumeLayout.js for exactly which
 * ranges that covers and which it deliberately leaves alone.
 */
const withPeriod = (range, period) => (range && period ? `${range} (${period})` : range);

/* ── the sections ──────────────────────────────────────────────────── */

/**
 * ── FOUR HEADING TREATMENTS, ONE PER SOURCE FORMAT ─────────────────────
 *
 *   underline  bold heading, underlined, colon-suffixed — no drawn rule
 *              (CLASSIC)
 *   label      bold heading, colon-suffixed, no adornment at all
 *              (TECHNICAL)
 *   rule       bold heading, optionally coloured, with a thin drawn rule
 *              underneath — colour comes from the template (MODERN's navy)
 *   band       heading set inside a light shaded strip — kept for a template
 *              that wants it; none of the three current ones do
 *
 * ── WHY THESE AND NOT SOMETHING BOLDER ─────────────────────────────────
 *
 * Every one is still a line of real text in document order, with at most a
 * drawn line or a drawn rectangle underneath — never a table, a text box or
 * an image. A parser pulls exactly the same words out of all four.
 */
/**
 * How much room a heading costs by itself, at this style — the line, plus the
 * gap before it and the gap after. Used to decide whether a heading (and,
 * when the caller knows it, the block under it) still fits the page.
 */
const headingChrome = (doc, st) => {
    const fonts = fontsFor(st);
    doc.font(fonts.bold).fontSize(st.headingSize);
    return doc.currentLineHeight(true)
        + structuralCost(doc, st, st.headingGap ?? 0.6)
        + structuralCost(doc, st, st.afterHeadingGap ?? 0.5);
};

/**
 * @param bodyHeight  when the caller has measured what comes under this
 *   heading (summary, skills, certifications, one "additional" block — every
 *   section short enough to measure as one piece), the WHOLE thing moves to a
 *   fresh page together rather than the heading landing at the foot of one
 *   page with its content starting on the next. Sections with their own
 *   independently-paginated entries (experience, projects, education) pass
 *   nothing and keep the plain heading-orphan guard, because forcing a whole
 *   multi-role work history onto one page would defeat pagination entirely —
 *   those entries protect themselves instead (see `estimateEntryHeight`).
 */
const sectionHeadingS = (doc, label, st, bodyHeight = 0) => {
    if (doc.y + headingChrome(doc, st) + bodyHeight > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
    }

    moveDownStructural(doc, st, st.headingGap ?? 0.6);

    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const fonts = fontsFor(st);

    if (st.headingStyle === 'band') {
        const pad = 3;
        const top = doc.y;
        doc.rect(left, top, right - left, st.headingSize + pad * 2).fill('#ededed');
        doc.fillColor(st.headingColor)
            .font(fonts.bold).fontSize(st.headingSize)
            .text(label, left + 6, top + pad, {
                characterSpacing: 0.8, width: right - left - 12,
            });
        doc.y = top + st.headingSize + pad * 2;
    } else if (st.headingStyle === 'label') {
        // Bold text, a trailing colon, nothing drawn — the plainest of the
        // four, and the one that reads closest to a Word document's own
        // built-in heading style.
        doc.font(fonts.bold).fontSize(st.headingSize).fillColor(st.headingColor)
            .text(`${label}:`, { characterSpacing: 0.3 });
    } else if (st.headingStyle === 'underline') {
        doc.font(fonts.bold).fontSize(st.headingSize).fillColor(st.headingColor)
            .text(`${label}:`, { underline: true, characterSpacing: 0.3 });
    } else {
        // 'rule': heading with a hairline rule under it, full width. Colour
        // is a template choice — MODERN draws it navy, the others default
        // to the same neutral grey the rule always used.
        doc.font(fonts.bold).fontSize(st.headingSize).fillColor(st.headingColor)
            .text(label, { characterSpacing: 0.6 });

        const y = doc.y + 2;
        doc.moveTo(left, y).lineTo(right, y)
            .lineWidth(0.75).strokeColor(st.ruleColor ?? RULE_COLOUR).stroke();
    }

    moveDownStructural(doc, st, st.afterHeadingGap ?? 0.5);
    // Back to the left margin: the band and dash variants both moved the
    // cursor, and the body that follows must not inherit their indent.
    doc.x = left;
    doc.font(fonts.regular).fontSize(st.bodySize).fillColor(st.bodyColor);
};

/** Text width between the margins. */
const contentWidth = (doc) => doc.page.width - doc.page.margins.left - doc.page.margins.right;

/** Start a new page if `height` more would run past the bottom margin. */
const ensureRoom = (doc, height) => {
    if (doc.y + height > doc.page.height - doc.page.margins.bottom) doc.addPage();
};

/** How far a bullet's TEXT sits in from the margin; the marker sits just inside it. */
const HANG = 12;

/**
 * ── A BULLET IS A MARKER AND A BLOCK, NOT A STRING WITH A LEADING DOT ──
 *
 * This used to be `doc.text('• ' + text, { indent: 10 })`. PDFKit's `indent`
 * moves only the FIRST line, so every wrapped line went back to the left margin
 * and sat underneath the bullet instead of underneath the words — the
 * unmistakable look of a list that is not really one. The marker is now drawn on
 * its own at the margin and the text is set as a block starting a hanging
 * indent to its right, so every wrapped line lines up under the first word.
 *
 * Left-aligned, whatever the template does with body text. A justified block
 * that is only one or two lines long and a fifth of a page narrower than its
 * neighbours is stretched into wide gaps between words, and bullets are the
 * one place a resume is nearly always short lines.
 *
 * Still one real bullet character followed by real text on the same baseline,
 * in reading order, so a parser extracts "• text" exactly as before.
 */
const bulletList = (doc, bullets, st) => {
    const left = doc.page.margins.left;
    const width = contentWidth(doc) - HANG;
    const lineGap = gapOf(st, 1);

    for (const bullet of bullets ?? []) {
        const text = String(bullet ?? '').trim();
        if (!text) continue;

        ensureRoom(doc, doc.heightOfString(text, { width, lineGap }));
        const y = doc.y;
        doc.text('•', left + 2, y, { lineBreak: false });
        doc.text(text, left + HANG, y, { width, align: 'left', lineGap });
        doc.y += gapOf(st, 2);
        doc.x = left;
    }
};

/**
 * The first line of an entry: what it is on the left, when on the right.
 *
 * ── WHY DATES MOVED ───────────────────────────────────────────────────
 *
 * They used to be a grey italic line UNDER the title, easy to miss and
 * unlike every resume anyone has read. Dates on the same line as the title,
 * flush right, is the convention because the eye finds them without hunting —
 * and it saves a line per entry, which is what a one-page resume is short of.
 *
 * The title is drawn first and the date after it, so a parser reads the title
 * and then its date; and the title's width leaves room for the date, so a long
 * title wraps instead of running underneath it.
 */
const entryRow = (doc, st, fonts, leftText, rightText) => {
    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const y = doc.y;

    let dateWidth = 0;
    if (rightText) {
        doc.font(fonts.italic).fontSize(st.bodySize);
        dateWidth = doc.widthOfString(rightText);
    }

    doc.font(fonts.bold).fontSize(st.bodySize).fillColor(st.bodyColor);
    doc.text(leftText, left, y, {
        width: contentWidth(doc) - (dateWidth ? dateWidth + 14 : 0), align: 'left',
    });
    const endY = doc.y;

    if (rightText) {
        doc.font(fonts.italic).fontSize(st.bodySize);
        doc.text(rightText, right - dateWidth, y, { width: dateWidth + 2, lineBreak: false });
    }
    doc.y = endY;
    doc.x = left;
};

/** A quieter line under an entry's first line — a location, a degree, a role. */
const subLine = (doc, st, fonts, text, { italic = true } = {}) => {
    if (!text) return;
    doc.font(italic ? fonts.italic : fonts.regular).fontSize(st.bodySize - (italic ? 0.5 : 0))
        .fillColor(italic ? '#444444' : st.bodyColor)
        .text(text, doc.page.margins.left, doc.y, {
            width: contentWidth(doc), align: 'left', paragraphGap: gapOf(st, 2),
        });
    doc.fillColor(st.bodyColor).font(fonts.regular).fontSize(st.bodySize);
};

/**
 * "B.Tech in Computer Science, JNTUH" from parts that overlap.
 *
 * A degree, a field and a board are entered separately and often say the same
 * thing twice — a degree already reading "B.Tech in Computer Science and
 * Engineering" beside a field of "Computer Science and Engineering" printed the
 * field two more times on a real resume. A part already contained in one kept
 * earlier is dropped.
 */
const distinctParts = (...values) => {
    const kept = [];
    for (const value of values) {
        for (const part of String(value ?? '').split(',').map((p) => p.trim()).filter(Boolean)) {
            const lower = part.toLowerCase();
            if (kept.some((k) => k.toLowerCase().includes(lower))) continue;
            kept.push(part);
        }
    }
    return kept.join(', ');
};

/**
 * How tall one bulleted line block will be — a run of skill lines, a run of
 * one-liner certifications, an "additional" block's items — measured with
 * the SAME font/width the real draw uses, so a section can be kept off a page
 * it will not fully fit rather than starting there and splitting anyway.
 */
const estimateLinesHeight = (doc, st, lines, { hang = false } = {}) => {
    const fonts = fontsFor(st);
    doc.font(fonts.regular).fontSize(st.bodySize);
    const width = contentWidth(doc) - (hang ? HANG : 0);
    let h = 0;
    for (const line of lines ?? []) {
        const t = String(line ?? '').trim();
        if (!t) continue;
        h += doc.heightOfString(t, { width, lineGap: gapOf(st, 1) }) + gapOf(st, 2);
    }
    return h;
};

/**
 * How tall one role, project or education entry will be — never split it
 * across a page unless it genuinely does not fit one on its own (the same
 * guard `bulletList` already gives an individual bullet, one level up).
 */
const estimateEntryHeight = (doc, st, fonts, {
    title, dateText, subLines = [], bulletsLabel = null, bullets = [],
}) => {
    const width = contentWidth(doc);
    doc.font(fonts.bold).fontSize(st.bodySize);
    let h = doc.heightOfString(title || '', { width: dateText ? width - 100 : width });

    doc.font(fonts.italic).fontSize(st.bodySize - 0.5);
    for (const line of subLines) {
        if (!line) continue;
        h += doc.heightOfString(line, { width }) + gapOf(st, 2);
    }

    if (bulletsLabel) {
        doc.font(fonts.bold).fontSize(st.bodySize);
        h += doc.heightOfString(bulletsLabel, { width }) + gapOf(st, 2);
    }

    h += estimateLinesHeight(doc, st, bullets, { hang: true });
    doc.font(fonts.regular).fontSize(st.bodySize);
    return h;
};

const RENDERERS = {
    summary(doc, resume, st) {
        if (!resume.summary) return;
        const text = String(resume.summary).trim();
        const h = estimateLinesHeight(doc, st, [text]);
        sectionHeadingS(doc, SECTION_LABELS.summary, st, h);
        doc.text(text, { align: st.justify ? 'justify' : 'left', lineGap: gapOf(st, 1) });
    },

    skills(doc, resume, st) {
        // A resume whose skills arrived as one flat list — no categories at
        // all, or only one — is split into named sub-sections here; see the
        // note on `categoriseSkills`. One already organised is left as it is.
        const groups = categoriseSkills(
            (resume.skills ?? []).filter((g) => (g.items ?? []).length > 0),
        );
        if (groups.length === 0) return;
        const lines = groups.map((g) => `${g.category ?? ''}: ${g.items.join(', ')}`);
        sectionHeadingS(doc, SECTION_LABELS.skills, st,
            estimateLinesHeight(doc, st, lines, { hang: st.skillsBulleted }));
        const fonts = fontsFor(st);

        const left = doc.page.margins.left;
        for (const group of groups) {
            const items = group.items.join(', ');
            // A bulleted line hangs like any other bullet; a plain one wraps
            // back to the margin, as a run-on skills line always has.
            const x = st.skillsBulleted ? left + HANG : left;
            const width = contentWidth(doc) - (st.skillsBulleted ? HANG : 0);
            const opts = { width, align: 'left', lineGap: gapOf(st, 1) };

            ensureRoom(doc, doc.heightOfString(`${group.category ?? ''}: ${items}`, opts));
            const y = doc.y;
            if (st.skillsBulleted) {
                doc.font(fonts.regular).text('•', left + 2, y, { lineBreak: false });
            }

            if (group.category) {
                // Label and list on one line, both as text: a parser reading
                // "Languages: Java, Python" gets the association for free.
                doc.font(fonts.bold).text(`${group.category}: `, x, y, { ...opts, continued: true });
                doc.font(fonts.regular).text(items, opts);
            } else {
                doc.font(fonts.regular).text(items, x, y, opts);
            }
            doc.y += gapOf(st, 2);
            doc.x = left;
        }
    },

    experience(doc, resume, st) {
        const roles = resume.experience ?? [];
        if (roles.length === 0) return;
        sectionHeadingS(doc, SECTION_LABELS.experience, st);
        const fonts = fontsFor(st);

        roles.forEach((role, i) => {
            if (i > 0) moveDownStructural(doc, st, 0.45);

            // "Sep 2024 – Present (11 mos)" — see periodFor in resumeLayout.js
            // for exactly when the period is, and is not, appended.
            const dateText = withPeriod(
                dateRange(role.startDate, role.endDate),
                periodFor(role.startDate, role.endDate),
            );

            // Measured before anything is drawn, so the WHOLE entry — title,
            // dates, location, bullets — moves to a fresh page together
            // rather than splitting with its title at the foot of this one.
            ensureRoom(doc, estimateEntryHeight(doc, st, fonts, {
                title: `${role.title} — ${role.company}`, dateText,
                subLines: [role.location], bulletsLabel: st.roleBulletsLabel,
                bullets: role.bullets,
            }));

            // Title and company on the left, dates flush right on the same
            // line; the location, when there is one, is a quiet line beneath.
            entryRow(doc, st, fonts, `${role.title} — ${role.company}`, dateText);
            subLine(doc, st, fonts, role.location);

            // "Roles and Responsibilities:" / "Responsibilities:" — furniture
            // inside the section, not a section of its own. Only two of the
            // three source formats carry it; the third goes straight to bullets.
            if (st.roleBulletsLabel) {
                doc.font(fonts.bold).fontSize(st.bodySize).fillColor(st.bodyColor)
                    .text(st.roleBulletsLabel, doc.page.margins.left, doc.y, {
                        width: contentWidth(doc), paragraphGap: gapOf(st, 2),
                    });
            }

            doc.font(fonts.regular).fontSize(st.bodySize);
            bulletList(doc, role.bullets, st);
        });
    },

    projects(doc, resume, st) {
        const projects = resume.projects ?? [];
        if (projects.length === 0) return;
        sectionHeadingS(doc, SECTION_LABELS.projects, st);
        const fonts = fontsFor(st);

        projects.forEach((p, i) => {
            if (i > 0) moveDownStructural(doc, st, 0.35);

            // The same right-aligned date-and-period treatment employment
            // gets. `p.when` is free text — "Jan 2024 – Apr 2024", "3
            // months" — so a period is only added when it can genuinely be
            // computed from it; see projectPeriod in resumeLayout.js.
            const dateText = withPeriod(p.when, projectPeriod(p.when));

            // Never strand a project's name at the foot of a page with its
            // points on the next — the same whole-entry guard experience has.
            ensureRoom(doc, estimateEntryHeight(doc, st, fonts, {
                title: p.name, dateText, subLines: [p.description], bullets: p.bullets,
            }));

            entryRow(doc, st, fonts, p.name, dateText);

            // The role / team / links line: the same quiet line an employment
            // entry has under its title, so a project reads as an entry with
            // points beneath it, not a bare heading.
            subLine(doc, st, fonts, p.description);
            doc.font(fonts.regular).fontSize(st.bodySize);
            bulletList(doc, p.bullets, st);
        });
    },

    education(doc, resume, st) {
        const education = resume.education ?? [];
        if (education.length === 0) return;
        sectionHeadingS(doc, SECTION_LABELS.education, st);
        const fonts = fontsFor(st);

        education.forEach((e, i) => {
            if (i > 0) moveDownStructural(doc, st, 0.3);

            const dateText = dateRange(e.startDate, e.endDate);
            const degreeLine = distinctParts(e.degree, e.field);
            ensureRoom(doc, estimateEntryHeight(doc, st, fonts, {
                title: e.institution, dateText, subLines: [degreeLine, e.details],
            }));

            // Institution and years on one line, the degree beneath it, and
            // the grade or board as the quiet line after that — the same
            // shape as an employment entry, so the whole page reads alike.
            entryRow(doc, st, fonts, e.institution, dateText);
            subLine(doc, st, fonts, degreeLine, { italic: false });
            subLine(doc, st, fonts, e.details);
            doc.font(fonts.regular).fontSize(st.bodySize);
        });
    },

    certifications(doc, resume, st) {
        const certs = resume.certifications ?? [];
        if (certs.length === 0) return;
        const lines = certs.map((c) => [c.name, c.issuer, c.date].filter(Boolean).join(' — '));
        sectionHeadingS(doc, SECTION_LABELS.certifications, st, estimateLinesHeight(doc, st, lines, { hang: true }));
        bulletList(doc, lines, st);
    },

    additional(doc, resume, st) {
        const extra = resume.additional ?? [];
        if (extra.length === 0) return;

        for (const block of extra) {
            // The consultant's own heading is kept, uppercased to match the
            // others. Renaming their "Publications" to something generic would
            // lose information the document deliberately carried.
            sectionHeadingS(doc, String(block.heading).toUpperCase().slice(0, 60), st,
                estimateLinesHeight(doc, st, block.items, { hang: true }));
            bulletList(doc, block.items, st);
        }
    },
};

/* ── the whole document ────────────────────────────────────────────── */

/**
 * A known professional-profile host, by the name a resume would call it.
 *
 * `contact.links` is a flat list of bare addresses — the schema has no field
 * for which platform each one is, because the base resume rarely states one
 * either ("LinkedIn" is written as a hyperlinked word, not as prose naming
 * the site). Naming it here, from the address itself, is what makes a
 * contact line read "LinkedIn: linkedin.com/in/aarav" rather than a row of
 * unlabelled addresses nobody reads before deciding whether to click one.
 */
const LINK_HOSTS = [
    [/(^|\.)linkedin\.com$/i, 'LinkedIn'],
    [/(^|\.)github\.com$/i, 'GitHub'],
    [/(^|\.)gitlab\.com$/i, 'GitLab'],
    [/(^|\.)stackoverflow\.com$/i, 'Stack Overflow'],
    [/(^|\.)leetcode\.com$/i, 'LeetCode'],
    [/(^|\.)hackerrank\.com$/i, 'HackerRank'],
    [/(^|\.)behance\.net$/i, 'Behance'],
    [/(^|\.)dribbble\.com$/i, 'Dribbble'],
    [/(^|\.)medium\.com$/i, 'Medium'],
];

/** "LinkedIn: linkedin.com/in/aarav" — labelled where the host is known, bare where it is not (a portfolio). */
const displayLink = (url) => {
    const raw = String(url ?? '').trim();
    if (!raw) return '';
    let parsed;
    try { parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { return raw; }

    const bare = `${parsed.host}${parsed.pathname}${parsed.search}`.replace(/\/$/, '');
    const known = LINK_HOSTS.find(([pattern]) => pattern.test(parsed.host));
    return known ? `${known[1]}: ${bare}` : bare;
};

/**
 * The name block — centred or left-set, ruled or not, by template.
 *
 * Contact details stay plain text on one line in every variant, separated by
 * their own punctuation. Icons would look better and carry nothing into the
 * text a parser extracts: a phone glyph is not the word "phone", so the number
 * would arrive with no idea what it is.
 */
const renderHeader = (doc, contact, st) => {
    const align = st.headerAlign ?? 'center';
    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const fonts = fontsFor(st);

    doc.font(fonts.bold).fontSize(st.nameSize).fillColor(st.nameColor)
        .text(contact?.name ?? '', { align });

    const line = [contact?.location, contact?.phone, contact?.email]
        .filter(Boolean).join('  |  ');
    if (line) {
        moveDownStructural(doc, st, 0.25);
        doc.font(fonts.regular).fontSize(st.bodySize).fillColor(st.bodyColor).text(line, { align });
    }

    const links = (contact?.links ?? []).filter(Boolean).map(displayLink).filter(Boolean);
    if (links.length > 0) {
        moveDownStructural(doc, st, 0.15);
        doc.font(fonts.regular).fontSize(st.bodySize - 1)
            .text(links.join('  |  '), { align });
    }

    moveDownStructural(doc, st, 0.4);

    if (st.headerRule !== false) {
        const y = doc.y;
        doc.moveTo(left, y).lineTo(right, y)
            .lineWidth(st.headerRuleWidth ?? 1).strokeColor(st.ruleColor ?? '#000000').stroke();
        moveDownStructural(doc, st, 0.3);
    } else {
        // No rule here — the whitespace does the separating.
        moveDownStructural(doc, st, 0.2);
    }
    doc.x = left;
    doc.fillColor(st.bodyColor);
};

/* ── fitting the page ──────────────────────────────────────────────── */

/**
 * ── HOW LONG A RESUME IS ──────────────────────────────────────────────
 *
 * A resume used to run exactly as long as its text, which gave a fresher a
 * half-empty page or a few stray lines on a second one, and gave nobody a
 * choice about either. Length now follows career level (config/resumeLayout.js):
 *
 *   intern · fresher · entry   exactly ONE page, and a full one
 *   experienced                as many pages as the career needs
 *
 * ── WHY IT IS MEASURED AND NOT ESTIMATED ──────────────────────────────
 *
 * Whether text fits a page depends on the font, the wrapping, the margins and
 * every gap between them, and no formula over character counts gets that right
 * across three templates. So the resume is drawn for real, into memory, and the
 * page count and the fill of the last page are read back. The final file is
 * then drawn once, at the settings that measured best.
 *
 * ── WHAT IS ALLOWED TO CHANGE TO MAKE IT FIT ──────────────────────────
 *
 * Only spacing, type size and margins — in that order of preference — within
 * bounds that keep the page readable, and then, if the page is still too full,
 * content is DROPPED (never added), least valuable first. The template's font,
 * heading style and colours never change: that is the layout continuing.
 */

/**
 * [type-size factor, gap factor, margin factor], largest first.
 *
 * Stretching goes up to 1.22x type and 3.8x gaps so a short resume fills its
 * page instead of huddling at the top of it; squeezing stops at 0.90x, below
 * which body text stops being comfortable to read and content is trimmed
 * instead.
 */
const LADDER = [
    // Only ever reached by a resume with very little on it, which would
    // otherwise sit in the top half of its page.
    [1.22, 3.8, 1], [1.18, 3.2, 1], [1.14, 2.7, 1],
    [1.10, 2.2, 1], [1.08, 1.9, 1], [1.06, 1.6, 1], [1.04, 1.35, 1], [1.02, 1.15, 1],
    [1.00, 1.0, 1], [0.98, 0.9, 1], [0.96, 0.8, 0.95], [0.94, 0.7, 0.9],
    [0.92, 0.6, 0.85], [0.90, 0.5, 0.8],
];
const UNSCALED = LADDER.findIndex(([k, g, m]) => k === 1 && g === 1 && m === 1);

/** The last page that is emptier than this reads as an accident. */
const ORPHAN_FILL = 0.2;

const scaledStyle = (style, [k, g, m]) => ({
    ...style,
    bodySize: style.bodySize * k,
    headingSize: style.headingSize * k,
    nameSize: style.nameSize * k,
    margin: (style.margin ?? DEFAULT_MARGIN) * m,
    gapScale: g,
});

const newDocument = (style, info, extra = {}) => {
    const margin = style.margin ?? DEFAULT_MARGIN;
    return new PDFDocument({
        size: 'LETTER',
        margins: { top: margin, bottom: margin, left: margin, right: margin },
        info,
        // Compression off: it costs a few kilobytes and removes one thing
        // that can go wrong between us and an unknown parser on the far
        // side of an employer's careers page.
        compress: false,
        ...extra,
    });
};

/**
 * Draw the whole resume onto `doc`.
 *
 * Sections come out in the template's order, which is what makes "keep the
 * section order" enforced rather than merely requested — the renderer never
 * consults the model about where anything goes.
 *
 * ── WHO DECIDES THE RUNNING ORDER ─────────────────────────────────────
 *
 * The template, when there is one — that is the whole point of having
 * templates, and it is what stops the model rearranging a resume by returning
 * a different sectionOrder. Without a template we fall back to the order the
 * resume itself declared. Either way the renderer decides, never the model.
 */
const drawResume = (doc, resume, layout, style) => {
    renderHeader(doc, resume.contact, style);

    const preferred = layout?.sections?.length
        ? layout.sections
        : (resume.sectionOrder ?? []);

    const declared = preferred.filter((s) => RENDERERS[s]);
    const rest = Object.keys(RENDERERS).filter((s) => !declared.includes(s));

    for (const section of [...declared, ...rest]) {
        RENDERERS[section](doc, resume, style);
    }
};

/**
 * Draw into memory and report how many pages it took and how full the last
 * one is (0–1).
 */
const measure = (resume, layout, style) => {
    const doc = newDocument(style, {}, { bufferPages: true });
    doc.on('data', () => {});                 // nothing is kept; only the layout matters
    drawResume(doc, resume, layout, style);

    const pages = doc.bufferedPageRange().count;
    const margin = style.margin ?? DEFAULT_MARGIN;
    const usable = doc.page.height - margin * 2;
    const fill = Math.min(1, Math.max(0, (doc.y - margin) / usable));
    doc.end();
    return { pages, fill };
};

/**
 * Take one thing off a resume that is too long, least valuable first.
 *
 * Returns a new resume, or null when nothing more can be removed. Everything
 * removed is text the tailoring already had the right to drop, and the order
 * protects the parts an employer reads first: extra employment bullets go
 * before project points, project points before whole entries, and a project
 * is never cut below two points nor a role below two bullets.
 */
const trimOnce = (resume) => {
    const roles = resume.experience ?? [];
    const projects = resume.projects ?? [];

    const longest = (items, floor) => {
        let at = -1;
        items.forEach((it, i) => {
            const n = (it.bullets ?? []).length;
            if (n > floor && (at === -1 || n >= (items[at].bullets ?? []).length)) at = i;
        });
        return at;
    };
    const dropLastBullet = (items, at) => items.map((it, i) => (
        i === at ? { ...it, bullets: it.bullets.slice(0, -1) } : it
    ));

    let at = longest(roles, 3);
    if (at >= 0) return { ...resume, experience: dropLastBullet(roles, at) };

    at = longest(projects, 3);
    if (at >= 0) return { ...resume, projects: dropLastBullet(projects, at) };

    at = longest(roles, 2);
    if (at >= 0) return { ...resume, experience: dropLastBullet(roles, at) };

    if ((resume.additional ?? []).length > 0) {
        return { ...resume, additional: resume.additional.slice(0, -1) };
    }
    if ((resume.certifications ?? []).length > 3) {
        return { ...resume, certifications: resume.certifications.slice(0, -1) };
    }
    if (projects.length > 2) return { ...resume, projects: projects.slice(0, -1) };

    at = longest(projects, 2);
    if (at >= 0) return { ...resume, projects: dropLastBullet(projects, at) };

    return null;
};

/**
 * Choose the page settings (and, if it must, the content) for this resume.
 *
 * @returns {{resume, style, pages, fill, trimmed}}
 */
const fitResume = (resume, layout, baseStyle, onePage) => {
    const at = (i, r = resume) => {
        const style = scaledStyle(baseStyle, LADDER[i]);
        return { style, ...measure(r, layout, style) };
    };

    if (onePage) {
        // Squeeze first, at the smallest setting: if the content cannot fit a
        // page even there, trim it until it can. Only then look for the LARGEST
        // setting that still fits, which is what makes the page a full one.
        let work = resume;
        let trimmed = 0;
        for (;;) {
            if (at(LADDER.length - 1, work).pages === 1) break;
            const next = trimOnce(work);
            if (!next) break;
            work = next;
            trimmed += 1;
        }
        for (let i = 0; i < LADDER.length; i += 1) {
            const m = at(i, work);
            if (m.pages === 1 || i === LADDER.length - 1) return { resume: work, trimmed, ...m };
        }
    }

    // Experienced: as many pages as the career needs.
    const base = at(UNSCALED);
    if (base.pages === 1) {
        // A short one is stretched to fill its page instead of huddling at the
        // top of it.
        for (let i = 0; i < UNSCALED; i += 1) {
            const m = at(i);
            if (m.pages === 1) return { resume, trimmed: 0, ...m };
        }
        return { resume, trimmed: 0, ...base };
    }

    if (base.fill < ORPHAN_FILL) {
        // A few lines stranded on the last page: tighten until they fold back.
        for (let i = UNSCALED + 1; i < LADDER.length; i += 1) {
            const m = at(i);
            if (m.pages < base.pages) return { resume, trimmed: 0, ...m };
        }
    }
    return { resume, trimmed: 0, ...base };
};

/**
 * Render a structured resume to a PDF on disk.
 *
 * @param career  override for the detected career level (tests; a caller that
 *                already knows). Normally left out and read from the resume.
 * @returns {Promise<{storedName, absolutePath, sha256, sizeBytes, filename,
 *                    pages, level}>}
 */
export const renderResumePdf = async ({
    orgId, resume, company, title, artifactId, template = null, career = null,
}) => {
    const layout = getTemplate(template?.name ?? template);
    const baseStyle = { ...DEFAULT_STYLE, ...(layout?.style ?? {}) };
    const dir = tailoredDir(orgId);
    fs.mkdirSync(dir, { recursive: true });

    const filename = buildFilename(company, title);
    // The display name is human-readable; the name ON DISK carries the artifact
    // id, so two applications to the same company on the same day cannot
    // overwrite each other.
    const storedName = `${artifactId}_${filename}`;
    const absolutePath = path.join(dir, storedName);

    const level = career ?? careerLevel(resume);
    const fit = fitResume(resume, layout, baseStyle, level.onePage);

    await new Promise((resolve, reject) => {
        const doc = newDocument(fit.style, {
            Title: `${resume.contact?.name ?? 'Resume'} — ${title}`,
            Author: resume.contact?.name ?? '',
            Subject: `Application to ${company}`,
        });

        const stream = fs.createWriteStream(absolutePath);
        stream.on('finish', resolve);
        stream.on('error', reject);
        doc.on('error', reject);
        doc.pipe(stream);

        drawResume(doc, fit.resume, layout, fit.style);
        doc.end();
    });

    const bytes = fs.readFileSync(absolutePath);
    return {
        filename,
        storedName: path.join('tailored', storedName),
        absolutePath,
        sizeBytes: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        pages: fit.pages,
        // How full the last page is, 0–1. Not stored; it is what says whether
        // "one full page" was achieved, and what a test asserts.
        fill: fit.fill,
        level: level.level,
    };
};
