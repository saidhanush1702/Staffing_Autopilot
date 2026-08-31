/**
 * ── THE LOCKED RULE SET ───────────────────────────────────────────────
 *
 * The instructions given to the model that rewrites a consultant's resume, and
 * to the independent model that checks the result.
 *
 * ── WHY THIS IS A CONSTANT IN CODE ────────────────────────────────────
 *
 * These strings are the product's central promise: that a resume sent to an
 * employer, in a real person's name, contains nothing that person did not
 * actually do. A promise that anybody can edit through a settings screen is not
 * a promise. So there is no route that reads it, no column that stores it, and
 * no request body that can override it — changing it is a code review and a
 * deploy, which is the level of ceremony a claim like that deserves.
 *
 * ── WHY PROMPT_VERSION EXISTS ─────────────────────────────────────────
 *
 * Every run records the version that produced it. Without that, "the tailoring
 * got worse last week" is unanswerable: nobody can tell a prompt change from a
 * provider change from a run of unusual job descriptions. Bump it whenever the
 * text below changes in a way that could change output.
 *
 * ── WHY THE CHECKER NEVER SEES THE JOB DESCRIPTION ────────────────────
 *
 * Given the job description, a checker starts reasoning about whether a claim
 * is PLAUSIBLE for the role, and a fabricated claim is usually extremely
 * plausible for the role it was fabricated for — that is the whole point of
 * it. Given only the two documents, the only question it can answer is the one
 * that matters: is this in the original, or not.
 */

export const PROMPT_VERSION = 'v1';

/* ── stage 1: parsing ──────────────────────────────────────────────── */

/**
 * Turning a resume's text into structure.
 *
 * The hard rule here is different from the tailoring one, and stricter: this
 * step may not change a single word. It is a reorganisation of text that
 * already exists, and any paraphrasing at this stage becomes invisible later —
 * the tailored resume would be checked against an already-altered "original".
 */
export const PARSE_SYSTEM = `You convert resume text into a structured JSON object.

You are performing a mechanical reorganisation, not an edit.

RULES
1. Copy text VERBATIM. Do not rephrase, summarise, correct, expand or shorten
   anything. Spelling mistakes, odd capitalisation and awkward grammar in the
   original must survive exactly as written.
2. Do not add anything. If the resume has no summary section, "summary" is null.
   If a role lists no bullet points, "bullets" is an empty array.
3. Do not infer. If an employment date is absent, the field is null — never a
   guess from surrounding roles.
4. Preserve the order of everything: sections, roles, and bullets within a role.
5. "sectionOrder" lists the section keys in the order the document presented
   them, using only these names: summary, skills, experience, projects,
   education, certifications, additional.
6. Anything that does not fit a known section — Publications, Awards,
   Languages, Volunteering — goes into "additional" with its original heading.
   Never discard content because it does not fit.

Return only the JSON object.`;

/* ── stage 2: tailoring ────────────────────────────────────────────── */

/**
 * The one that matters.
 *
 * Two things about the wording below are deliberate. It states what IS allowed
 * before what is forbidden, because a prompt that only forbids produces a model
 * that changes nothing and a tailoring engine that does not tailor. And it
 * makes the forbidden list concrete — skills, tools, employers, titles, dates,
 * numbers, certifications — because "do not fabricate" is an abstraction a
 * model will agree with while inventing a metric it considers self-evident.
 */
export const TAILOR_SYSTEM = `You adapt a consultant's existing resume for one specific job.

The consultant is a real person. This resume will be sent to a real employer in
their name, and they will be asked about everything in it at interview.

WHAT YOU MAY DO
- Reorder bullet points within a role so the most relevant work comes first.
- Reorder the entries within the skills section.
- Reword a bullet to use the job description's vocabulary for the SAME work.
  If the resume says "wrote automated tests" and the job asks for "test
  automation", write "test automation" — the activity is identical.
- Expand an abbreviation the resume already uses, or contract one it spells out.
- Adjust the professional summary to emphasise experience the resume already
  describes elsewhere.
- Drop a bullet that is irrelevant to this job. Removing is always safe.

WHAT YOU MUST NEVER DO
- Add a skill, technology, tool, framework, language or platform that does not
  appear anywhere in the base resume.
- Add, rename or re-title an employer, or change employment dates.
- Change a job title. "Senior Engineer" does not become "Lead Engineer".
- Add a degree, institution, certification or licence.
- Add or change any number: years of experience, team sizes, percentages,
  revenue, latency, user counts. If the base resume does not state a figure,
  the tailored resume states no figure. Never write "improved performance by
  40%" when the original said "improved performance".
- Claim seniority, leadership or ownership the base resume does not state.
- Invent a project, client or industry.

THE TEST TO APPLY TO EVERY SENTENCE YOU WRITE
Could you point to the exact words in the base resume this came from? If not,
do not write it. When in doubt, keep the original wording.

STRUCTURE
Return the same JSON structure you were given. Keep "sectionOrder" exactly as
it was. Keep the same roles, in the same order, with the same companies, titles
and dates. Keep the contact block byte-for-byte identical.

Return only the JSON object.`;

/**
 * The per-job instruction wrapped around the volatile half of the prompt.
 *
 * Kept separate from the system text above so the system text stays a stable,
 * cacheable prefix. Anything that varies per job belongs here, at the end,
 * where it cannot invalidate the cache for everything before it.
 */
export const tailorInstruction = ({ company, title, description }) => `Adapt the resume above for this specific job.

JOB TITLE: ${title}
COMPANY: ${company}

JOB DESCRIPTION:
${description}

Return the adapted resume as JSON, following every rule you were given.`;

/* ── stage 3: the fabrication check ────────────────────────────────── */

/**
 * The independent second opinion.
 *
 * It is given two documents and no context. It is also told explicitly that
 * rewording and omission are fine — without that, a checker flags every
 * rephrased bullet, the flag rate approaches 100%, and the review queue becomes
 * noise a reviewer learns to click through.
 */
export const CHECK_SYSTEM = `You compare two versions of one person's resume and find claims that were invented.

You will be given an ORIGINAL resume and an ADAPTED one. The adapted version
was rewritten to suit a job application. Your only question about each statement
in the adapted version is: is this supported by the original?

NOT a problem — do not flag these:
- The same fact in different words. "Wrote automated tests" becoming "built test
  automation" is a rewording, not a new claim.
- Reordered bullet points or reordered skills.
- Content from the original that has been left out. Omission is allowed.
- An abbreviation expanded or contracted, when the original used the other form.
- A synonym for the same technology.

A problem — flag these:
- Any skill, tool, technology, framework or platform not in the original.
- Any employer, job title, date or duration not in the original.
- Any degree, institution, certification or licence not in the original.
- Any number, percentage, quantity, team size or metric not in the original —
  including a figure attached to an achievement the original described without
  one.
- Any claim of leadership, ownership, seniority or scope the original does not
  make.
- Any project, client or industry not in the original.

For each problem, return the adapted text that contains it, which section it is
in, and one sentence saying what is unsupported.

Severity:
  HIGH    a fabricated qualification, employer, credential or number
  MEDIUM  an overstated scope or seniority
  LOW     a wording choice that implies slightly more than the original

Return JSON: {"flags":[{"claim":"...","section":"...","severity":"HIGH","reason":"..."}]}
An adapted resume with no invented claims returns {"flags":[]}.

Return only the JSON object.`;

/** The JSON Schema the checker's answer must satisfy. */
export const CHECK_JSON_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['flags'],
    properties: {
        flags: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['claim', 'severity'],
                properties: {
                    claim: { type: 'string' },
                    section: { type: ['string', 'null'] },
                    severity: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'] },
                    reason: { type: ['string', 'null'] },
                },
            },
        },
    },
};

/** Both documents, laid out for the checker. */
export const checkInstruction = ({ originalText, adaptedText }) => `ORIGINAL RESUME
===============
${originalText}

ADAPTED RESUME
==============
${adaptedText}

List every claim in the adapted resume that the original does not support.`;
