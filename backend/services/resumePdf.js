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
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import PDFDocument from 'pdfkit';
import { UPLOAD_ROOT } from '../utils/upload.js';

/** Where tailored files live — deliberately not beside the base resumes. */
export const tailoredDir = (orgId) => path.join(UPLOAD_ROOT, orgId, 'tailored');

const PAGE_MARGIN = 54;          // 0.75in — generous enough not to look cramped
const RULE_COLOUR = '#999999';
const BODY = 10;
const HEADING = 11;
const NAME = 18;

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

const sectionHeading = (doc, label) => {
    if (doc.y > doc.page.height - doc.page.margins.bottom - 60) doc.addPage();

    doc.moveDown(0.6);
    doc.font('Helvetica-Bold').fontSize(HEADING).fillColor('#000000')
        .text(label, { characterSpacing: 0.6 });

    // A hairline rule, drawn rather than typed. A row of dashes would be read
    // as text and land in the middle of the extracted content.
    const y = doc.y + 2;
    doc.moveTo(doc.page.margins.left, y)
        .lineTo(doc.page.width - doc.page.margins.right, y)
        .lineWidth(0.5).strokeColor(RULE_COLOUR).stroke();

    doc.moveDown(0.5);
    doc.font('Helvetica').fontSize(BODY).fillColor('#000000');
};

const bulletList = (doc, bullets) => {
    for (const bullet of bullets ?? []) {
        const text = String(bullet ?? '').trim();
        if (!text) continue;
        // A real bullet character with a hanging indent — not a manually
        // spaced dash, which reflows badly and confuses list detection.
        doc.text(`• ${text}`, {
            indent: 10, align: 'left', lineGap: 1, paragraphGap: 2,
        });
    }
};

const RENDERERS = {
    summary(doc, resume) {
        if (!resume.summary) return;
        sectionHeading(doc, SECTION_LABELS.summary);
        doc.text(String(resume.summary).trim(), { align: 'left', lineGap: 1 });
    },

    skills(doc, resume) {
        const groups = (resume.skills ?? []).filter((g) => (g.items ?? []).length > 0);
        if (groups.length === 0) return;
        sectionHeading(doc, SECTION_LABELS.skills);

        for (const group of groups) {
            const items = group.items.join(', ');
            if (group.category) {
                // Label and list on one line, both as text: a parser reading
                // "Languages: Java, Python" gets the association for free.
                doc.font('Helvetica-Bold').text(`${group.category}: `, { continued: true });
                doc.font('Helvetica').text(items, { paragraphGap: 2 });
            } else {
                doc.font('Helvetica').text(items, { paragraphGap: 2 });
            }
        }
    },

    experience(doc, resume) {
        const roles = resume.experience ?? [];
        if (roles.length === 0) return;
        sectionHeading(doc, SECTION_LABELS.experience);

        roles.forEach((role, i) => {
            if (i > 0) doc.moveDown(0.45);
            if (doc.y > doc.page.height - doc.page.margins.bottom - 80) doc.addPage();

            doc.font('Helvetica-Bold').fontSize(BODY)
                .text(`${role.title} — ${role.company}`, { paragraphGap: 0 });

            const meta = [role.location, dateRange(role.startDate, role.endDate)]
                .filter(Boolean).join('  |  ');
            if (meta) {
                doc.font('Helvetica-Oblique').fontSize(BODY - 1).fillColor('#444444')
                    .text(meta, { paragraphGap: 2 });
                doc.fillColor('#000000');
            }

            doc.font('Helvetica').fontSize(BODY);
            bulletList(doc, role.bullets);
        });
    },

    projects(doc, resume) {
        const projects = resume.projects ?? [];
        if (projects.length === 0) return;
        sectionHeading(doc, SECTION_LABELS.projects);

        projects.forEach((p, i) => {
            if (i > 0) doc.moveDown(0.35);
            doc.font('Helvetica-Bold').text(p.name, { paragraphGap: 0 });
            doc.font('Helvetica');
            if (p.description) doc.text(p.description, { paragraphGap: 2 });
            bulletList(doc, p.bullets);
        });
    },

    education(doc, resume) {
        const education = resume.education ?? [];
        if (education.length === 0) return;
        sectionHeading(doc, SECTION_LABELS.education);

        for (const e of education) {
            const degree = [e.degree, e.field].filter(Boolean).join(', ');
            doc.font('Helvetica-Bold').text(e.institution, { continued: Boolean(degree) });
            if (degree) doc.font('Helvetica').text(` — ${degree}`);

            const meta = [dateRange(e.startDate, e.endDate), e.details]
                .filter(Boolean).join('  |  ');
            if (meta) {
                doc.font('Helvetica-Oblique').fontSize(BODY - 1).fillColor('#444444')
                    .text(meta, { paragraphGap: 2 });
                doc.fillColor('#000000').fontSize(BODY);
            }
            doc.font('Helvetica');
        }
    },

    certifications(doc, resume) {
        const certs = resume.certifications ?? [];
        if (certs.length === 0) return;
        sectionHeading(doc, SECTION_LABELS.certifications);

        bulletList(doc, certs.map((c) => [c.name, c.issuer, c.date]
            .filter(Boolean).join(' — ')));
    },

    additional(doc, resume) {
        const extra = resume.additional ?? [];
        if (extra.length === 0) return;

        for (const block of extra) {
            // The consultant's own heading is kept, uppercased to match the
            // others. Renaming their "Publications" to something generic would
            // lose information the document deliberately carried.
            sectionHeading(doc, String(block.heading).toUpperCase().slice(0, 60));
            bulletList(doc, block.items);
        }
    },
};

/* ── the whole document ────────────────────────────────────────────── */

const renderHeader = (doc, contact) => {
    doc.font('Helvetica-Bold').fontSize(NAME).fillColor('#000000')
        .text(contact?.name ?? '', { align: 'center' });

    // Contact details as plain text on one line, labelled by their own
    // punctuation. Icons would carry none of this into the extracted text.
    const line = [contact?.location, contact?.phone, contact?.email]
        .filter(Boolean).join('  |  ');
    if (line) {
        doc.moveDown(0.25);
        doc.font('Helvetica').fontSize(BODY).text(line, { align: 'center' });
    }

    const links = (contact?.links ?? []).filter(Boolean);
    if (links.length > 0) {
        doc.font('Helvetica').fontSize(BODY - 1)
            .text(links.join('  |  '), { align: 'center' });
    }

    doc.moveDown(0.4);
    const y = doc.y;
    doc.moveTo(doc.page.margins.left, y)
        .lineTo(doc.page.width - doc.page.margins.right, y)
        .lineWidth(1).strokeColor('#000000').stroke();
    doc.moveDown(0.3);
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
export const renderResumePdf = async ({ orgId, resume, company, title, artifactId }) => {
    const dir = tailoredDir(orgId);
    fs.mkdirSync(dir, { recursive: true });

    const filename = buildFilename(company, title);
    // The display name is human-readable; the name ON DISK carries the artifact
    // id, so two applications to the same company on the same day cannot
    // overwrite each other.
    const storedName = `${artifactId}_${filename}`;
    const absolutePath = path.join(dir, storedName);

    await new Promise((resolve, reject) => {
        const doc = new PDFDocument({
            size: 'LETTER',
            margins: {
                top: PAGE_MARGIN,
                bottom: PAGE_MARGIN,
                left: PAGE_MARGIN,
                right: PAGE_MARGIN,
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

        renderHeader(doc, resume.contact);

        // Their order, then anything they had that the order forgot to mention.
        const declared = (resume.sectionOrder ?? []).filter((s) => RENDERERS[s]);
        const rest = Object.keys(RENDERERS).filter((s) => !declared.includes(s));

        for (const section of [...declared, ...rest]) {
            RENDERERS[section](doc, resume);
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
