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

/**
 * Escape an id for use in a selector, without needing the browser's CSS API.
 *
 * The backslash is doubled deliberately. Written as '\$1' it is not an escape
 * sequence JavaScript recognises, so it collapsed to '$1' and this function
 * replaced every special character with itself — an escaper that escaped
 * nothing. React's generated ids ("«r10»") are exactly the case it exists for.
 */
const CSS_ESCAPE = (id) => String(id).replace(/([^\w-])/g, '\\$1');
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

    /**
     * ── THE CONTROL THAT STANDS IN FOR THE REAL ONE ───────────────────
     *
     * LinkedIn renders a radio as a 0×0, fully transparent <input> wrapped in a
     * styled <div role="radio" aria-label="Yes" aria-checked="false">. The
     * input is what the DOM calls a radio; the div is what a person clicks, and
     * the only thing carrying the option's name.
     *
     * Measured, not assumed — the markup is quoted under `groupLabelFor`. Found
     * by role rather than by class because LinkedIn's classes are build-hashed
     * and change between page loads.
     */
    const proxyFor = (el) => {
        let n = el.parentElement;
        for (let i = 0; i < 6 && n; i += 1, n = n.parentElement) {
            const role = n.getAttribute('role');
            if (role === 'radio' || role === 'checkbox' || n.hasAttribute('aria-checked')) {
                return n;
            }
        }
        return null;
    };

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

    /**
     * What ONE option in a group is called.
     *
     * The native input has nothing usable on a LinkedIn form: its <label for>
     * is empty and its `name` is a React-generated group id. The option's name
     * lives on the styled proxy, as an aria-label and as its visible text.
     *
     * Falling back to `labelFor` there returns "radio-group-«rv»", and the app
     * then looks for an option called that — which is exactly how a plain
     * Yes/No question became unanswerable.
     */
    const optionLabelFor = (el) => {
        const proxy = proxyFor(el);
        if (proxy) {
            const aria = proxy.getAttribute('aria-label');
            if (aria && aria.trim()) return aria.trim();
            const own = text(proxy);
            if (own) return own;
        }
        const plain = labelFor(el);
        // A generated group id is not a name anybody chose.
        return plain === (el.getAttribute('name') || '') ? '' : plain;
    };

    const groupBoxFor = (el) => el.closest('fieldset, [role="radiogroup"], [role="group"]');

    /**
     * ── THE QUESTION A GROUP IS ASKING ────────────────────────────────
     *
     * Read off a real Easy Apply screening step:
     *
     *   <div>
     *     <p>We must fill this position urgently. Can you start immediately?*</p>
     *     <fieldset aria-describedby="error-message-«rv»" role="radiogroup">
     *       <div role="radio" aria-label="Yes" aria-checked="false">…</div>
     *       <div role="radio" aria-label="No"  aria-checked="false">…</div>
     *     </fieldset>
     *   </div>
     *
     * No legend. No aria-label. No aria-labelledby. The question is a sibling
     * paragraph with no declared relationship to the group at all — so every
     * accessible way of asking returns nothing, and the only thing left is
     * where it sits on the page.
     *
     * Hence the ladder below: every proper answer first, position last. A board
     * that labels its groups correctly never reaches the fallback.
     */
    const groupLabelFor = (el) => {
        const box = groupBoxFor(el);
        if (!box) return '';

        const legend = box.querySelector('legend');
        if (text(legend)) return text(legend);

        const aria = box.getAttribute('aria-label');
        if (aria && aria.trim()) return aria.trim();

        const by = box.getAttribute('aria-labelledby');
        if (by) {
            const joined = by.split(/\s+/)
                .map((id) => text(document.getElementById(id)))
                .filter(Boolean).join(' ');
            if (joined) return joined;
        }

        // The paragraph immediately above the group. Length-capped so a whole
        // job description sitting above a stray fieldset cannot be mistaken for
        // a question.
        let prev = box.previousElementSibling;
        for (let i = 0; i < 3 && prev; i += 1, prev = prev.previousElementSibling) {
            const t = text(prev);
            if (t && t.length <= 300) return t;
        }

        // Or the container's own text with the options' text cut out of it.
        const parent = box.parentElement;
        if (parent) {
            const whole = text(parent);
            const inner = text(box);
            const at = inner ? whole.indexOf(inner) : -1;
            const head = at > 0 ? whole.slice(0, at).trim() : '';
            if (head && head.length <= 300) return head;
        }

        return '';
    };

    // Groups are identified by their CONTAINER, not by `name`: the container is
    // always there and the name sometimes is not. Two questions on one step
    // with no names would otherwise merge into a single group, and only the
    // first of them would ever be answered.
    const groupIds = new Map();
    const groupKeyFor = (el, index) => {
        const box = groupBoxFor(el);
        if (box) {
            if (!groupIds.has(box)) groupIds.set(box, `group-${groupIds.size}`);
            return groupIds.get(box);
        }
        return el.getAttribute('name') || `solo-${index}`;
    };

    return nodes.map((el, index) => {
        const tag = el.tagName.toLowerCase();
        const type = (el.getAttribute('type') || (tag === 'select' ? 'select' : 'text'))
            .toLowerCase();
        const isOption = type === 'radio' || type === 'checkbox';
        const style = window.getComputedStyle(el);
        const label = isOption ? optionLabelFor(el) : labelFor(el);
        const groupLabel = isOption ? groupLabelFor(el) : '';
        const box = isOption ? groupBoxFor(el) : null;
        const proxy = isOption ? proxyFor(el) : null;
        const proxyStyle = proxy ? window.getComputedStyle(proxy) : null;
        const rect = el.getBoundingClientRect();

        return {
            index,
            tag,
            type,
            id: el.id || '',
            name: el.getAttribute('name') || '',
            label,
            groupLabel,
            groupKey: isOption ? groupKeyFor(el, index) : '',
            required: Boolean(
                el.required || el.getAttribute('aria-required') === 'true'
                || (box && box.getAttribute('aria-required') === 'true')
                || /\*/.test(label) || /\*/.test(groupLabel),
            ),
            disabled: el.disabled || el.readOnly,
            // Can Playwright actually click this thing? A transparent 0×0 input
            // is not visible by its rules, so `check()` waits for it until it
            // times out; the styled proxy has to be clicked instead.
            hittable: rect.width > 0 && rect.height > 0 && style.opacity !== '0',
            // Already answered by the portal itself. LinkedIn pre-fills name,
            // phone and email from the signed-in account, and those values are
            // the account holder's own — better than anything we would type.
            //
            // For a radio or a checkbox this is `checked`, NOT `value`: an
            // unchecked radio still reports value "on", so reading `value` here
            // marked every option on every form as already answered — and the
            // app then filled in none of them and pressed Next anyway.
            hasValue: Boolean(
                isOption
                    ? (el.checked || (proxy && proxy.getAttribute('aria-checked') === 'true'))
                    : (tag === 'select'
                        ? (el.value && el.value !== '' && el.selectedIndex > -1
                           && (el.options[el.selectedIndex]?.textContent || '').trim())
                        : (el.value || '').trim()),
            ),
            // A proxied control's visibility is the proxy's: the input itself is
            // deliberately invisible and says nothing about whether the question
            // is on screen.
            visible: proxyStyle
                ? (proxyStyle.display !== 'none' && proxyStyle.visibility !== 'hidden'
                   && proxy.offsetParent !== null)
                : (style.display !== 'none' && style.visibility !== 'hidden'
                   && el.offsetParent !== null),
            options: tag === 'select'
                ? Array.from(el.options).map((o) => (o.textContent || '').trim())
                : [],
        };
        });
    },
);

/**
 * Tick a radio or a checkbox, whatever it turns out to be made of.
 *
 * `check()` is tried first and is right for an ordinary form. It cannot work on
 * a control that is 0×0 and transparent, because Playwright refuses to click
 * what a person could not click — so for those the styled proxy is clicked
 * instead, then the input's own label, and only then a forced check.
 *
 * The order matters: each step is more of a workaround than the one before it,
 * and the first that applies wins.
 */
const checkControl = async (locator, field = {}) => {
    if (field.hittable !== false) {
        try {
            await locator.check({ timeout: 5_000 });
            return 'check';
        } catch { /* not clickable as itself — try what stands in for it */ }
    }

    if (typeof locator.locator === 'function') {
        const proxy = locator.locator(
            'xpath=ancestor-or-self::*[@role="radio" or @role="checkbox" or @aria-checked][1]',
        );
        if (await proxy.count().catch(() => 0) > 0) {
            try {
                await proxy.first().click({ timeout: 5_000 });
                return 'proxy';
            } catch { /* fall through */ }
        }
    }

    if (field.id && typeof locator.page === 'function') {
        const own = locator.page().locator(`label[for="${CSS_ESCAPE(field.id)}"]`);
        if (await own.count().catch(() => 0) > 0) {
            try {
                await own.first().click({ timeout: 5_000 });
                return 'label';
            } catch { /* fall through */ }
        }
    }

    await locator.check({ force: true, timeout: 5_000 });
    return 'forced';
};

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

/** Which group a control belongs to. Never an empty string, so groups cannot merge. */
const groupOf = (f) => f.groupKey || f.name || `solo-${f.index}`;

/**
 * The question without the mark that says it is required.
 *
 * The asterisk has already been read by then — it is one of the things that
 * makes a group required — and keeping it would put "Can you start
 * immediately?*" in front of the consultant and bank it under that name. The
 * normaliser drops asterisks anyway, so an answer banked either way still
 * matches; this is about what a person reads.
 */
const asAsked = (label) => String(label ?? '').replace(/[\s*]+$/, '').trim();

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

        if (f.type === 'file') {
            if (resumePath && !attachedResume) {
                await el(locators, f).setInputFiles(resumePath);
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

        // ── RADIOS ARE DECIDED AS A GROUP ─────────────────────────────
        //
        // Handled before the "already filled in" rule below, because for a
        // radio that question can only be answered by looking at the whole
        // group: one option being unchecked says nothing about whether the
        // question has been answered.
        if (f.type === 'radio') {
            const key = groupOf(f);
            if (answeredGroups.has(key)) continue;
            answeredGroups.add(key);

            const siblings = fields.filter((s) => s.type === 'radio' && groupOf(s) === key);
            const question = asAsked(f.groupLabel || f.label);
            // A group whose question cannot be read is left entirely alone.
            // Reporting "Yes" as an unanswered question would put nonsense in
            // front of the consultant and bank an answer to it.
            if (!question) continue;

            const required = siblings.some((s) => s.required);

            // The portal has already chosen for this group — LinkedIn's resume
            // step arrives with the most recent file selected.
            if (siblings.some((s) => s.hasValue)) {
                qa.push({
                    questionText: question,
                    answerText: siblings.find((s) => s.hasValue)?.label
                        ?? '[already chosen by the portal]',
                    fieldType: 'radio',
                    source: 'PORTAL',
                    questionId: null,
                });
                continue;
            }

            const found = resolveAnswer(question, book);
            const match = found
                ? chooseOption(siblings.map((s) => s.label), found.value)
                : null;
            const target = match ? siblings.find((s) => s.label === match) : null;

            if (!target) {
                // The options come with it. A question the app cannot answer is
                // about to be put in front of a person, and "pick one of these"
                // is a different request from "write something" — the asker
                // should be able to see which it is.
                unknown.push({
                    questionText: question,
                    fieldType: 'radio',
                    required,
                    options: siblings.map((s) => s.label).filter(Boolean),
                });
                continue;
            }

            await checkControl(el(locators, target), target);
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

        const question = asAsked(f.label);
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

        const found = resolveAnswer(question, book);
        if (!found) {
            unknown.push({
                questionText: question,
                fieldType: f.type,
                required: f.required,
                options: f.options,
            });
            continue;
        }

        if (f.tag === 'select') {
            const match = chooseOption(f.options, found.value);
            if (!match) {
                unknown.push({
                    questionText: question,
                    fieldType: 'select',
                    required: f.required,
                    options: f.options,
                });
                continue;
            }
            await el(locators, f).selectOption({ label: match });
            qa.push({
                questionText: question,
                answerText: match,
                fieldType: 'select',
                source: found.source,
                questionId: found.questionId,
            });
        } else if (f.type === 'checkbox') {
            if (!isAffirmative(found.value)) continue;
            await checkControl(el(locators, f), f);
            qa.push({
                questionText: question,
                answerText: 'Yes',
                fieldType: 'checkbox',
                source: found.source,
                questionId: found.questionId,
            });
        } else {
            const control = el(locators, f);
            // Human-paced (R-19). One randomised delay per field rather than a
            // constant per-character delay, which is itself a signature.
            await control.click();
            await control.fill('');
            await control.pressSequentially(String(found.value), {
                delay: Math.round(rand(typing.minMs, typing.maxMs)),
            });

            // A typeahead is not finished when the text is right — it is
            // finished when an option has been CHOSEN. See pickSuggestion.
            const chosen = await pickSuggestion(
                page, control, String(found.value), book.values.state,
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

/** The locator for one described field. */
function el(locators, field) {
    return locators.nth(field.index);
}

module.exports = {
    fillForm, describeFields, checkControl, groupOf, asAsked,
    FIELD_SELECTOR, IGNORED_TYPES,
};
