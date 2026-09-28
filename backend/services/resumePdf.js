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
};

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
const sectionHeadingS = (doc, label, st) => {
    if (doc.y > doc.page.height - doc.page.margins.bottom - 60) doc.addPage();

    doc.moveDown(st.headingGap ?? 0.6);

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

    doc.moveDown(st.afterHeadingGap ?? 0.5);
    // Back to the left margin: the band and dash variants both moved the
    // cursor, and the body that follows must not inherit their indent.
    doc.x = left;
    doc.font(fonts.regular).fontSize(st.bodySize).fillColor(st.bodyColor);
};

const bulletList = (doc, bullets, st) => {
    const align = st.justify ? 'justify' : 'left';
    for (const bullet of bullets ?? []) {
        const text = String(bullet ?? '').trim();
        if (!text) continue;
        // A real bullet character with a hanging indent — not a manually
        // spaced dash, which reflows badly and confuses list detection.
        doc.text(`• ${text}`, {
            indent: 10, align, lineGap: 1, paragraphGap: 2,
        });
    }
};

const RENDERERS = {
    summary(doc, resume, st) {
        if (!resume.summary) return;
        sectionHeadingS(doc, SECTION_LABELS.summary, st);
        doc.text(String(resume.summary).trim(), {
            align: st.justify ? 'justify' : 'left', lineGap: 1,
        });
    },

    skills(doc, resume, st) {
        const groups = (resume.skills ?? []).filter((g) => (g.items ?? []).length > 0);
        if (groups.length === 0) return;
        sectionHeadingS(doc, SECTION_LABELS.skills, st);
        const fonts = fontsFor(st);

        for (const group of groups) {
            const items = group.items.join(', ');
            const prefix = st.skillsBulleted ? '• ' : '';
            const opts = st.skillsBulleted
                ? { indent: 10, paragraphGap: 2 }
                : { paragraphGap: 2 };

            if (group.category) {
                // Label and list on one line, both as text: a parser reading
                // "Languages: Java, Python" gets the association for free.
                doc.font(fonts.bold).text(`${prefix}${group.category}: `, { ...opts, continued: true });
                doc.font(fonts.regular).text(items, opts);
            } else {
                doc.font(fonts.regular).text(`${prefix}${items}`, opts);
            }
        }
    },

    experience(doc, resume, st) {
        const roles = resume.experience ?? [];
        if (roles.length === 0) return;
        sectionHeadingS(doc, SECTION_LABELS.experience, st);
        const fonts = fontsFor(st);

        roles.forEach((role, i) => {
            if (i > 0) doc.moveDown(0.45);
            if (doc.y > doc.page.height - doc.page.margins.bottom - 80) doc.addPage();

            doc.font(fonts.bold).fontSize(st.bodySize).fillColor(st.bodyColor)
                .text(`${role.title} — ${role.company}`, { paragraphGap: 0 });

            const meta = [role.location, dateRange(role.startDate, role.endDate)]
                .filter(Boolean).join('  |  ');
            if (meta) {
                doc.font(fonts.italic).fontSize(st.bodySize - 1).fillColor('#444444')
                    .text(meta, { paragraphGap: 2 });
                doc.fillColor(st.bodyColor);
            }

            // "Roles and Responsibilities:" / "Responsibilities:" — furniture
            // inside the section, not a section of its own. Only two of the
            // three source formats carry it; the third goes straight to bullets.
            if (st.roleBulletsLabel) {
                doc.font(fonts.bold).fontSize(st.bodySize)
                    .text(st.roleBulletsLabel, { paragraphGap: 2 });
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
            if (i > 0) doc.moveDown(0.35);
            doc.font(fonts.bold).text(p.name, { paragraphGap: 0 });
            doc.font(fonts.regular);
            if (p.description) {
                doc.text(p.description, { paragraphGap: 2, align: st.justify ? 'justify' : 'left' });
            }
            bulletList(doc, p.bullets, st);
        });
    },

    education(doc, resume, st) {
        const education = resume.education ?? [];
        if (education.length === 0) return;
        sectionHeadingS(doc, SECTION_LABELS.education, st);
        const fonts = fontsFor(st);

        for (const e of education) {
            const degree = [e.degree, e.field].filter(Boolean).join(', ');
            doc.font(fonts.bold).text(e.institution, { continued: Boolean(degree) });
            if (degree) doc.font(fonts.regular).text(` — ${degree}`);

            const meta = [dateRange(e.startDate, e.endDate), e.details]
                .filter(Boolean).join('  |  ');
            if (meta) {
                doc.font(fonts.italic).fontSize(st.bodySize - 1).fillColor('#444444')
                    .text(meta, { paragraphGap: 2 });
                doc.fillColor(st.bodyColor).fontSize(st.bodySize);
            }
            doc.font(fonts.regular);
        }
    },

    certifications(doc, resume, st) {
        const certs = resume.certifications ?? [];
        if (certs.length === 0) return;
        sectionHeadingS(doc, SECTION_LABELS.certifications, st);

        bulletList(doc, certs.map((c) => [c.name, c.issuer, c.date]
            .filter(Boolean).join(' — ')), st);
    },

    additional(doc, resume, st) {
        const extra = resume.additional ?? [];
        if (extra.length === 0) return;

        for (const block of extra) {
            // The consultant's own heading is kept, uppercased to match the
            // others. Renaming their "Publications" to something generic would
            // lose information the document deliberately carried.
            sectionHeadingS(doc, String(block.heading).toUpperCase().slice(0, 60), st);
            bulletList(doc, block.items, st);
        }
    },
};

/* ── the whole document ────────────────────────────────────────────── */

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
        doc.moveDown(0.25);
        doc.font(fonts.regular).fontSize(st.bodySize).fillColor(st.bodyColor).text(line, { align });
    }

    const links = (contact?.links ?? []).filter(Boolean);
    if (links.length > 0) {
        doc.font(fonts.regular).fontSize(st.bodySize - 1)
            .text(links.join('  |  '), { align });
    }

    doc.moveDown(0.4);

    if (st.headerRule !== false) {
        const y = doc.y;
        doc.moveTo(left, y).lineTo(right, y)
            .lineWidth(st.headerRuleWidth ?? 1).strokeColor(st.ruleColor ?? '#000000').stroke();
        doc.moveDown(0.3);
    } else {
        // No rule here — the whitespace does the separating.
        doc.moveDown(0.2);
    }
    doc.x = left;
    doc.fillColor(st.bodyColor);
};

/**
 * Render a structured resume to a PDF on disk.
 *
 * Sections come out in the base resume's own order, which is what makes "keep
 * the section order" enforced rather than merely requested — the renderer never
 * consults the model about where anything goes.
 *
 * @returns {Promise<{storedName, absolutePath, sha256, sizeBytes, filename}>}
 */
export const renderResumePdf = async ({
    orgId, resume, company, title, artifactId, template = null,
}) => {
    const layout = getTemplate(template?.name ?? template);
    const style = { ...DEFAULT_STYLE, ...(layout?.style ?? {}) };
    const dir = tailoredDir(orgId);
    fs.mkdirSync(dir, { recursive: true });

    const filename = buildFilename(company, title);
    // The display name is human-readable; the name ON DISK carries the artifact
    // id, so two applications to the same company on the same day cannot
    // overwrite each other.
    const storedName = `${artifactId}_${filename}`;
    const absolutePath = path.join(dir, storedName);
    const margin = style.margin ?? DEFAULT_MARGIN;

    await new Promise((resolve, reject) => {
        const doc = new PDFDocument({
            size: 'LETTER',
            margins: {
                top: margin,
                bottom: margin,
                left: margin,
                right: margin,
            },
            info: {
                Title: `${resume.contact?.name ?? 'Resume'} — ${title}`,
                Author: resume.contact?.name ?? '',
                Subject: `Application to ${company}`,
            },
            // Compression off: it costs a few kilobytes and removes one thing
            // that can go wrong between us and an unknown parser on the far
            // side of an employer's careers page.
            compress: false,
        });

        const stream = fs.createWriteStream(absolutePath);
        stream.on('finish', resolve);
        stream.on('error', reject);
        doc.on('error', reject);
        doc.pipe(stream);

        renderHeader(doc, resume.contact, style);

        // ── WHO DECIDES THE RUNNING ORDER ─────────────────────────
        //
        // The template, when there is one — that is the whole point of having
        // templates, and it is what stops the model being able to rearrange a
        // resume by returning a different sectionOrder.
        //
        // Without a template we fall back to the order the resume itself
        // declared, which is the base resume's own order. Either way the
        // renderer decides, never the model.
        const preferred = layout?.sections?.length
            ? layout.sections
            : (resume.sectionOrder ?? []);

        const declared = preferred.filter((s) => RENDERERS[s]);
        const rest = Object.keys(RENDERERS).filter((s) => !declared.includes(s));

        for (const section of [...declared, ...rest]) {
            RENDERERS[section](doc, resume, style);
        }

        doc.end();
    });

    const bytes = fs.readFileSync(absolutePath);
    return {
        filename,
        storedName: path.join('tailored', storedName),
        absolutePath,
        sizeBytes: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    };
};
