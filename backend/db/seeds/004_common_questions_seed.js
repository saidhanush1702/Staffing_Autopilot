/**
 * Seed 004 — the standard application questions, per organisation.
 * Phase: 4
 *
 * This is what makes Phase 4 usable before Phase 5 exists. Real questions are
 * meant to arrive from application forms, and there are no applications yet —
 * so without a starting set, the answer bank would ship as an empty inbox.
 *
 * These are the questions almost every job application asks. Consultants
 * answer them proactively during onboarding, exactly as a staffing firm would
 * ask them anyway, and Phase 5 then arrives to find answers already waiting
 * instead of stalling on its first form.
 *
 * Categories are set EXPLICITLY here rather than left to the classifier. These
 * are the reference set — if the classifier and this list ever disagree, the
 * disagreement should be visible in a test, not silently resolved at seed time.
 *
 * Idempotent: keyed on (organization_id, normalised_key), which is the same
 * uniqueness the application enforces.
 */
import { v4 as uuidv4 } from 'uuid';
import { normaliseQuestion } from '../../config/questionNormaliser.js';

const COMMON_QUESTIONS = [
    // ── general: skills and experience ──────────────────────────────
    ['GENERAL', 'How many years of professional experience do you have?'],
    ['GENERAL', 'What is your highest level of education?'],
    ['GENERAL', 'Are you willing to relocate?'],
    ['GENERAL', 'What is your notice period?'],
    ['GENERAL', 'When can you start?'],
    ['GENERAL', 'Are you willing to work onsite?'],
    ['GENERAL', 'Do you have a valid driver licence?'],
    ['GENERAL', 'Why are you interested in this role?'],
    ['GENERAL', 'Describe your most relevant project.'],
    ['GENERAL', 'What are your primary technical skills?'],
    ['GENERAL', 'Have you worked in an Agile environment?'],
    ['GENERAL', 'Do you have experience leading a team?'],
    ['GENERAL', 'Are you comfortable with on-call rotation?'],
    ['GENERAL', 'What time zone are you based in?'],
    ['GENERAL', 'Do you have a professional certification relevant to this role?'],
    ['GENERAL', 'Have you previously applied to this company?'],
    ['GENERAL', 'How did you hear about this position?'],
    ['GENERAL', 'Are you currently employed?'],

    // ── owner-only: pay ─────────────────────────────────────────────
    ['SALARY', 'What is your expected hourly rate?'],
    ['SALARY', 'What is your expected annual salary?'],
    ['SALARY', 'What is your current compensation?'],
    ['SALARY', 'Are you flexible on rate for the right opportunity?'],

    // ── owner-only: right to work ───────────────────────────────────
    ['WORK_AUTH', 'Are you legally authorized to work in the United States?'],
    ['WORK_AUTH', 'Will you now or in the future require visa sponsorship?'],
    ['WORK_AUTH', 'What is your current work authorization status?'],
    ['WORK_AUTH', 'Are you able to provide proof of your right to work?'],
];

export const runSeed004 = async (connection) => {
    console.log('Seeding common application questions...');

    const { rows: orgs } = await connection.query('SELECT id, name FROM organizations');
    const { rows: cats } = await connection.query(
        'SELECT id, name FROM lkp_question_categories',
    );
    const categoryId = new Map(cats.map((c) => [c.name, c.id]));

    let inserted = 0;
    for (const org of orgs) {
        for (const [category, text] of COMMON_QUESTIONS) {
            const { rowCount } = await connection.query(
                `INSERT INTO questions
                    (id, organization_id, question_text, normalised_key,
                     category_id, applies_to_all, auto_categorised)
                 VALUES ($1,$2,$3,$4,$5,TRUE,FALSE)
                 ON CONFLICT (organization_id, normalised_key) DO NOTHING`,
                [uuidv4(), org.id, text, normaliseQuestion(text), categoryId.get(category)],
            );
            inserted += rowCount;
        }
    }

    console.log(`  ✓ ${COMMON_QUESTIONS.length} standard questions per org`
        + ` (${inserted} newly inserted across ${orgs.length} organisation(s))`);
};
