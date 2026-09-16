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
 * ── WHY ALL THREE ARE SINGLE-COLUMN ───────────────────────────────────
 *
 * Because every one of them has to survive an applicant tracking system, and
 * two columns are the single most reliable way to make a resume unreadable to
 * one — the parser reads across, so a sidebar's first line lands in the middle
 * of the first body line and both become nonsense. The templates differ in
 * ORDER and EMPHASIS, which is what actually changes how a resume reads, and
 * not in devices that would cost the consultant an interview.
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
            accentRule: true,
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
            headingSize: 11,
            bodySize: 9.5,
            nameSize: 17,
            accentRule: true,
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
            nameSize: 18,
            accentRule: true,
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
