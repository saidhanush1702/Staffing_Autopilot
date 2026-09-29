/**
 * ── HOW LONG A RESUME SHOULD BE, AND WHAT A PROJECT SHOULD SAY ────────
 *
 * Two rules about the SHAPE of a resume, kept apart from the templates (which
 * decide how a page looks) and from the model (which decides wording):
 *
 *   1. LENGTH FOLLOWS CAREER LEVEL
 *        intern · fresher · entry level   exactly ONE page, and a full one
 *        experienced                      as many pages as the career needs
 *
 *   2. A PROJECT IS EXPLAINED, NOT NAMED
 *        every project carries 3 or 4 bullet points — what it is, what it was
 *        built with, what the person did, how long and where it lives — never
 *        just a title and a year.
 *
 * Nothing here calls a model or touches the database. A page count and a bullet
 * count are facts the renderer can measure, and a rule that can be measured
 * should not be left to a prompt. The model is TOLD these limits so it writes to
 * them; this module is what makes them true even when it does not.
 *
 * Level is read from the employment history, not asked for: there is no
 * "experience level" field, and adding one would be a second thing to keep in
 * step with the history it summarises. No roles is a fresher, roles that are all
 * internships is an intern, and under two years of real work is entry level.
 * Dates are free text, so they are read tolerantly, and a role whose dates
 * cannot be read counts as a year — enough to keep an experienced person from
 * being mistaken for a fresher because a parser dropped a date, not enough to
 * promote a fresher on a guess.
 *
 * ── A THIRD RULE, THE SAME SHAPE AS THE FIRST TWO ─────────────────────
 *
 *   3. EVERY SKILL SURVIVES, AND SO DOES THE CONTACT BLOCK
 *        the tailoring prompt is told to reorder skills toward the job and
 *        never drop one — but a prompt is asked, and this is enforced. Every
 *        skill the base resume has is guaranteed present in the tailored one,
 *        relevant to the job or not, and the contact block — name, email,
 *        phone, location, every link — is never taken from anywhere but the
 *        base, on every layout, every time.
 */

export const LEVELS = {
    INTERN: 'INTERN',
    FRESHER: 'FRESHER',
    ENTRY: 'ENTRY',
    EXPERIENCED: 'EXPERIENCED',
};

/** Below this many months of non-internship work, a person is entry level. */
export const ENTRY_LEVEL_MONTHS = 24;

/** Every project gets at least this many points, and never more than the max. */
export const PROJECT_POINTS = { min: 3, max: 4 };

const INTERN_ROLE = /\b(intern(ship)?|trainee|apprentice(ship)?|co-?op|working student|student assistant)\b/i;
const STILL_GOING = /\b(present|current(ly)?|now|ongoing|till date|to date|today)\b/i;
const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * A date the way a resume writes one → { year, month } (month 1-12), or null.
 *
 * Only four-digit years are trusted; a two-digit one is a guess about the
 * century. "03/2021" and "2021-03" both read as March. A bare year has no month
 * (`month: null`) and the caller decides what that means at each end of a range.
 */
export const parseWhen = (value, now = new Date()) => {
    const text = String(value ?? '').trim();
    if (!text) return null;
    if (STILL_GOING.test(text) && !/\b(19|20)\d{2}\b/.test(text)) {
        return { year: now.getFullYear(), month: now.getMonth() + 1, ongoing: true };
    }

    const year = /\b((?:19|20)\d{2})\b/.exec(text);
    if (!year) return null;

    let month = null;
    const named = new RegExp(`\\b(${MONTH_NAMES.join('|')})[a-z]*\\b`, 'i').exec(text);
    if (named) {
        month = MONTH_NAMES.indexOf(named[1].toLowerCase()) + 1;
    } else {
        const numeric = /\b(0?[1-9]|1[0-2])\s*[/.-]\s*(?:19|20)\d{2}\b/.exec(text)
            ?? /\b(?:19|20)\d{2}\s*[/.-]\s*(0?[1-9]|1[0-2])\b/.exec(text);
        if (numeric) month = Number(numeric[1]);
    }
    return { year: Number(year[1]), month };
};

/** Months a role lasted, or null when its dates cannot be read at all. */
export const roleMonths = (role, now = new Date()) => {
    const start = parseWhen(role?.startDate, now);
    if (!start) return null;

    // No end date on a role that has a start is a role still being done: that
    // is how a current job is written far more often than a forgotten date.
    const end = parseWhen(role?.endDate, now)
        ?? { year: now.getFullYear(), month: now.getMonth() + 1, ongoing: true };

    const from = start.year * 12 + ((start.month ?? 1) - 1);
    // A year with no month at the END of a range means the year's last month:
    // "2019 – 2021" is nearly three years, not two.
    const to = end.year * 12 + ((end.month ?? 12) - 1);
    const months = to - from + 1;
    return months > 0 && months < 12 * 60 ? months : null;
};

/**
 * "11 mos", "1 yr", "1 yr 2 mos" — the period a resume shows next to a date
 * range, the way a person reads one at a glance rather than counting years
 * themselves. Null below one month, so nothing is printed for a range too
 * short or too broken to say anything true about.
 */
export const formatPeriod = (months) => {
    if (!Number.isFinite(months) || months < 1) return null;
    const yrs = Math.floor(months / 12);
    const rem = months % 12;
    if (yrs === 0) return `${rem} mo${rem === 1 ? '' : 's'}`;
    if (rem === 0) return `${yrs} yr${yrs === 1 ? '' : 's'}`;
    return `${yrs} yr${yrs === 1 ? '' : 's'} ${rem} mo${rem === 1 ? '' : 's'}`;
};

/** The period between two resume-written dates, or null when they cannot be read. */
export const periodFor = (startDate, endDate, now = new Date()) => {
    const months = roleMonths({ startDate, endDate }, now);
    return months ? formatPeriod(months) : null;
};

/**
 * The period for a PROJECT's date line, which is free text rather than two
 * separate fields — "Jan 2024 – Apr 2024" or "3 months" or "2025".
 *
 * Only a genuine two-sided range is measured. "3 months" already says its own
 * period in words, so computing one from it would either repeat it or, if the
 * text is not a date at all, print something false next to it — either way
 * worse than saying nothing. A bare year or a range with only one readable
 * side is left alone for the same reason.
 */
export const projectPeriod = (when, now = new Date()) => {
    const parts = String(when ?? '').split(/\s*[–—-]\s*/);
    if (parts.length !== 2) return null;
    return periodFor(parts[0], parts[1], now);
};

/**
 * Where a person is in their career, from the resume's own employment history.
 *
 * @returns {{level, months, onePage}} `months` counts real work only —
 *   internships tell you someone is early in their career, not how far along.
 */
export const careerLevel = (resume, now = new Date()) => {
    const roles = (resume?.experience ?? []).filter((r) => r && (r.title || r.company));

    if (roles.length === 0) return { level: LEVELS.FRESHER, months: 0, onePage: true };

    const isIntern = (r) => INTERN_ROLE.test(String(r.title ?? ''));
    const real = roles.filter((r) => !isIntern(r));

    if (real.length === 0) return { level: LEVELS.INTERN, months: 0, onePage: true };

    const months = real.reduce((sum, r) => sum + (roleMonths(r, now) ?? 12), 0);
    const level = months < ENTRY_LEVEL_MONTHS ? LEVELS.ENTRY : LEVELS.EXPERIENCED;
    return { level, months, onePage: level !== LEVELS.EXPERIENCED };
};

/**
 * The limits one template imposes on one level of career.
 *
 * A single page cannot hold what three pages can, so the caps a one-page
 * resume works to are tighter than the template's own ceilings. The model is
 * told them and `applyLimits` enforces them; the renderer's fit loop
 * (services/resumePdf.js) trims further only if the page still overflows.
 */
export const limitsFor = (template, career) => {
    const t = template ?? {};
    const onePage = career?.onePage ?? false;
    return {
        onePage,
        bulletsPerRole: onePage
            ? Math.min(t.maxBulletsPerRole ?? 4, 4)
            : (t.maxBulletsPerRole ?? 12),
        // A fresher's projects ARE their experience, so a one-page resume still
        // shows three or four of them — each explained — not one line apiece.
        projects: onePage
            ? Math.min(Math.max(t.maxProjects ?? 3, 3), 4)
            : (t.maxProjects ?? 4),
        projectPoints: PROJECT_POINTS,
    };
};

/* ── project points ────────────────────────────────────────────────── */

const normalise = (s) => String(s ?? '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Two points that say the same thing, or one that merely contains the other. */
const sameAs = (a, b) => {
    const x = normalise(a);
    const y = normalise(b);
    if (!x || !y) return false;
    return x === y || (x.length > 24 && y.includes(x)) || (y.length > 24 && x.includes(y));
};

/**
 * A paragraph → its sentences, as separate points.
 *
 * Also splits on line breaks and list markers, because people paste projects
 * in as a paragraph, as a list, or as both, and all three are the same
 * information. Abbreviations ending in a full stop are protected first so
 * "e.g. Redux" is not cut in half.
 */
export const splitSentences = (text) => {
    const shielded = String(text ?? '')
        .replace(/\b(e\.g|i\.e|etc|vs|approx|incl|inc|no)\./gi, (m) => m.replace(/\./g, '\u0000'));

    return shielded
        .split(/\r?\n+|(?:^|\s)[•▪◦●·*]\s+|(?<=[.!?])\s+(?=[A-Z0-9"'(])/)
        .map((s) => s.replace(/\u0000/g, '.').replace(/^[\s\-–—•*]+/, '').trim())
        .filter((s) => s.length >= 12);
};

/** Everything a project already says, as candidate points, without repeats. */
export const projectPointPool = (project) => {
    const pool = [];
    const add = (s) => {
        const t = String(s ?? '').trim();
        if (t && !pool.some((p) => sameAs(p, t))) pool.push(t);
    };
    for (const b of project?.bullets ?? []) add(b);
    for (const s of splitSentences(project?.description)) add(s);
    return pool;
};

/**
 * Bring every project to 3–4 points using only what the BASE says about it.
 *
 * The model is asked to write project points, and usually does. This is the
 * backstop for when it does not: it drops a bullet as "irrelevant" and leaves a
 * project with one line, or returns a bare title. Missing points are restored
 * from the base project — never invented — and anything past four is cut,
 * because a fifth point on a project is space taken from the rest of a page.
 */
export const topUpProjectPoints = (resume, base, points = PROJECT_POINTS) => {
    const baseByName = new Map((base?.projects ?? []).map((p) => [normalise(p.name), p]));

    return {
        ...resume,
        projects: (resume?.projects ?? []).map((p) => {
            const have = (p.bullets ?? []).map((b) => String(b ?? '').trim()).filter(Boolean);
            const source = baseByName.get(normalise(p.name));

            if (source && have.length < points.min) {
                for (const candidate of projectPointPool(source)) {
                    if (have.length >= points.min) break;
                    if (have.some((h) => sameAs(h, candidate))) continue;
                    have.push(candidate);
                }
            }
            return { ...p, bullets: have.slice(0, points.max) };
        }),
    };
};

/**
 * Enforce a template's ceilings on a tailored resume.
 *
 * The model is told them; this makes them true. Dropping is always safe — it is
 * the one edit the fabrication rules never object to.
 */
export const applyLimits = (resume, limits) => ({
    ...resume,
    experience: (resume?.experience ?? []).map((r) => ({
        ...r, bullets: (r.bullets ?? []).slice(0, limits.bulletsPerRole),
    })),
    projects: (resume?.projects ?? []).slice(0, limits.projects),
});

/* ── skills, in named sub-sections ─────────────────────────────────── */

/**
 * ── WHY A SKILLS SECTION IS NEVER ONE LINE ────────────────────────────
 *
 * "TECHNICAL SKILLS: Java, Python, React, MySQL, Docker, Git, AWS, Jira" is
 * every real resume's worst version of this section: a recruiter's eye and an
 * ATS's keyword match both do better with "Languages: Java, Python" on its own
 * line and "Cloud & DevOps: Docker, AWS" on the next, exactly the shape every
 * senior resume actually written by a person takes.
 *
 * A resume that already arrives with two or more named categories is left
 * exactly as it is — that IS the consultant's or the base document's own
 * organisation, and imposing a different one over it would be the renderer
 * rearranging content it has no business rearranging.
 *
 * A resume that arrives as one flat list — the common case for an uploaded
 * resume whose "Skills:" line is a single comma run, or a profile where no
 * skill was given a category — is split by a fixed, conservative taxonomy.
 * Every item keeps its own exact words; this only decides which line it
 * prints on. Anything the taxonomy does not recognise lands in "Other", never
 * dropped.
 */
const SKILL_TAXONOMY = [
    ['Languages', [
        'java', 'python', 'javascript', 'typescript', 'c', 'c++', 'c#', 'go', 'golang',
        'ruby', 'php', 'swift', 'kotlin', 'scala', 'r', 'rust', 'sql', 'html', 'html5',
        'css', 'css3', 'bash', 'shell', 'shell scripting', 'perl', 'matlab', 'dart',
        'objective-c', 'vb.net', 'pl/sql', 'plsql',
    ]],
    ['Frameworks & Libraries', [
        'react', 'react.js', 'reactjs', 'angular', 'angularjs', 'vue', 'vue.js', 'node',
        'node.js', 'nodejs', 'express', 'express.js', 'django', 'flask', 'fastapi',
        'spring', 'spring boot', '.net', 'asp.net', '.net core', 'next.js', 'nestjs',
        'redux', 'laravel', 'ruby on rails', 'rails', 'jquery', 'bootstrap', 'tailwind',
        'tailwind css', 'hibernate', 'jpa', '.net framework', 'entity framework',
    ]],
    ['Databases', [
        'mysql', 'postgresql', 'postgres', 'mongodb', 'oracle', 'sql server',
        'microsoft sql server', 'sqlite', 'redis', 'dynamodb', 'cassandra', 'mariadb',
        'firebase', 'supabase', 'elasticsearch', 'oracle db', 'snowflake', 'bigquery',
    ]],
    ['Cloud & DevOps', [
        'aws', 'amazon web services', 'azure', 'gcp', 'google cloud', 'docker',
        'kubernetes', 'jenkins', 'terraform', 'ansible', 'ci/cd', 'github actions',
        'gitlab ci', 'circleci', 'cloudformation', 'openshift', 'nginx', 'apache',
        'linux', 'unix', 'weblogic', 'tomcat', 'jboss',
    ]],
    ['Tools & Platforms', [
        'git', 'github', 'gitlab', 'bitbucket', 'jira', 'confluence', 'postman',
        'vs code', 'visual studio', 'visual studio code', 'figma', 'slack', 'trello',
        'eclipse', 'intellij', 'intellij idea', 'xcode', 'salesforce', 'servicenow',
        'sharepoint', 'power bi', 'tableau', 'excel', 'jupyter',
    ]],
    ['Testing & QA', [
        'jest', 'mocha', 'chai', 'junit', 'selenium', 'cypress', 'pytest', 'testng',
        'unit testing', 'integration testing', 'test automation', 'cucumber', 'appium',
    ]],
];

const normaliseSkill = (s) => String(s ?? '').toLowerCase().trim().replace(/\s+/g, ' ');

/**
 * Split a flat skills list into named sub-sections, or leave an already
 * organised one exactly as given.
 *
 * @returns skill groups, same shape as the resume schema's `skills` array
 */
export const categoriseSkills = (groups) => {
    const list = groups ?? [];
    const named = list.filter((g) => g?.category && (g.items ?? []).length > 0);
    const flat = list.flatMap((g) => g?.items ?? []).filter(Boolean);

    // Already organised into two or more named sections: somebody's own
    // structure, kept exactly as given.
    if (named.length >= 2) return list;
    // A short list reads fine on one line — splitting five skills into five
    // one-item categories is not an improvement.
    if (flat.length <= 6) return list;

    const buckets = new Map(SKILL_TAXONOMY.map(([name]) => [name, []]));
    const other = [];
    const seen = new Set();
    for (const item of flat) {
        const key = normaliseSkill(item);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const home = SKILL_TAXONOMY.find(([, aliases]) => aliases.includes(key));
        (home ? buckets.get(home[0]) : other).push(String(item).trim());
    }

    const result = SKILL_TAXONOMY
        .map(([name]) => ({ category: name, items: buckets.get(name) }))
        .filter((g) => g.items.length > 0);
    if (other.length > 0) result.push({ category: 'Other', items: other });
    return result;
};

/** Two category labels that are the same section, ignoring case and spacing. */
const sameCategory = (a, b) => normaliseSkill(a) === normaliseSkill(b);

/**
 * ── EVERY SKILL, ON EVERY RESUME, WHETHER THIS JOB NEEDS IT OR NOT ────
 *
 * The tailoring prompt is told to reorder skills toward a job and never
 * remove one — but a prompt is a request, and a model deciding a skill is not
 * relevant to THIS posting and quietly leaving it out is exactly the failure
 * this exists to close. Requested explicitly: a consultant's whole skill set
 * appears on every tailored resume, for every job, whether or not that job
 * happens to want each one.
 *
 * Anything from the base that made it into the tailored list, under any
 * spelling PDFKit would treat as the same word, is left where the model put
 * it — a reordering toward the job is exactly what tailoring is for. Anything
 * missing is put back into the category it came from, if that category
 * still exists in the tailored list, or as a category of its own if not —
 * never invented text, never merged into a bucket it did not come from.
 *
 * @returns skill groups with nothing from `base` missing
 */
export const restoreMissingSkills = (tailoredSkills, baseSkills) => {
    const tailored = (tailoredSkills ?? [])
        .map((g) => ({ category: g?.category ?? null, items: [...(g?.items ?? [])] }));
    const present = new Set(tailored.flatMap((g) => g.items.map(normaliseSkill)));

    for (const group of baseSkills ?? []) {
        for (const skill of group?.items ?? []) {
            const key = normaliseSkill(skill);
            if (!key || present.has(key)) continue;
            present.add(key);

            const home = tailored.find((g) => sameCategory(g.category, group.category));
            if (home) home.items.push(skill);
            else tailored.push({ category: group.category ?? null, items: [skill] });
        }
    }
    return tailored;
};

/**
 * Everything the pipeline calls after the model has answered.
 *
 * @param resume  the tailored resume
 * @param base    the base sections it was tailored from
 */
export const shapeTailored = (resume, base, template) => {
    const career = careerLevel(base);
    const limits = limitsFor(template, career);

    const restored = {
        ...resume,
        // The prompt says "keep the contact block byte-for-byte identical" —
        // this is what makes that true rather than merely asked for. Name,
        // email, phone, location, every link (LinkedIn, GitHub, portfolio) —
        // none of it is job-specific, so none of it is ever taken from
        // anywhere but the base, on any layout, on any job.
        contact: base?.contact ?? resume?.contact,
        skills: restoreMissingSkills(resume?.skills, base?.skills),
    };
    return applyLimits(topUpProjectPoints(restored, base, limits.projectPoints), limits);
};
