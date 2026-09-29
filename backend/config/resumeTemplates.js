/**
 * ── THE RESUME TEMPLATES ──────────────────────────────────────────────
 *
 * Three layouts, one chosen per agency. A template decides WHERE things go and
 * WHAT GETS EMPHASISED — it never decides what is true.
 *
 * ── WHY A TEMPLATE IS DATA AND NOT MARKUP ─────────────────────────────
 *
 * The model is told which template is in use and which sections it has, and it
 * returns CONTENT — reworded bullets, a reordered skill list, a summary aimed
 * at this job. Our renderer then draws that content into the template.
 *
 * The alternative — handing the model an HTML template and asking for a filled
 * document back — puts layout in the model's hands. Spacing, page breaks and
 * the ATS-safety rules would then vary from run to run, silently, and the
 * tokens spent carrying markup in and out would be three or four times what
 * the content itself costs. Here the layout is code: it is identical on every
 * run, and the model cannot break it because it never sees it.
 *
 * ── WHERE THESE THREE CAME FROM ────────────────────────────────────────
 *
 * Not invented — traced from three resumes actual consultants were placed
 * with, the kind of document a staffing bench really produces: dense,
 * bullet-heavy, built to survive both a recruiter's skim and an applicant
 * tracking system's parse. Each template below reproduces one of them —
 * its font, its heading treatment, its bullet density, its running order —
 * as closely as a single-column, table-free page can.
 *
 * ── HOW THE THREE ACTUALLY DIFFER ─────────────────────────────────────
 *
 *                 CLASSIC              TECHNICAL            MODERN
 *   font          serif (Times)        sans (Helvetica)     sans (Helvetica)
 *   margins       0.5"  — dense        1"    — roomy         0.55" — compact
 *   body align    justified            justified             left
 *   headings      bold + underlined    bold label, plain     bold, coloured
 *                 "Heading:"           "Heading:"            rule underneath
 *   role sub-head "Roles and           "Responsibilities:"   none — bullets
 *                 Responsibilities:"                          follow the date
 *   bullets/role  up to 14             up to 12              up to 6
 *   accent colour none (black only)    none (black only)     navy #0C2340
 *
 * ── WHY ALL THREE ARE STILL SINGLE-COLUMN, TABLE-FREE ─────────────────
 *
 * Because every one has to survive an applicant tracking system, and two
 * columns — or a real multi-column table — are the single most reliable way
 * to make a resume unreadable to one: the parser reads across, so a sidebar's
 * first line lands in the middle of the first body line and both become
 * nonsense. One of the three source documents used an actual Word table for
 * its skills grid; the renderer reproduces the READING result (a bold
 * category followed by its items, one line each) rather than the table
 * itself, which is what a parser sees anyway once Word's own text extraction
 * runs — so nothing about the look is lost and nothing about the safety is
 * given up.
 */

import { limitsFor } from './resumeLayout.js';

export const DEFAULT_TEMPLATE = 'CLASSIC';

/**
 * `sections` is the order the renderer draws in, and the order the model is
 * told to think in. A section absent from the list is not drawn at all.
 *
 * `emphasis` is guidance passed to the model — which sections carry the weight
 * for this shape of candidate. It changes wording and selection, never facts.
 *
 * `style.roleBulletsLabel`, when set, is a bold sub-heading the renderer
 * prints between a role's date line and its bullets — "Roles and
 * Responsibilities:" is not a section, it is furniture inside the experience
 * section, and it is exactly what two of the three source resumes did.
 */
export const TEMPLATES = {
    /**
     * Traced from a nine-year solution architect's resume: dense, formal,
     * serif, every heading underlined. The format a long, cert-heavy IT
     * career gets written in — it says everything and trusts the reader to
     * skim, rather than trimming to a page.
     */
    CLASSIC: {
        name: 'CLASSIC',
        label: 'Classic dense (serif)',
        description:
            'Times New Roman, justified, bold-underlined headings, narrow 0.5" '
            + 'margins. Work history first with long, detailed bullet lists per '
            + 'role. The dense, formal format for a long, certification-heavy '
            + 'career where the point is to say everything.',
        sections: ['summary', 'skills', 'certifications', 'experience', 'projects', 'education', 'additional'],
        emphasis: ['experience', 'skills'],
        // A ceiling, not a target — long enough that a senior consultant's
        // real bullet count is rarely the thing trimmed.
        maxBulletsPerRole: 14,
        maxProjects: 3,
        style: {
            fontFamily: 'times',
            // 0.5" — the narrowest of the three, which is most of why this
            // one reads as denser than the others at the same body size.
            margin: 36,
            headingSize: 11.5,
            bodySize: 10.5,
            nameSize: 18,
            justify: true,
            // A left-set stack of name / phone / email / title, the way a
            // letterhead reads — not centred, which is the technical
            // template's move.
            headerAlign: 'left',
            headerRule: true,
            headerRuleWidth: 1,
            // Bold, underlined, colon-suffixed — no drawn rule, no shading.
            headingStyle: 'underline',
            headingGap: 0.5,
            afterHeadingGap: 0.35,
            roleBulletsLabel: 'Roles and Responsibilities:',
        },
    },

    /**
     * Traced from a production-support engineer's resume: sans-serif, one
     * roomy inch of margin on every side, skills bulleted right after the
     * summary. Built for someone whose stack — Kubernetes, WebLogic, AWS —
     * is the headline, and whose work history is a long string of similar
     * production-support roles.
     */
    TECHNICAL: {
        name: 'TECHNICAL',
        label: 'Technical, skills-forward (sans)',
        description:
            'Arial, justified, plain bold headings, a full 1" margin. Skills '
            + 'bulleted right after the summary, education and certifications '
            + 'ahead of the work history. Best for infrastructure, support and '
            + 'platform engineers whose stack is the headline.',
        sections: ['summary', 'skills', 'education', 'certifications', 'experience', 'projects', 'additional'],
        emphasis: ['skills', 'experience'],
        maxBulletsPerRole: 12,
        maxProjects: 4,
        style: {
            fontFamily: 'helvetica',
            // 1" — the roomiest of the three.
            margin: 72,
            headingSize: 11,
            bodySize: 10,
            nameSize: 16,
            justify: true,
            headerAlign: 'left',
            headerRule: true,
            headerRuleWidth: 0.75,
            // Bold heading text with a trailing colon — no underline, no
            // rule, no shading. The plainest of the three.
            headingStyle: 'label',
            headingGap: 0.5,
            afterHeadingGap: 0.35,
            roleBulletsLabel: 'Responsibilities:',
            // Each skill line gets a bullet marker ahead of it, unlike the
            // other two templates.
            skillsBulleted: true,
        },
    },

    /**
     * Traced from a Salesforce developer's resume: compact, sans-serif, a
     * navy accent colour on the name and every heading rule. Built for two
     * to five years of experience where the page is meant to look current —
     * tight spacing, small type, quantified bullets, nothing wasted.
     */
    MODERN: {
        name: 'MODERN',
        label: 'Modern compact (colour accent)',
        description:
            'Arial, left-aligned, compact spacing, a navy rule under every '
            + 'heading. Summary, skills and experience lead; short, '
            + 'quantified bullets. Best for two to five years of experience, '
            + 'where the page needs to read as current and tightly edited.',
        sections: ['summary', 'skills', 'experience', 'projects', 'certifications', 'education', 'additional'],
        emphasis: ['summary', 'experience'],
        // A hard ceiling on purpose — this template is built to stay tight,
        // not to grow with the role.
        maxBulletsPerRole: 6,
        maxProjects: 3,
        style: {
            fontFamily: 'helvetica',
            // ~0.6" — tight, which is what lets the compact spacing below
            // still read as generous rather than cramped.
            margin: 42,
            headingSize: 10.5,
            bodySize: 9.5,
            nameSize: 19,
            justify: false,
            headerAlign: 'center',
            headerRule: true,
            headerRuleWidth: 1.2,
            // Bold heading with a thin coloured rule underneath — the only
            // template of the three that draws a colour anywhere.
            headingStyle: 'rule',
            headingColor: '#0C2340',
            ruleColor: '#0C2340',
            nameColor: '#0C2340',
            bodyColor: '#262626',
            headingGap: 0.4,
            afterHeadingGap: 0.25,
            // Bullets follow the date line directly — no sub-heading.
            roleBulletsLabel: null,
        },
    },
};

export const TEMPLATE_NAMES = Object.keys(TEMPLATES);

/** Never returns undefined — an unknown or missing name falls back to the default. */
export const getTemplate = (name) => TEMPLATES[String(name ?? '').toUpperCase()]
    ?? TEMPLATES[DEFAULT_TEMPLATE];

/** What an admin needs to choose between them, without the internals. */
export const templateOptions = () => TEMPLATE_NAMES.map((name) => ({
    name,
    label: TEMPLATES[name].label,
    description: TEMPLATES[name].description,
    sections: TEMPLATES[name].sections,
    // The preview highlights these, so an admin can see at a glance where a
    // template puts the weight rather than inferring it from the order.
    emphasis: TEMPLATES[name].emphasis,
    // The layout knobs the thumbnail mirrors. Sent rather than duplicated in
    // the client so the preview cannot drift into showing a page the renderer
    // does not actually produce.
    style: {
        fontFamily: TEMPLATES[name].style.fontFamily,
        headerAlign: TEMPLATES[name].style.headerAlign,
        headerRule: TEMPLATES[name].style.headerRule,
        headerRuleWidth: TEMPLATES[name].style.headerRuleWidth,
        headingStyle: TEMPLATES[name].style.headingStyle,
        headingColor: TEMPLATES[name].style.headingColor,
        nameColor: TEMPLATES[name].style.nameColor,
    },
    isDefault: name === DEFAULT_TEMPLATE,
}));

/**
 * The template, described to the model.
 *
 * Deliberately short. The model needs to know the running order and where the
 * weight falls so it can decide what to lead a bullet with and which skills to
 * surface. It does not need — and must not be given — the styling, because
 * anything it knows about the layout is something it can try to control.
 */
export const describeTemplate = (template, career = null) => {
    const t = getTemplate(template?.name ?? template);
    const limits = limitsFor(t, career);

    // Only said when the level is known. A one-page resume has to be written
    // tighter than a three-page one, and the model can only do that if it is
    // told which it is writing.
    const length = career
        ? (limits.onePage
            ? `\n\nCAREER LEVEL: ${career.level}. This resume is printed on exactly ONE page, so
write tight: short, complete points, nothing padded. Projects are a main part
of this candidate's experience — keep ${limits.projects} of the most relevant
and explain each properly.`
            : `\n\nCAREER LEVEL: ${career.level}. This resume runs to more than one page, so
experience carries the weight; keep every role's real work, most relevant first.`)
        : '';

    return `TEMPLATE: ${t.label}
Sections, in the order they will be printed:
${t.sections.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}

This template gives the most weight to: ${t.emphasis.join(' and ')}.
Lead with what is most relevant to those sections.${length}

Limits: at most ${limits.bulletsPerRole} bullet points per role, and at most
${limits.projects} projects, each with 3 or 4 points. If there are more than
that, keep the ones most relevant to this job and drop the rest — dropping is
always allowed, adding never is (except explaining a project from its own facts).`;
};
