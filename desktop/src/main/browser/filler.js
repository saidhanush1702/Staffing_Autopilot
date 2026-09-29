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

/**
 * Every control we consider. Order here defines the index we act on.
 *
 * ── WHY A BUTTON IS IN THIS LIST ──────────────────────────────────────
 *
 * Workday does not use <select>. Its dropdowns are buttons that open a
 * listbox:
 *
 *     <button aria-haspopup="listbox" aria-label="State Select One">
 *       Select One
 *     </button>
 *
 * Reading only inputs meant "State", "Country" and "Phone Device Type" were
 * invisible to the filler — three REQUIRED fields it could neither fill nor
 * report, so it pressed Save and Continue into a form that refused to move and
 * had no idea why.
 *
 * `aria-haspopup="listbox"` is what makes this safe to widen: it is a promise
 * about behaviour, not a guess at a class, and an ordinary button that does
 * something else does not carry it.
 */
const DROPDOWN_SELECTOR = 'button[aria-haspopup="listbox"], [role="combobox"][aria-haspopup="listbox"]';
const FIELD_SELECTOR = `input, textarea, select, ${DROPDOWN_SELECTOR}`;

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
 * ── WHY EVERY FIELD CARRIES A STAMP, NOT JUST A POSITION ──────────────
 *
 * `describeFields` used to hand back only `index` — a field's position in
 * the selector's match list AT SCAN TIME — and `fillForm` acted on fields
 * later by re-querying that same selector and taking `.nth(index)`. That is
 * exactly right for a form that holds still, and exactly wrong for one that
 * does not: Workday rebuilds a step the moment an earlier answer picks a
 * country, and a field an EARLIER pass answered can grow a brand new one
 * — "Visa type" appearing right after "Are you authorized to work here?" —
 * between the fields that were already read and the ones still to be acted
 * on, in the SAME pass.
 *
 * Measured, not assumed: with Email at index 1 and Phone at index 2 when the
 * pass started, answering the field ahead of them inserted one new control
 * between the two groups. `.nth(1)` and `.nth(2)` then pointed at the NEW
 * field and at Email — so Email's value went into "Visa type" and Phone's
 * went into the Email box, while the review screen still labelled each
 * answer with the QUESTION it was meant for, not the box it actually landed
 * in. An application can go to an employer with every visible answer wrong
 * and nothing on screen saying so.
 *
 * The fix is the same one `agent/observe.js` already uses for exactly this
 * reason: stamp the element itself, the first time it is seen, with an
 * attribute nothing else on the page has any reason to write. Re-finding it
 * later means asking for that attribute, which names one exact DOM node
 * regardless of what has been inserted or removed around it — not "whatever
 * is now in this position". Idempotent, so a field already stamped by an
 * earlier pass — the multi-pass loop in applyFlow.js, or a second wizard
 * step — is not restamped, and the same field keeps the same identity across
 * everything this form does on it.
 */
const STAMP_ATTR = 'data-sa-filler-ref';

/**
 * Describe every field on the page.
 *
 * Runs in the browser, and deliberately returns plain data rather than handles,
 * so every decision happens in Node where it can be tested.
 */
const describeFields = (page, root = null) => page.$$eval(
    root ? `${root} ${FIELD_SELECTOR.split(', ').join(`, ${root} `)}` : FIELD_SELECTOR,
    (nodes, stampAttr) => {
    const text = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
    /** What a dropdown says when nothing has been chosen. */
    const PLACEHOLDER = /^(select one|select\.\.\.|select|choose one|choose|--+|none)$/i;

    /** Give this exact element a stable name, or read back the one it has. */
    const stamp = (el) => {
        const had = el.getAttribute(stampAttr);
        if (had) return had;
        window.__saFillerSeq = (window.__saFillerSeq ?? 0) + 1;
        const ref = `f${window.__saFillerSeq}`;
        el.setAttribute(stampAttr, ref);
        return ref;
    };

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
     *
     * ── AND WHY EVERY STEP IS CHECKED AGAINST THE QUESTION ITSELF ────
     *
     * Measured on a real LinkedIn screening question: both radios' native
     * inputs carried `aria-labelledby` pointing at the SAME shared heading —
     * the question the whole group was asking, not each option's own "Yes" or
     * "No". `labelFor`'s chain reads `aria-labelledby` ahead of a wrapping
     * `<label>`, so it returned the question, twice, once per option, and
     * neither result was wrong exactly — it was just the wrong QUESTION,
     * repeated. From there it got worse in both directions: the option "Yes"
     * or "No" chosen by the consultant could never be told apart from the
     * question was asking, so it was reported back as an unanswered question
     * whose two "answers" were both the question again — and the one time it
     * WAS picked up as answered, what got saved to the bank was the question,
     * not "Yes" or "No" at all.
     *
     * So nothing here is trusted just because a value was found. Every
     * candidate is checked against `groupLabelFor` — the group's own
     * question, using the identical ladder that reads it — and skipped if it
     * is the same thing. `closest('label')` is also tried before
     * `aria-labelledby` now, not after: a wrapping `<label>` can only ever be
     * describing the one control it wraps, where `aria-labelledby` can point
     * anywhere a form author chose, including at something shared.
     */
    const optionLabelFor = (el) => {
        const question = clean(groupLabelFor(el)).replace(/[\s*]+$/, '').toLowerCase();
        const isTheQuestion = (s) => {
            const c = clean(s).replace(/[\s*]+$/, '').toLowerCase();
            return Boolean(c) && Boolean(question) && c === question;
        };

        const proxy = proxyFor(el);
        if (proxy) {
            const aria = proxy.getAttribute('aria-label');
            if (aria && aria.trim() && !isTheQuestion(aria)) return aria.trim();
            const own = text(proxy);
            if (own && !isTheQuestion(own)) return own;
        }

        const ownAria = el.getAttribute('aria-label');
        if (ownAria && ownAria.trim() && !isTheQuestion(ownAria)) return ownAria.trim();

        if (el.id) {
            const explicit = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
            if (text(explicit) && !isTheQuestion(text(explicit))) return text(explicit);
        }

        const wrapping = el.closest('label');
        if (text(wrapping) && !isTheQuestion(text(wrapping))) return text(wrapping);

        // Last resort, and the one most likely to just repeat the question —
        // see above. Tried anyway, in case it is genuinely all a board gives.
        const by = el.getAttribute('aria-labelledby');
        if (by) {
            const joined = by.split(/\s+/)
                .map((id) => text(document.getElementById(id)))
                .filter(Boolean).join(' ');
            if (joined && !isTheQuestion(joined)) return joined;
        }

        // A generated group id is not a name anybody chose.
        const name = el.getAttribute('name') || '';
        return isTheQuestion(name) ? '' : name;
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

    /**
     * The question a Workday dropdown is asking.
     *
     * Its accessible name is the question, the current value and sometimes the
     * word "Required", run together:
     *
     *     "State Select One"              -> State
     *     "Country India Required"        -> Country
     *     "Phone Device Type Mobile Required" -> Phone Device Type
     *
     * The visible text IS the current value, so peeling that off the end —
     * along with "Required" — leaves the question. Anything unexpected falls
     * back to the whole label, which is wrong but harmless: it becomes a
     * question nobody has answered rather than a wrong answer.
     */
    const dropdownParts = (el) => {
        const current = text(el);
        let question = clean(el.getAttribute('aria-label') || '');
        if (!question) return { question: current, current: '' };
        question = question.replace(/\s*Required\s*$/i, '').trim();
        if (current && question.toLowerCase().endsWith(current.toLowerCase())) {
            question = question.slice(0, question.length - current.length).trim();
        }
        return { question: question || clean(el.getAttribute('aria-label')), current };
    };

    return nodes.map((el, index) => {
        const tag = el.tagName.toLowerCase();
        // ── A SEARCH BOX THAT IS REALLY A DROPDOWN ────────────────
        //
        // Workday's "How Did You Hear About Us?" is an <input> with a
        // placeholder of "Search", wrapped in a multiselect widget:
        //
        //   <div data-uxi-widget-type="multiselect">
        //     <input data-uxi-widget-type="selectinput" placeholder="Search">
        //     <div data-automation-id="promptSelectionLabel"></div>
        //     <div data-automation-id="promptAriaInstruction">0 items selected</div>
        //
        // Being an input, it was typed into — which FILTERS the list and
        // selects nothing. The box then still holds "0 items selected", the
        // form rejects it, and nothing on the page says why.
        //
        // `data-uxi-widget-type` is Workday's own semantic attribute, the same
        // family as `data-automation-id`, so this recognises the widget rather
        // than guessing from a class or a placeholder.
        const promptBox = el.closest('[data-uxi-widget-type="multiselect"]');
        const isPrompt = Boolean(promptBox)
            || el.getAttribute('data-uxi-widget-type') === 'selectinput';
        const isDropdown = el.getAttribute('aria-haspopup') === 'listbox' || isPrompt;
        const type = isDropdown ? 'dropdown'
            : (el.getAttribute('type') || (tag === 'select' ? 'select' : 'text')).toLowerCase();
        const isOption = type === 'radio' || type === 'checkbox';
        // A prompt widget already has a proper <label for>, so the question
        // needs no unpicking — only the CHOSEN VALUE has to be found, and it
        // lives in a sibling rather than in the input.
        const promptChosen = promptBox
            ? clean(promptBox.querySelector('[data-automation-id="promptSelectionLabel"]')?.textContent)
            : '';
        const drop = isDropdown
            ? (isPrompt
                ? { question: labelFor(el), current: promptChosen }
                : dropdownParts(el))
            : null;
        const style = window.getComputedStyle(el);
        const label = isDropdown ? drop.question
            : (isOption ? optionLabelFor(el) : labelFor(el));
        const groupLabel = isOption ? groupLabelFor(el) : '';
        const box = isOption ? groupBoxFor(el) : null;
        const proxy = isOption ? proxyFor(el) : null;
        const proxyStyle = proxy ? window.getComputedStyle(proxy) : null;
        const rect = el.getBoundingClientRect();

        return {
            index,
            // The stable identity — see the note on STAMP_ATTR above. `index`
            // stays, for the fallback tests and any caller still using it,
            // but `fillForm` itself always prefers `stampRef` when it is set.
            stampRef: stamp(el),
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
                // Workday says so in the accessible name rather than with an
                // attribute: "Country India Required".
                || (isDropdown && /\brequired\b/i.test(el.getAttribute('aria-label') || ''))
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
            // ── WHAT IS ACTUALLY IN THE BOX ───────────────────────────
            //
            // Reported so that an answer the CONSULTANT typed into the form
            // can be read back and banked, turning a one-off into something
            // every future application benefits from.
            //
            // Never for a password: R-18 says this app holds no portal
            // credential, and a descriptor carrying one would smuggle it into
            // logs, IPC and the review screen. The refusal lives here, at the
            // only place that could read it, rather than being left to callers
            // to remember.
            value: type === 'password' || type === 'file' ? ''
                : (isDropdown ? (PLACEHOLDER.test(drop.current) ? '' : drop.current)
                    : (isOption ? (el.checked ? (label || 'Yes') : '') : String(el.value ?? ''))),
            hasValue: Boolean(
                isDropdown
                    // "Select One" is Workday's word for empty. Treating it as
                    // a value would mark every untouched dropdown as already
                    // answered — the same mistake `value: "on"` made for radios.
                    ? (drop.current && !PLACEHOLDER.test(drop.current))
                    : isOption
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
    STAMP_ATTR,
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

/** How long to give a listbox to open and populate. */
const LISTBOX_WAIT_MS = 4_000;

/**
 * Choose a value from a dropdown that is not a <select>.
 *
 * ── WHAT THESE ARE ────────────────────────────────────────────────────
 *
 * Measured on a live Workday application:
 *
 *     <button aria-haspopup="listbox" aria-label="State Select One">
 *       Select One
 *     </button>
 *
 * Clicking it grows a `[role="listbox"]` somewhere in the document — NOT
 * inside the button, and often not inside the form either, because these
 * render in a portal at the end of <body>. That is why the options are looked
 * for on the page rather than under the control.
 *
 * ── WHY THE OPTIONS ARE READ RATHER THAN GUESSED ──────────────────────
 *
 * 250 countries, 37 Indian states. The answer bank holds "Telangana"; the list
 * holds "Telangāna" with a macron. `chooseOption` is the same strict matcher
 * used everywhere else — exact first, then a unique prefix — so an ambiguous
 * or absent match chooses NOTHING and the question is reported unanswered.
 * A wrong state on somebody's application is worse than an empty one.
 *
 * @returns the option text chosen, or null when nothing matched
 */
const chooseFromDropdown = async (page, locator, answer, log = () => {}) => {
    if (typeof page.locator !== 'function') return null;

    await locator.click({ timeout: 5_000 }).catch(() => {});

    // ── ANSWERS THAT DRILL DOWN ───────────────────────────────────────
    //
    // Workday's "How Did You Hear About Us?" is two levels deep: a category
    // list (Employee Referral, Job Board, Social Network...) where every entry
    // opens a second list of specific sources. One flat answer cannot say
    // which of each, so an answer may name the path:
    //
    //     "Job Board > LinkedIn"
    //
    // A one-level dropdown ignores the separator entirely, because it only
    // ever reaches the first part.
    const steps = String(answer).split(/\s*(?:>|\u2192|\/)\s*/).filter(Boolean);
    let chosen = null;

    for (const [depth, want] of steps.entries()) {
        const picked = await pickFromOpenList(page, want, log);
        if (!picked) {
            if (depth === 0) {
                // Nothing at the top level matched: close up rather than
                // leaving a list hanging over the rest of the form.
                await page.keyboard.press('Escape').catch(() => {});
                return null;
            }
            // The path was partly walked. Stop and report it unanswered
            // rather than leaving a half-made choice standing.
            log(`"${want}" was not in the list that opened`);
            await page.keyboard.press('Escape').catch(() => {});
            return null;
        }
        chosen = chosen ? `${chosen} > ${picked}` : picked;

        // Workday re-renders after a choice — picking a country replaces the
        // State list entirely — so let it settle before reading anything else.
        await page.waitForTimeout(1_200);
    }

    // ── DID IT ACTUALLY TAKE? ─────────────────────────────────────────
    //
    // A category with a submenu selects NOTHING by itself: the widget still
    // reads "0 items selected" and the form will refuse. If a list is still
    // open and the answer had no further parts, the answer was incomplete —
    // better reported as unanswered than left looking done.
    const stillOpen = await page.locator('[role="listbox"] [role="option"]')
        .count().catch(() => 0);
    if (stillOpen > 0 && steps.length === 1) {
        const settled = await locator.evaluate((el) => {
            const box = el.closest('[data-uxi-widget-type="multiselect"]');
            if (!box) return true;              // not a prompt; nothing to check
            const label = box.querySelector('[data-automation-id="promptSelectionLabel"]');
            return Boolean((label?.textContent ?? '').trim());
        }).catch(() => true);

        if (!settled) {
            log(`"${chosen}" opened another list — the answer needs to say which one, `
                + 'for example "Job Board > LinkedIn"');
            await page.keyboard.press('Escape').catch(() => {});
            return null;
        }
    }

    await page.keyboard.press('Escape').catch(() => {});
    return chosen;
};

/**
 * Pick one entry from whichever list is currently open.
 *
 * The list is found on the PAGE rather than under the control: Workday renders
 * these in a portal at the end of <body>, so they are nowhere near the field
 * they belong to. Where several are open at once — a phone-code picker sits
 * open beside the one being asked for — the one with the most options is the
 * one that just appeared.
 *
 * @returns the option text clicked, or null when nothing matched
 */
const pickFromOpenList = async (page, want, log = () => {}) => {
    const deadline = Date.now() + LISTBOX_WAIT_MS;
    let options = null;
    while (Date.now() < deadline) {
        const found = page.locator('[role="listbox"] [role="option"]');
        if (await found.count().catch(() => 0) > 0) { options = found; break; }
        await page.waitForTimeout(250);
    }
    if (!options) {
        log('the dropdown did not open');
        return null;
    }

    const count = await options.count();
    const texts = [];
    for (let i = 0; i < Math.min(count, 400); i += 1) {
        texts.push(((await options.nth(i).innerText().catch(() => '')) || '')
            .replace(/\s+/g, ' ').trim());
    }

    // The same strict matcher used everywhere else: exact, then a unique
    // prefix, then nothing. 250 countries and 37 states are exactly where a
    // loose match would quietly put the wrong thing on an application.
    const match = chooseOption(texts, want);
    if (!match) return null;

    await options.nth(texts.indexOf(match)).click({ timeout: 5_000 }).catch(() => {});
    return match;
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
                    // The option's own name — "vishwa_resume.pdf" — rather
                    // than a note saying something was chosen.
                    answerText: siblings.find((s) => s.hasValue)?.label
                        || '[already chosen by the portal]',
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

        // ── A DROPDOWN THAT IS NOT A <select> ─────────────────────────
        //
        // Handled before the "already filled in" rule below, because for these
        // "filled" means something specific: Workday shows "Select One" when
        // nothing has been chosen, and that is emptiness wearing a value's
        // clothes. `hasValue` already knows the difference.
        if (f.type === 'dropdown') {
            if (f.hasValue) {
                qa.push({
                    questionText: question,
                    answerText: f.value,
                    fieldType: 'dropdown',
                    source: 'PORTAL',
                    questionId: null,
                });
                continue;
            }

            const found = resolveAnswer(question, book);
            if (!found) {
                unknown.push({
                    questionText: question, fieldType: 'dropdown', required: f.required,
                });
                continue;
            }

            const chosen = await chooseFromDropdown(page, el(locators, f), String(found.value));
            if (!chosen) {
                // Opened, read, and nothing matched. That is a question we
                // cannot answer, not a field to leave silently blank.
                unknown.push({
                    questionText: question, fieldType: 'dropdown', required: f.required,
                });
                continue;
            }

            qa.push({
                questionText: question,
                answerText: chosen,
                fieldType: 'dropdown',
                source: found.source,
                questionId: found.questionId,
            });
            await pause(typing.betweenFieldsMs[0], typing.betweenFieldsMs[1]);
            continue;
        }

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
                // ── SHOW WHAT IT SAYS, NOT THAT IT SAYS SOMETHING ─────
            //
            // This used to read "[already filled in by the portal]", which
            // told the consultant a field was handled without telling them
            // WHAT it was handled with. On a review screen whose whole purpose
            // is reading the application before it goes, that is the one thing
            // worth showing. The value is only unavailable where it must be —
            // a password is never carried at all (R-18).
            answerText: f.value || '[already filled in by the portal]',
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

/**
 * The locator for one described field.
 *
 * `field.stampRef`, when the field carries one, wins over `field.index` — see
 * the note on `STAMP_ATTR` in `describeFields`. It is missing only for a
 * descriptor the unit suite built by hand (no real browser ever ran
 * `describeFields`'s stamping code to produce one), so those fall back to the
 * plain positional lookup exactly as before, unaffected either way since
 * their fakes never mutate the field list mid-pass.
 */
function el(locators, field) {
    if (field.stampRef && typeof locators.page === 'function') {
        return locators.page().locator(`[${STAMP_ATTR}="${CSS_ESCAPE(field.stampRef)}"]`);
    }
    return locators.nth(field.index);
}

/**
 * Put one value into one field, whatever kind of field it is.
 *
 * ── WHY THIS EXISTS BESIDE fillForm ───────────────────────────────────
 *
 * `fillForm` walks a whole page and decides for itself what each field wants.
 * The AI agent decides that differently — one field at a time, with the value
 * already chosen — and needs only the second half: given this control and this
 * text, make the form hold it. The primitives are the same ones `fillForm`
 * uses (the proxy-aware radio click, the Workday listbox, the typeahead pick,
 * the strict option matcher), so the agent inherits every lesson learned the
 * hard way on real forms instead of relearning them.
 *
 * `fillForm` itself is left exactly as it was. Every recipe runs through it,
 * and nothing here is worth a risk to them.
 *
 * @param pageLike  the page, or a stand-in that looks for listboxes in a frame
 * @param target    { locator, field } for one control, or
 *                  { members: [{ locator, field }] } for a radio group
 * @returns {{ ok: true, answerText } | { ok: false, error }}
 */
const fillValue = async (pageLike, target, value, { typing = TYPING, stateHint = null } = {}) => {
    const text = String(value ?? '');

    if (target.members) {
        const labels = target.members.map((m) => m.field.label);
        const match = chooseOption(labels, text);
        if (!match) {
            return {
                ok: false,
                error: `none of the options (${labels.filter(Boolean).slice(0, 8).join(', ')}) `
                    + `matches "${text.slice(0, 60)}"`,
            };
        }
        const chosen = target.members.find((m) => m.field.label === match);
        await checkControl(chosen.locator, chosen.field);
        return { ok: true, answerText: match };
    }

    const { locator, field } = target;

    // R-18, again, at the lowest level: whatever called this, a password
    // field gets nothing.
    if (field.type === 'password') return { ok: false, error: 'password fields are never filled' };
    if (field.type === 'file') return { ok: false, error: 'a file field takes the resume, not text' };

    if (field.type === 'checkbox') {
        if (!isAffirmative(text)) {
            return { ok: false, error: `"${text.slice(0, 40)}" is not a yes, so the box stays unticked` };
        }
        await checkControl(locator, field);
        return { ok: true, answerText: 'Yes' };
    }

    if (field.type === 'radio') {
        await checkControl(locator, field);
        return { ok: true, answerText: field.label || text };
    }

    if (field.type === 'dropdown') {
        const chosen = await chooseFromDropdown(pageLike, locator, text);
        return chosen
            ? { ok: true, answerText: chosen }
            : { ok: false, error: `"${text.slice(0, 60)}" is not one of the choices in that dropdown` };
    }

    if (field.tag === 'select') {
        const match = chooseOption(field.options ?? [], text);
        if (!match) {
            return { ok: false, error: `"${text.slice(0, 60)}" is not one of the options in that list` };
        }
        await locator.selectOption({ label: match });
        return { ok: true, answerText: match };
    }

    await locator.click();
    await locator.fill('');
    await locator.pressSequentially(text, {
        delay: Math.round(rand(typing.minMs, typing.maxMs)),
    });
    const suggested = await pickSuggestion(pageLike, locator, text, stateHint);
    return { ok: true, answerText: suggested ?? text };
};

module.exports = {
    fillForm, fillValue, describeFields, checkControl, chooseFromDropdown, groupOf, asAsked,
    FIELD_SELECTOR, DROPDOWN_SELECTOR, IGNORED_TYPES,
};
