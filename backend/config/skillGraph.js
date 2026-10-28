/**
 * ── WHAT A SKILL MEANS FOR ANOTHER SKILL ──────────────────────────────
 *
 * The v1 matcher compared a job's title against the titles a consultant said
 * they wanted. It never looked at what the person can DO. A React developer was
 * therefore rejected for a "Frontend Developer" role that asked for React,
 * Tailwind and responsive design — a perfect fit, scored 57 of a needed 70
 * because the word "frontend" is in none of their titles.
 *
 * This is the vocabulary that lets the matcher reason about that:
 *
 *   ALIASES   many spellings, one skill ("ReactJS", "React.js" → react)
 *   IMPLIES   knowing A means knowing B            react → javascript, frontend
 *   RELATED   close enough to pick up quickly      css → tailwind
 *
 * ── HOW CREDIT WORKS ──────────────────────────────────────────────────
 *
 * Every consultant skill is worth 1.0 toward itself. A skill reached through
 * IMPLIES is worth 0.8, through RELATED 0.5, and a path of two steps multiplies
 * (react → css 0.8, css → tailwind 0.5 gives tailwind 0.4). Never more than two
 * steps: three hops is a rumour, not a skill.
 *
 * ── WRITTEN BY HAND, DELIBERATELY ─────────────────────────────────────
 *
 * Every edge here is a statement a recruiter could disagree with, so it is
 * data in a file that is reviewed, tested and versioned — not something a model
 * decides per job. Nothing here invents a skill a consultant did not list: it
 * only says what a listed skill already covers.
 */

/** canonical → the spellings that mean it. Lowercase; punctuation matters. */
const ALIASES = {
    javascript: ['javascript', 'js', 'es6', 'ecmascript', 'vanilla js'],
    typescript: ['typescript', 'ts'],
    react: ['react', 'reactjs', 'react.js', 'react js'],
    redux: ['redux', 'redux toolkit'],
    nextjs: ['next.js', 'nextjs', 'next js'],
    angular: ['angular', 'angularjs', 'angular.js'],
    vue: ['vue', 'vuejs', 'vue.js'],
    html: ['html', 'html5'],
    css: ['css', 'css3'],
    sass: ['sass', 'scss'],
    tailwind: ['tailwind', 'tailwindcss', 'tailwind css'],
    bootstrap: ['bootstrap'],
    'material-ui': ['material ui', 'material-ui', 'mui'],
    jquery: ['jquery'],
    webpack: ['webpack'],
    frontend: ['frontend', 'front end', 'front-end', 'ui development', 'ui', 'web ui', 'user interface'],
    responsive: ['responsive', 'responsive design', 'responsive web design', 'responsiveness', 'mobile-first', 'cross-browser'],

    node: ['node', 'nodejs', 'node.js', 'node js'],
    express: ['express.js', 'expressjs', 'express js'],
    nestjs: ['nestjs', 'nest.js'],
    python: ['python'],
    django: ['django'],
    flask: ['flask'],
    fastapi: ['fastapi'],
    java: ['java'],
    spring: ['spring boot', 'springboot', 'spring framework', 'spring mvc'],
    dotnet: ['.net', 'dotnet', '.net core', 'asp.net', 'aspnet'],
    csharp: ['c#', 'csharp'],
    go: ['golang'],
    ruby: ['ruby'],
    rails: ['ruby on rails', 'rails'],
    php: ['php'],
    laravel: ['laravel'],
    rest: ['rest api', 'rest apis', 'restful', 'restful api', 'restful apis', 'rest'],
    graphql: ['graphql'],
    microservices: ['microservices', 'micro-services'],
    backend: ['backend', 'back end', 'back-end', 'server-side'],

    sql: ['sql'],
    mysql: ['mysql'],
    postgresql: ['postgresql', 'postgres', 'postgre sql'],
    mongodb: ['mongodb', 'mongo db', 'mongo'],
    redis: ['redis'],
    nosql: ['nosql', 'no-sql'],
    oracle: ['oracle db', 'oracle database', 'pl/sql'],
    sqlserver: ['sql server', 'mssql', 'ms sql', 't-sql'],
    kafka: ['kafka'],
    spark: ['spark', 'pyspark'],
    airflow: ['airflow'],
    etl: ['etl', 'elt'],
    snowflake: ['snowflake'],
    database: ['database', 'databases'],

    devops: ['devops', 'dev ops'],
    docker: ['docker', 'containers', 'containerization'],
    kubernetes: ['kubernetes', 'k8s'],
    terraform: ['terraform'],
    ansible: ['ansible'],
    jenkins: ['jenkins'],
    cicd: ['ci/cd', 'cicd', 'ci cd', 'continuous integration', 'continuous delivery', 'continuous deployment'],
    'github-actions': ['github actions'],
    'gitlab-ci': ['gitlab ci', 'gitlab-ci'],
    git: ['git'],
    github: ['github'],
    gitlab: ['gitlab'],
    linux: ['linux'],
    bash: ['bash', 'shell scripting'],

    aws: ['aws', 'amazon web services'],
    azure: ['azure'],
    gcp: ['gcp', 'google cloud', 'google cloud platform'],
    lambda: ['aws lambda', 'serverless'],
    cloud: ['cloud'],

    reactnative: ['react native'],
    flutter: ['flutter'],
    swift: ['swift'],
    kotlin: ['kotlin'],
    android: ['android'],
    ios: ['ios'],
    mobile: ['mobile'],

    testing: ['unit testing', 'test automation', 'qa', 'testing'],
    selenium: ['selenium'],
    cypress: ['cypress'],
    jest: ['jest'],
};

/** Display names, for the reasons a recruiter reads. */
const LABEL = {
    javascript: 'JavaScript', typescript: 'TypeScript', react: 'React', nextjs: 'Next.js',
    nestjs: 'NestJS', node: 'Node.js', dotnet: '.NET', csharp: 'C#', mongodb: 'MongoDB',
    postgresql: 'PostgreSQL', sqlserver: 'SQL Server', cicd: 'CI/CD', 'github-actions': 'GitHub Actions',
    'gitlab-ci': 'GitLab CI', aws: 'AWS', gcp: 'GCP', css: 'CSS', html: 'HTML', sql: 'SQL', nosql: 'NoSQL',
    graphql: 'GraphQL', devops: 'DevOps', ios: 'iOS', reactnative: 'React Native', tailwind: 'Tailwind CSS',
    'material-ui': 'Material UI', etl: 'ETL', rest: 'REST', jquery: 'jQuery', fastapi: 'FastAPI',
    github: 'GitHub', gitlab: 'GitLab', frontend: 'Frontend', backend: 'Backend', responsive: 'Responsive design',
    mysql: 'MySQL', php: 'PHP', spring: 'Spring', go: 'Go', express: 'Express', lambda: 'AWS Lambda',
};
export const labelOf = (skill) => LABEL[skill]
    ?? (skill.charAt(0).toUpperCase() + skill.slice(1));

const IMPLY = 0.8;
const RELATE = 0.5;

/** knowing KEY means knowing each of VALUE */
const IMPLIES = {
    react: ['javascript', 'frontend', 'html', 'css'],
    redux: ['react', 'javascript'],
    nextjs: ['react', 'javascript', 'frontend'],
    angular: ['typescript', 'javascript', 'frontend', 'html', 'css'],
    vue: ['javascript', 'frontend', 'html', 'css'],
    typescript: ['javascript'],
    tailwind: ['css', 'frontend'],
    bootstrap: ['css', 'frontend', 'responsive'],
    sass: ['css'],
    'material-ui': ['react', 'css', 'frontend'],
    jquery: ['javascript', 'frontend'],
    frontend: ['html', 'css', 'responsive'],
    css: ['responsive'],

    node: ['javascript', 'backend', 'rest'],
    express: ['node', 'backend', 'rest'],
    nestjs: ['node', 'typescript', 'backend'],
    django: ['python', 'backend', 'rest'],
    flask: ['python', 'backend'],
    fastapi: ['python', 'backend', 'rest'],
    spring: ['java', 'backend', 'rest'],
    dotnet: ['csharp', 'backend'],
    rails: ['ruby', 'backend'],
    laravel: ['php', 'backend'],
    graphql: ['backend'],
    microservices: ['backend'],

    mysql: ['sql', 'database'],
    postgresql: ['sql', 'database'],
    sqlserver: ['sql', 'database'],
    oracle: ['sql', 'database'],
    mongodb: ['nosql', 'database'],
    redis: ['nosql', 'database'],
    sql: ['database'],
    nosql: ['database'],
    spark: ['etl'],
    airflow: ['etl'],
    snowflake: ['sql'],

    kubernetes: ['docker', 'devops'],
    docker: ['devops'],
    terraform: ['devops', 'cloud'],
    ansible: ['devops'],
    jenkins: ['cicd', 'devops'],
    'github-actions': ['cicd', 'devops', 'github'],
    'gitlab-ci': ['cicd', 'devops', 'gitlab'],
    cicd: ['devops'],
    github: ['git'],
    gitlab: ['git'],

    aws: ['cloud'],
    azure: ['cloud'],
    gcp: ['cloud'],
    lambda: ['aws', 'cloud'],

    reactnative: ['react', 'javascript', 'mobile'],
    flutter: ['mobile'],
    swift: ['ios', 'mobile'],
    kotlin: ['android', 'mobile'],
    android: ['mobile'],
    ios: ['mobile'],

    selenium: ['testing'],
    cypress: ['testing', 'javascript'],
    jest: ['testing', 'javascript'],
};

/** knowing KEY makes each of VALUE quick to pick up */
const RELATED = {
    css: ['tailwind', 'bootstrap', 'sass'],
    html: ['css'],
    javascript: ['typescript', 'frontend', 'node', 'jquery'],
    react: ['nextjs', 'redux', 'vue', 'angular', 'material-ui'],
    vue: ['react', 'angular'],
    angular: ['react', 'vue'],
    node: ['express', 'nestjs', 'typescript'],
    python: ['django', 'flask', 'fastapi'],
    java: ['spring', 'kotlin'],
    csharp: ['dotnet'],
    sql: ['mysql', 'postgresql', 'sqlserver', 'oracle'],
    mysql: ['postgresql', 'sqlserver'],
    postgresql: ['mysql', 'sqlserver'],
    mongodb: ['redis'],
    docker: ['kubernetes'],
    jenkins: ['github-actions', 'gitlab-ci'],
    'github-actions': ['jenkins', 'gitlab-ci'],
    aws: ['azure', 'gcp'],
    azure: ['aws', 'gcp'],
    gcp: ['aws', 'azure'],
    git: ['github', 'gitlab'],
    devops: ['cicd', 'docker'],
    backend: ['rest', 'database'],
    frontend: ['react', 'javascript'],
    swift: ['kotlin'],
    kotlin: ['swift'],
};

/* ── spellings → canonical ────────────────────────────────────────────── */

const SPELLINGS = (() => {
    const out = [];
    for (const [canon, names] of Object.entries(ALIASES)) {
        for (const n of names) out.push([n.toLowerCase(), canon]);
    }
    // Longest first, so "react native" is read before "react".
    return out.sort((a, b) => b[0].length - a[0].length);
})();

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * Word-boundary match that understands punctuation inside a skill name.
 * `\b` is wrong for "c#", ".net" and "ci/cd"; and "java" must not match inside
 * "javascript", nor ".net" inside "asp.net".
 */
const PATTERNS = SPELLINGS.map(([spelling, canon]) => ({
    canon,
    spelling,
    re: new RegExp(`(?<![a-z0-9+#.])${escape(spelling)}(?![a-z0-9+#])`, 'i'),
}));

/** Canonical form of one skill name as a person typed it, or null. */
export const canonicalOf = (name) => {
    const n = String(name ?? '').trim().toLowerCase();
    if (!n) return null;
    for (const [spelling, canon] of SPELLINGS) if (spelling === n) return canon;
    return null;
};

/**
 * Every known skill mentioned in a piece of text, in order of first appearance.
 */
export const extractSkills = (text) => {
    const haystack = String(text ?? '').toLowerCase();
    if (!haystack) return [];
    const found = new Map();
    let masked = haystack;
    for (const { canon, spelling, re } of PATTERNS) {
        const m = re.exec(masked);
        if (!m) continue;
        if (!found.has(canon)) found.set(canon, m.index);
        // Blank it out, so "react native" is not also counted as "react".
        masked = masked.replace(new RegExp(re.source, 'gi'), ' '.repeat(spelling.length));
    }
    return [...found.entries()].sort((a, b) => a[1] - b[1]).map(([c]) => c);
};

/* ── what a set of skills covers ──────────────────────────────────────── */

/**
 * Expand the skills a consultant HAS into everything they can be credited with.
 *
 * @param skills canonical names
 * @returns Map<skill, { credit, via, kind }> — `via` is the skill that earned it
 */
export const expandSkills = (skills) => {
    const credit = new Map();
    const put = (skill, value, via, kind) => {
        const had = credit.get(skill);
        if (!had || value > had.credit) credit.set(skill, { credit: value, via, kind });
    };

    for (const s of skills) put(s, 1, s, 'HAS');

    // Two steps, multiplying. Walked breadth-first from what is actually held.
    let frontier = skills.map((s) => ({ skill: s, value: 1, root: s }));
    for (let depth = 0; depth < 2; depth += 1) {
        const next = [];
        for (const { skill, value, root } of frontier) {
            for (const to of IMPLIES[skill] ?? []) {
                const v = value * IMPLY;
                if (v > (credit.get(to)?.credit ?? 0)) {
                    put(to, v, root, 'IMPLIED');
                    next.push({ skill: to, value: v, root });
                }
            }
            for (const to of RELATED[skill] ?? []) {
                const v = value * RELATE;
                if (v > (credit.get(to)?.credit ?? 0)) {
                    put(to, v, root, 'RELATED');
                    next.push({ skill: to, value: v, root });
                }
            }
        }
        frontier = next;
    }
    return credit;
};

/**
 * How much of a job's skill list a consultant covers.
 *
 * Required skills count double. A skill with no path from anything the
 * consultant listed counts nothing — which is the point: a job asking for
 * Kubernetes, Go and Java must not look like a React developer's job.
 *
 * @param job  { required: string[], preferred: string[] } (canonical)
 * @returns { ratio, matched: [{skill, credit, via, kind, required}], missing: [{skill, required}] }
 */
export const coverage = (job, held) => {
    const rows = [
        ...job.required.map((skill) => ({ skill, required: true })),
        ...job.preferred.filter((p) => !job.required.includes(p)).map((skill) => ({ skill, required: false })),
    ];
    if (rows.length === 0) return { ratio: null, matched: [], missing: [] };

    let got = 0;
    let total = 0;
    const matched = [];
    const missing = [];
    for (const row of rows) {
        // How much this skill matters to THIS posting, when it says (see
        // jobSkills); otherwise required counts double.
        const weight = job.weights?.get(row.skill) ?? (row.required ? 2 : 1);
        total += weight;
        const have = held.get(row.skill);
        if (have) {
            got += weight * have.credit;
            matched.push({ ...row, ...have });
        } else {
            missing.push(row);
        }
    }
    return { ratio: got / total, matched, missing };
};

/* ── required or preferred ────────────────────────────────────────────── */

const PREFERRED_HEADING = /(nice[- ]to[- ]have|good to have|preferred|bonus|a plus|desirable|optional|extra credit)/i;
const REQUIRED_HEADING = /(requirements?|qualifications?|must[- ]have|what you(?:'|’)ll need|you have|you bring|skills|experience|responsibilities|about you)/i;

/**
 * Split a posting's skills into the ones it requires and the ones it would like.
 *
 * The title's skills are always required. In the description, a skill is
 * "preferred" only when it sits under a nice-to-have heading or in a sentence
 * that says so; everything else a posting names counts as required, because
 * that is how postings are written.
 */
/**
 * Broad ideas rather than tools. "Frontend", "backend" and "database" turn up in
 * chip design, mechanical engineering and finance ("front-end and back-end
 * design" is ASIC vocabulary), so a concept found only in running text counts
 * only when the posting also names real tools — see jobSkills.
 */
export const CONCEPTS = new Set(['frontend', 'backend', 'responsive', 'database', 'cloud', 'mobile', 'testing', 'devops']);

export const jobSkills = ({ title, description }) => {
    const fromTitle = new Set(extractSkills(title));
    // "Full stack" names no tool, and yet it is the most important thing a title
    // can say: both halves are wanted. Found on the live pool as a "Full Stack
    // Developer I" that scored nothing for skills because the title carried none.
    if (/\bfull[- ]?stack\b|\bmern\b|\bmean stack\b/i.test(String(title ?? ''))) {
        fromTitle.add('frontend');
        fromTitle.add('backend');
    }
    const required = new Set(fromTitle);
    const preferred = new Set();
    // The order skills are first met in the description is how much they matter:
    // a posting leads with what it cares about and ends with a wish list.
    const order = [];

    const lines = String(description ?? '').split(/\r?\n|(?<=[.;])\s+(?=[A-Z•\-*])/);
    let mode = 'required';
    for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        // A heading is a short line that either ends in a colon or reads like a
        // title (no sentence punctuation). "We also use Docker, a plus." is a
        // sentence, and its skills must still be read.
        const heading = line.length < 60
            && (/:\s*$/.test(line) || (!/[.,;]/.test(line) && line.split(/\s+/).length <= 6));
        if (heading && PREFERRED_HEADING.test(line)) { mode = 'preferred'; continue; }
        if (heading && REQUIRED_HEADING.test(line) && !PREFERRED_HEADING.test(line)) { mode = 'required'; continue; }

        const sentenceMode = PREFERRED_HEADING.test(line) ? 'preferred' : mode;
        for (const skill of extractSkills(line)) {
            if (!order.includes(skill)) order.push(skill);
            if (sentenceMode === 'preferred') {
                if (!required.has(skill)) preferred.add(skill);
            } else {
                required.add(skill);
                preferred.delete(skill);
            }
        }
    }
    // A concept found only in the description, in a posting that names fewer than
    // two real tools, is vocabulary and not a requirement.
    const tools = new Set([...required, ...preferred].filter((s) => !CONCEPTS.has(s)));
    if (tools.size < 2) {
        for (const s of [...required]) if (CONCEPTS.has(s) && !fromTitle.has(s)) required.delete(s);
        for (const s of [...preferred]) if (CONCEPTS.has(s)) preferred.delete(s);
    }

    const weights = new Map();
    for (const s of required) {
        if (fromTitle.has(s)) weights.set(s, 3);
        else weights.set(s, order.indexOf(s) < 6 ? 2 : 1);
    }
    for (const s of preferred) weights.set(s, 0.5);

    return { required: [...required], preferred: [...preferred], weights };
};

/* ── role families and level ──────────────────────────────────────────── */

const FAMILY_WORDS = {
    frontend: /\b(front[- ]?end|ui|react|angular|vue|web developer|javascript developer|web engineer)\b/i,
    backend: /\b(back[- ]?end|node|java|python|\.net|golang|server[- ]side|api developer)\b/i,
    fullstack: /\b(full[- ]?stack|mern|mean)\b/i,
    devops: /\b(devops|sre|site reliability|platform engineer|infrastructure|build engineer|release engineer)\b/i,
    cloud: /\b(cloud)\b/i,
    data: /\b(data (engineer|scientist|analyst)|etl|business intelligence|machine learning|ml engineer|analytics)\b/i,
    mobile: /\b(android|ios|mobile|flutter|react native)\b/i,
    qa: /\b(qa|quality assurance|sdet|test engineer|automation tester)\b/i,
};

/** Skills that imply a family when a title gives no hint. */
const FAMILY_SKILLS = {
    frontend: ['frontend', 'react', 'angular', 'vue', 'css', 'html'],
    backend: ['backend', 'node', 'django', 'spring', 'dotnet', 'rails', 'laravel', 'express'],
    devops: ['devops', 'kubernetes', 'terraform', 'ansible', 'cicd'],
    cloud: ['cloud', 'aws', 'azure', 'gcp'],
    data: ['etl', 'spark', 'airflow', 'snowflake'],
    mobile: ['mobile', 'reactnative', 'flutter', 'swift', 'kotlin'],
    qa: ['testing', 'selenium', 'cypress'],
};

/**
 * The role families a title, or a set of skills, points at.
 * "Full stack" is both frontend and backend: a full-stack developer is a fair
 * candidate for either, and a frontend role is a fair one for them.
 */
export const familiesOf = (title, skills = []) => {
    const out = new Set();
    const t = String(title ?? '');
    for (const [family, re] of Object.entries(FAMILY_WORDS)) if (re.test(t)) out.add(family);
    if (out.has('fullstack')) { out.add('frontend'); out.add('backend'); }
    for (const [family, names] of Object.entries(FAMILY_SKILLS)) {
        if (skills.some((s) => names.includes(s))) out.add(family);
    }
    return out;
};

/** 1 junior · 2 mid (the default) · 3 senior · 4 lead and above. Null = not stated. */
export const levelOf = (title) => {
    const t = String(title ?? '').toLowerCase();
    if (/\b(principal|staff|architect|director|head of|lead)\b/.test(t)) return 4;
    if (/\b(senior|sr\.?|iii|iv)\b/.test(t)) return 3;
    if (/\b(junior|jr\.?|entry|associate|intern|graduate|fresher|trainee)\b/.test(t)) return 1;
    if (/\b(ii|mid)\b/.test(t)) return 2;
    return null;
};

/** A consultant's level from their total years of experience. */
export const levelFromYears = (years) => {
    if (years === null || years === undefined) return null;
    if (years < 2) return 1;
    if (years < 6) return 2;
    if (years < 10) return 3;
    return 4;
};
