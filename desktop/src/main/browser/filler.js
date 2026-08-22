/**
 * ── FILLING A FORM ────────────────────────────────────────────────────
 *
 * Reads every field on the page, works out what each one is asking, types what
 * the hub has approved, attaches the resume, and STOPS.
 *
 * ── THE THINGS THIS WILL NOT DO ───────────────────────────────────────
 *
 * Three refusals are enforced here rather than left to a board recipe, because
 * a recipe is exactly the kind of thing that gets copy-pasted with a mistake:
 *
 *   1. It never clicks a button. The only elements it touches are inputs,
 *      textareas and selects — a radio and a checkbox are clicked, a <button>
 *      never is. R-02: the consultant makes the final click.
 *   2. It never types into a password field. R-18 says the app holds no portal
 *      credential; a page that asks for one gets nothing, and says so.
 *   3. It never guesses. A field it cannot resolve is reported as an unknown
 *      question, not filled with something plausible.
 *
 * ── WHY FIELDS ARE READ IN ONE PASS ───────────────────────────────────
 *
 * All descriptors come back from a single evaluate() rather than a round trip
 * per field. Dozens of round trips is slow, but the real reason is consistency:
 * a page that re-renders halfway through would otherwise be described half in
 * its old shape and half in its new one.
 */
const {
    buildAnswerBook, resolveAnswer, isAffirmative, chooseOption, chooseSuggestion,
} = require('./answers.js');
const { TYPING } = require('../config.js');

/** Every control we consider. Order here defines the index we act on. */
const FIELD_SELECTOR = 'input, textarea, select';

const rand = (min, max) => min + Math.random() * (max - min);

/** Escape an id for use in a selector, without needing the browser's CSS API. */
const CSS_ESCAPE = (id) => String(id).replace(/([^\w-])/g, '\$1');
const pause = (min, max) => new Promise((r) => { setTimeout(r, rand(min, max)); });

/**
 * Describe every field on the page.
 *
 * Runs in the browser, and deliberately returns plain data rather than handles,
 * so every decision happens in Node where it can be tested.
 */
const describeFields = (page, root = null) => page.$$eval(
    root ? `${root} ${FIELD_SELECTOR.split(', ').join(`, ${root} `)}` : FIELD_SELECTOR,
    (nodes) => {
    const text = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

    const labelFor = (el) => {
        const aria = el.getAttribute('aria-label');
        if (aria && aria.trim()) return aria.trim();

        const by = el.getAttribute('aria-labelledby');
        if (by) {
            const joined = by.split(/\s+/)
                .map((id) => text(document.getElementById(id)))
                .filter(Boolean).join(' ');
            if (joined) return joined;
        }

        if (el.id) {
            const explicit = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
            if (text(explicit)) return text(explicit);
        }

        const wrapping = el.closest('label');
        if (text(wrapping)) return text(wrapping);

        const placeholder = el.getAttribute('placeholder');
        if (placeholder && placeholder.trim()) return placeholder.trim();

        return el.getAttribute('name') || '';
    };

    /** For radios: the question the whole group is asking. */
    const groupLabelFor = (el) => {
        const fieldset = el.closest('fieldset');
        const legend = fieldset ? fieldset.querySelector('legend') : null;
        if (text(legend)) return text(legend);
        const group = el.closest('[role="radiogroup"]');
        if (group && group.getAttribute('aria-label')) return group.getAttribute('aria-label');
        return '';
    };

    return nodes.map((el, index) => {
        const tag = el.tagName.toLowerCase();
        const type = (el.getAttribute('type') || (tag === 'select' ? 'select' : 'text'))
            .toLowerCase();
        const style = window.getComputedStyle(el);
        const label = labelFor(el);

        return {
            index,
            tag,
            type,
            name: el.getAttribute('name') || '',
            label,
            groupLabel: type === 'radio' ? groupLabelFor(el) : '',
            required: el.required || el.getAttribute('aria-required') === 'true'
                || /\*/.test(label),
            disabled: el.disabled || el.readOnly,
            // Already answered by the portal itself. LinkedIn pre-fills name,
            // phone and email from the signed-in account, and those values are
            // the account holder's own — better than anything we would type.
            hasValue: Boolean(
                tag === 'select'
                    ? (el.value && el.value !== '' && el.selectedIndex > -1
                       && (el.options[el.selectedIndex]?.textContent || '').trim())
                    : (el.value || '').trim(),
            ),
            visible: style.display !== 'none' && style.visibility !== 'hidden'
                && el.offsetParent !== null,
            options: tag === 'select'
                ? Array.from(el.options).map((o) => (o.textContent || '').trim())
                : [],
        };
        });
    },
);

/** How long to give a typeahead to fetch and render its suggestions. */
const SUGGESTION_WAIT_MS = 2_500;

/**
 * Finish a typeahead by choosing one of its suggestions.
 *
 * ── WHY TYPING THE RIGHT TEXT IS NOT ENOUGH ───────────────────────────
 *
 * LinkedIn's location field is a combobox. Typing "dallas" puts the word in the
 * box and opens a list; the form does not hold a location until an option from
 * that list is picked. Leaving it as typed text looks correct on screen and the
 * step then refuses to advance, with nothing saying why — which is exactly
 * where the run stopped.
 *
 * The list is chosen from rather than blindly accepted: an exact match wins, a
 * unique prefix match is taken, and anything ambiguous is left alone. A wrong
 * city on an application is worse than no city.
 *
 * Fields that are not comboboxes are untouched — nothing here fires unless the
 * page itself says a listbox opened, so no other board changes behaviour.
 *
 * @returns the option text chosen, or null when nothing was
 */
const pickSuggestion = async (page, el, typed, hint = null) => {
    // A control that cannot even be asked about its attributes is not a
    // combobox — and this must never be the thing that breaks a plain form.
    if (typeof el.getAttribute !== 'function' || typeof page.locator !== 'function') return null;

    const controls = await el.getAttribute('aria-controls').catch(() => null);
    const role = await el.getAttribute('role').catch(() => null);
    const auto = await el.getAttribute('aria-autocomplete').catch(() => null);
    if (!controls && role !== 'combobox' && !auto) return null;

    const list = controls
        ? page.locator(`#${CSS_ESCAPE(controls)} [role="option"], #${CSS_ESCAPE(controls)} li`)
        : page.locator('[role="listbox"] [role="option"]');

    // The suggestions arrive from a request, so they are not there the instant
    // typing stops.
    const deadline = Date.now() + SUGGESTION_WAIT_MS;
    let count = 0;
    while (Date.now() < deadline) {
        count = await list.count().catch(() => 0);
        if (count > 0) break;
        await page.waitForTimeout(200);
    }
    if (count === 0) return null;

    const texts = [];
    for (let i = 0; i < Math.min(count, 10); i += 1) {
        texts.push(((await list.nth(i).innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim());
    }

    // Typeahead suggestions are ranked and plural by design, so they get their
    // own rule rather than the strict one used for screening questions.
    const match = chooseSuggestion(texts, typed, hint);
    if (!match) return null;

    await list.nth(texts.indexOf(match)).click().catch(() => {});
    await page.waitForTimeout(600);
    return match;
};

/** Controls that carry no question and must never be touched. */
const IGNORED_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image']);

/**
 * Fill everything answerable on the current page.
 *
 * @returns {{qa: Array, unknown: Array, attachedResume: boolean, refusals: Array}}
 */
const fillForm = async (page, {
    profile, approvedAnswers, resumePath, typing = TYPING, root = null,
}) => {
    const book = buildAnswerBook({ profile, approvedAnswers });
    // `root` scopes everything to one container. It matters for any board that
    // applies through a dialog: the page behind it still holds a search box and
    // a language picker, and without scoping those are read as part of the
    // application — which is exactly what a real LinkedIn job page offers.
    const scoped = root
        ? `${root} ${FIELD_SELECTOR.split(', ').join(`, ${root} `)}`
        : FIELD_SELECTOR;
    const fields = await describeFields(page, root);
    const locators = page.locator(scoped);

    const qa = [];
    const unknown = [];
    const refusals = [];
    let attachedResume = false;

    // A radio group is one question, answered once — not once per option.
    const answeredGroups = new Set();

    for (const f of fields) {
        if (IGNORED_TYPES.has(f.type) || f.disabled || !f.visible) continue;

        // R-18. A portal asking for a password is a page we do not fill.
        if (f.type === 'password') {
            refusals.push({
                label: f.label,
                reason: 'password field — the app never types credentials',
            });
            continue;
        }

        const el = locators.nth(f.index);

        if (f.type === 'file') {
            if (resumePath && !attachedResume) {
                await el.setInputFiles(resumePath);
                attachedResume = true;
                qa.push({
                    questionText: f.label || 'Resume',
                    answerText: '[resume attached]',
                    fieldType: 'file',
                    source: 'RESUME',
                    questionId: null,
                });
            }
            continue;
        }

        const question = f.type === 'radio' ? (f.groupLabel || f.label) : f.label;
        if (!question) continue;

        // ── LEAVE WHAT IS ALREADY THERE ───────────────────────────────
        //
        // A portal that has pre-filled a field knows something we do not: on
        // LinkedIn the name, phone and email come from the signed-in account,
        // and its "Email address" is a dropdown whose only option is that
        // account's address. Typing over it is at best redundant and at worst
        // impossible — the old behaviour matched our profile's email against
        // that single option, failed, called it an unanswered REQUIRED
        // question, and parked the application permanently.
        //
        // So a field that already has a value is recorded as answered and left
        // alone. The consultant still sees it on the review screen, marked as
        // the portal's own, and can change it in the browser.
        if (f.hasValue) {
            qa.push({
                questionText: question,
                answerText: '[already filled in by the portal]',
                fieldType: f.type,
                source: 'PORTAL',
                questionId: null,
            });
            continue;
        }

        if (f.type === 'radio') {
            if (answeredGroups.has(f.name)) continue;
            answeredGroups.add(f.name);

            const found = resolveAnswer(question, book);
            const siblings = fields.filter((s) => s.type === 'radio' && s.name === f.name);
            const match = found ? chooseOption(siblings.map((s) => s.label), found.value) : null;
            const target = match ? siblings.find((s) => s.label === match) : null;

            if (!target) {
                unknown.push({ questionText: question, fieldType: 'radio', required: f.required });
                continue;
            }

            await locators.nth(target.index).check();
            qa.push({
                questionText: question,
                answerText: target.label,
                fieldType: 'radio',
                source: found.source,
                questionId: found.questionId,
            });
            await pause(typing.betweenFieldsMs[0], typing.betweenFieldsMs[1]);
            continue;
        }

        const found = resolveAnswer(question, book);
        if (!found) {
            unknown.push({ questionText: question, fieldType: f.type, required: f.required });
            continue;
        }

        if (f.tag === 'select') {
            const match = chooseOption(f.options, found.value);
            if (!match) {
                unknown.push({ questionText: question, fieldType: 'select', required: f.required });
                continue;
            }
            await el.selectOption({ label: match });
            qa.push({
                questionText: question,
                answerText: match,
                fieldType: 'select',
                source: found.source,
                questionId: found.questionId,
            });
        } else if (f.type === 'checkbox') {
            if (!isAffirmative(found.value)) continue;
            await el.check();
            qa.push({
                questionText: question,
                answerText: 'Yes',
                fieldType: 'checkbox',
                source: found.source,
                questionId: found.questionId,
            });
        } else {
            // Human-paced (R-19). One randomised delay per field rather than a
            // constant per-character delay, which is itself a signature.
            await el.click();
            await el.fill('');
            await el.pressSequentially(String(found.value), {
                delay: Math.round(rand(typing.minMs, typing.maxMs)),
            });

            // A typeahead is not finished when the text is right — it is
            // finished when an option has been CHOSEN. See pickSuggestion.
            const chosen = await pickSuggestion(
                page, el, String(found.value), book.values.state,
            );

            qa.push({
                questionText: question,
                answerText: chosen ?? String(found.value),
                fieldType: f.type,
                source: found.source,
                questionId: found.questionId,
            });
        }

        await pause(typing.betweenFieldsMs[0], typing.betweenFieldsMs[1]);
    }

    return { qa, unknown, attachedResume, refusals };
};

module.exports = { fillForm, describeFields, FIELD_SELECTOR, IGNORED_TYPES };
