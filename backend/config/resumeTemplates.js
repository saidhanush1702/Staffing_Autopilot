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
 * ── HOW THE THREE ACTUALLY DIFFER ─────────────────────────────────────
 *
 *                 CLASSIC          TECHNICAL         ENTRY_LEVEL
 *   name          centred          left              centred, larger
 *   header rule   full width       thin              none — space instead
 *   headings      hairline under   accent dash       shaded strip
 *   density       roomy            tight             open
 *   leads with    experience       skills, projects  education, projects
 *
 * ── WHY ALL THREE ARE STILL SINGLE-COLUMN ─────────────────────────────
 *
 * Because every one has to survive an applicant tracking system, and two
 * columns are the single most reliable way to make a resume unreadable to one
 * — the parser reads across, so a sidebar's first line lands in the middle of
 * the first body line and both become nonsense.
 *
 * Everything in the table above is safe under that constraint: a rule is a
 * drawn line, a shaded strip is a drawn rectangle with real text on top, and
 * alignment is alignment. A parser pulls identical words out of all three. The
 * devices that would make them look MORE different — sidebars, tables, icons,
 * text boxes — are exactly the devices that would cost the consultant the
 * interview, so they are not on the table at any price.
 */

export const DEFAULT_TEMPLATE = 'CLASSIC';

/**
 * `sections` is the order the renderer draws in, and the order the model is
 * told to think in. A section absent from the list is not drawn at all.
 *
 * `emphasis` is guidance passed to the model — which sections carry the weight
 * for this shape of candidate. It changes wording and selection, never facts.
 */
export const TEMPLATES = {
    /**
     * The default, and the right answer for most people.
     *
     * Employment history first and in reverse order, which is what a recruiter
     * scanning for "what have they done lately" is looking for, and what every
     * applicant tracking system is tuned to read.
     */
    CLASSIC: {
        name: 'CLASSIC',
        label: 'Classic chronological',
        description:
            'Work history first, most recent at the top. The layout recruiters '
            + 'and applicant tracking systems expect. Best for anyone with two '
            + 'or more years of experience.',
        sections: ['summary', 'skills', 'experience', 'projects', 'education', 'certifications', 'additional'],
        emphasis: ['experience'],
        // How many bullets a role may carry. A ceiling rather than a target:
        // the model drops the least relevant, it never invents more.
        maxBulletsPerRole: 6,
        maxProjects: 3,
        style: {
            headingSize: 11,
            bodySize: 10,
            nameSize: 18,
            // The conventional resume: name over the middle, a firm rule under
            // it, and a hairline under every heading.
            headerAlign: 'center',
            headerRule: true,
            headerRuleWidth: 1,
            headingStyle: 'rule',
            headingGap: 0.6,
            afterHeadingGap: 0.5,
        },
    },

    /**
     * For engineers whose skills and shipped work matter more than the logos
     * on their employment history — contractors, specialists, anyone whose
     * last three roles were all the same title.
     */
    TECHNICAL: {
        name: 'TECHNICAL',
        label: 'Technical, skills first',
        description:
            'Skills and projects lead, work history follows. Best for hands-on '
            + 'engineers, contractors and specialists where the stack matters '
            + 'more than the job titles.',
        sections: ['summary', 'skills', 'projects', 'experience', 'certifications', 'education', 'additional'],
        emphasis: ['skills', 'projects'],
        maxBulletsPerRole: 5,
        maxProjects: 5,
        style: {
            headingSize: 10.5,
            bodySize: 9.5,
            nameSize: 17,
            // Set left and run tight. No full-width rules anywhere — each
            // heading gets a short accent dash instead, which reads as denser
            // and buys back the space a skills-and-projects resume needs.
            headerAlign: 'left',
            headerRule: true,
            headerRuleWidth: 0.5,
            headingStyle: 'plain',
            headingGap: 0.45,
            afterHeadingGap: 0.35,
        },
    },

    /**
     * For freshers and career changers.
     *
     * Education first because it is the strongest thing they have, and
     * projects above employment because a graduate's projects are their
     * evidence. The empty-experience case is normal here rather than a
     * failure, which is exactly why this template exists.
     */
    ENTRY_LEVEL: {
        name: 'ENTRY_LEVEL',
        label: 'Entry level / fresher',
        description:
            'Education and projects lead, work history last. Best for recent '
            + 'graduates and career changers, where coursework and personal '
            + 'projects are the real evidence.',
        sections: ['summary', 'education', 'skills', 'projects', 'certifications', 'experience', 'additional'],
        emphasis: ['education', 'projects'],
        maxBulletsPerRole: 4,
        maxProjects: 6,
        style: {
            headingSize: 11,
            bodySize: 10,
            nameSize: 20,
            // A bigger name and no rule under it — a graduate's page has less
            // on it, so the whitespace is doing the separating. Headings sit in
            // a shaded strip, which gives an otherwise sparse page some
            // structure without adding anything a parser cannot read.
            headerAlign: 'center',
            headerRule: false,
            headingStyle: 'band',
            headingGap: 0.75,
            afterHeadingGap: 0.55,
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
        headerAlign: TEMPLATES[name].style.headerAlign,
        headerRule: TEMPLATES[name].style.headerRule,
        headingStyle: TEMPLATES[name].style.headingStyle,
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
export const describeTemplate = (template) => {
    const t = getTemplate(template?.name ?? template);
    return `TEMPLATE: ${t.label}
Sections, in the order they will be printed:
${t.sections.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}

This template gives the most weight to: ${t.emphasis.join(' and ')}.
Lead with what is most relevant to those sections.

Limits: at most ${t.maxBulletsPerRole} bullet points per role, and at most
${t.maxProjects} projects. If there are more than that, keep the ones most
relevant to this job and drop the rest — dropping is always allowed, adding
never is.`;
};
