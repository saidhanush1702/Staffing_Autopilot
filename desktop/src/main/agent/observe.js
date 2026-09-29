/**
 * ── WHAT THE AGENT SEES ───────────────────────────────────────────────
 *
 * One turn of the agent begins here: the page in front of the consultant,
 * turned into a compact description a model can reason about, plus a private
 * registry that lets the desktop act on whatever the model points at.
 *
 * ── REFS, NOT SELECTORS ───────────────────────────────────────────────
 *
 * Every field and control is stamped with a `data-sa-ref` attribute the first
 * time it is seen, and keeps it for as long as the element lives. The model
 * says "F0f12"; the desktop finds `[data-sa-ref="F0f12"]`. Two things follow:
 *
 *   · the model never writes a selector, so it cannot aim at something that
 *     was not on the page it was shown
 *   · a ref survives the page re-rendering around it — a field filled on turn
 *     three is still F0f12 on turn four — which a positional index would not
 *
 * The frame index leads the ref, because Greenhouse and others put the whole
 * application inside an iframe, and a ref has to say which document it is in.
 *
 * ── WHAT IS DELIBERATELY NOT SENT ─────────────────────────────────────
 *
 * The consultant's own values. A text field that holds something is described
 * as "(filled)", never by its contents — the email the portal pre-filled, the
 * phone number typed a turn ago. Choices are sent as the option chosen ("Yes",
 * "India"), because the model cannot tell whether a question is answered
 * otherwise and an option label is the form's words, not the consultant's.
 *
 * ── WHY THE FILLER'S OWN READER IS REUSED ─────────────────────────────
 *
 * `describeFields` already knows LinkedIn's invisible radios, Workday's button
 * dropdowns and the unlabelled question paragraph. The agent reading forms
 * differently from the recipes would mean two sets of bugs; reading them the
 * same way means every fix to one is a fix to both.
 */
const {
    describeFields, FIELD_SELECTOR, IGNORED_TYPES, groupOf, asAsked,
} = require('../browser/filler.js');

const CONTROL_SELECTOR = [
    'button', 'a[href]', '[role="button"]', '[role="tab"]', '[role="link"]',
    'input[type="submit"]', 'input[type="button"]',
].join(', ');

const LIMITS = {
    fields: 80, controls: 45, options: 25, label: 160, headings: 10, errors: 6, text: 1_200,
};

/** Words that make a control worth showing ahead of navigation furniture. */
const ACTION_WORDS = /\b(apply|next|continue|review|submit|save|start|upload|attach|resume|cv|sign in|log in|create account|accept|agree|close|dismiss|got it|back|manually|proceed)\b/i;

/**
 * A challenge the consultant has to clear. Only the ones that are actually
 * shown: reCAPTCHA's invisible badge sits on thousands of ordinary forms and is
 * not a challenge until its `bframe` appears.
 */
const CHALLENGE_SRC = /captcha-delivery|datadome|hcaptcha\.com|challenges\.cloudflare\.com|recaptcha\/api2\/bframe|arkoselabs|funcaptcha/i;

const clip = (s, n) => {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const framesOf = (page) => (typeof page.frames === 'function' ? page.frames() : [page]);

/**
 * Stamp and read one frame. Runs in the browser.
 *
 * Returns the refs of every field in the same document order `describeFields`
 * reads them in, so the two lists zip together by position.
 */
const readFrame = (frame, key, root) => frame.evaluate(({
    fieldSel, controlSel, frameKey, rootSel, limits, action, challenge,
}) => {
    const ACTION = new RegExp(action.source, action.flags);
    const CHALLENGE = new RegExp(challenge.source, challenge.flags);
    const clean = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

    const found = rootSel ? document.querySelector(rootSel) : null;
    const scope = found ?? document.body ?? document.documentElement;
    if (!scope) return null;

    window.__saSeq = window.__saSeq || 0;
    const stamp = (el, kind) => {
        const had = el.getAttribute('data-sa-ref');
        if (had && had.startsWith(frameKey)) return had;
        window.__saSeq += 1;
        const ref = `${frameKey}${kind}${window.__saSeq}`;
        el.setAttribute('data-sa-ref', ref);
        return ref;
    };
    const shown = (el) => {
        const s = window.getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return s.display !== 'none' && s.visibility !== 'hidden'
            && Number(s.opacity) !== 0 && r.width > 0 && r.height > 0;
    };

    const fieldRefs = [...scope.querySelectorAll(fieldSel)].map((el) => stamp(el, 'f'));

    // ── controls, most useful first ───────────────────────────────────
    //
    // A job page carries a hundred navigation links. Capped blindly, the
    // Apply button is the one that falls off the end — so controls that say
    // something about applying, or sit inside the form, are chosen first and
    // then put back in page order so the description still reads naturally.
    const inForm = (el) => Boolean(el.closest(
        'form, main, [role="main"], [role="dialog"], dialog, [aria-modal="true"]',
    ));
    const candidates = [];
    [...scope.querySelectorAll(controlSel)].forEach((el, order) => {
        // A button that opens a listbox is a FIELD (Workday's dropdowns).
        if (el.matches(fieldSel) && !el.matches('input[type="submit"], input[type="button"]')) return;
        if (!shown(el)) return;
        const text = clean(
            el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title'),
            limits.label,
        );
        if (!text) return;
        candidates.push({
            el, order, text, score: (ACTION.test(text) ? 2 : 0) + (inForm(el) ? 1 : 0),
        });
    });
    candidates.sort((a, b) => b.score - a.score || a.order - b.order);
    const controls = candidates.slice(0, limits.controls)
        .sort((a, b) => a.order - b.order)
        .map(({ el, text }) => {
            const out = { ref: stamp(el, 'c'), kind: el.tagName === 'A' ? 'link' : 'button', text };
            if (el.tagName === 'A' && el.href) {
                try {
                    const u = new URL(el.href);
                    out.to = u.host === location.host ? clean(u.pathname, 80) : u.host;
                } catch { /* not a URL a person could follow either */ }
            }
            if (el.disabled || el.getAttribute('aria-disabled') === 'true') out.disabled = true;
            return out;
        });

    const uniq = (xs) => [...new Set(xs.filter(Boolean))];
    const headings = uniq([...scope.querySelectorAll('h1, h2, h3, legend, [role="heading"]')]
        .filter(shown).map((h) => clean(h.innerText, 120))).slice(0, limits.headings);

    // What the form is complaining about. Length-capped so a container whose
    // class happens to mention "error" cannot pour a whole page in.
    const errors = uniq([...scope.querySelectorAll(
        '[role="alert"], [aria-live="assertive"], .error, .errors, [class*="error" i], [id*="error" i]',
    )].filter(shown).map((e) => clean(e.innerText, 240)).filter((t) => t.length <= 200))
        .slice(0, limits.errors);

    const passwordVisible = [...scope.querySelectorAll('input[type="password"]')].some(shown);

    const challenged = [...document.querySelectorAll('iframe')].some((f) => {
        if (!CHALLENGE.test(f.src || '')) return false;
        const r = f.getBoundingClientRect();
        return shown(f) && r.width > 100 && r.height > 100;
    }) || Boolean(document.querySelector('#challenge-form, #datadome-captcha'));

    return {
        scoped: Boolean(found),
        fieldRefs,
        controls,
        headings,
        errors,
        passwordVisible,
        challenge: challenged,
        title: clean(document.title, 160),
        text: clean(scope.innerText, limits.text),
    };
}, {
    fieldSel: FIELD_SELECTOR,
    controlSel: CONTROL_SELECTOR,
    frameKey: key,
    rootSel: root,
    limits: LIMITS,
    action: { source: ACTION_WORDS.source, flags: ACTION_WORDS.flags },
    challenge: { source: CHALLENGE_SRC.source, flags: CHALLENGE_SRC.flags },
});

/** One field as the model sees it. */
const entryFor = (ref, f) => {
    const type = f.tag === 'select' ? 'select' : f.type;
    const label = type === 'checkbox' && f.groupLabel
        ? `${asAsked(f.groupLabel)} — ${asAsked(f.label)}`
        : asAsked(f.label) || f.name;
    const entry = { ref, type, label: clip(label, LIMITS.label) };
    if (f.required) entry.required = true;

    // A choice is described by the option chosen; typed text only by the fact
    // that there is some. See the header.
    const isChoice = ['select', 'dropdown', 'checkbox'].includes(type);
    if (f.hasValue) {
        entry.value = type === 'checkbox' ? 'checked'
            : (isChoice ? clip(f.value, 80) || '(chosen)' : '(filled)');
    } else {
        entry.value = '';
    }

    if (Array.isArray(f.options) && f.options.length > 0) {
        const opts = f.options.filter(Boolean);
        entry.options = opts.slice(0, LIMITS.options).map((o) => clip(o, 80));
        if (opts.length > LIMITS.options) entry.moreOptions = opts.length - LIMITS.options;
    }
    return entry;
};

/**
 * Describe the page.
 *
 * @param root  a container to prefer, when a recipe knows where its form lives.
 *              Ignored when it no longer matches — a recipe that failed because
 *              the page moved is exactly when its selector is wrong.
 * @returns {{ observation, registry: Map, signature: string }}
 */
const observe = async (page, { root = null } = {}) => {
    const frames = framesOf(page);
    const registry = new Map();
    const fields = [];
    const controls = [];
    const headings = [];
    const errors = [];
    let title = '';
    let text = '';
    let challenge = false;
    let passwordVisible = false;

    for (let fi = 0; fi < frames.length && fi < 8; fi += 1) {
        const frame = frames[fi];
        if (fi > 0) {
            if (frame.isDetached?.()) continue;
            if (!/^https?:/i.test(frame.url?.() ?? '')) continue;
        }
        const key = `F${fi}`;

        let raw;
        try {
            raw = await readFrame(frame, key, fi === 0 ? root : null);
        } catch {
            continue;                     // cross-origin quirks, a frame mid-navigation
        }
        if (!raw) continue;

        if (fi === 0) { title = raw.title; text = raw.text; }
        challenge = challenge || raw.challenge;
        passwordVisible = passwordVisible || raw.passwordVisible;
        headings.push(...raw.headings);
        errors.push(...raw.errors);

        let described = [];
        if (raw.fieldRefs.length > 0) {
            try {
                described = await describeFields(frame, raw.scoped ? root : null);
            } catch {
                described = [];
            }
        }

        // Radios are one question per group, exactly as the filler treats them.
        const groups = new Map();
        described.forEach((f, i) => {
            const ref = raw.fieldRefs[i];
            if (!ref) return;
            if (IGNORED_TYPES.has(f.type) || f.disabled || !f.visible) return;

            if (f.type === 'radio') {
                const gk = groupOf(f);
                let g = groups.get(gk);
                if (!g) {
                    g = { ref, field: f, members: [] };
                    groups.set(gk, g);
                    fields.push({ group: g, frameIndex: fi });
                }
                g.members.push({ ref, field: f });
                return;
            }

            registry.set(ref, { kind: 'field', frameIndex: fi, ref, field: f });
            fields.push({ entry: entryFor(ref, f) });
        });

        for (const g of groups.values()) {
            registry.set(g.ref, {
                kind: 'group', frameIndex: fi, ref: g.ref, field: g.field, members: g.members,
            });
        }

        for (const c of raw.controls) {
            registry.set(c.ref, { kind: 'control', frameIndex: fi, ref: c.ref, text: c.text });
            controls.push(c);
        }
    }

    const described = fields.slice(0, LIMITS.fields).map((slot) => {
        if (slot.entry) return slot.entry;
        const { group } = slot;
        const chosen = group.members.find((m) => m.field.hasValue);
        const entry = {
            ref: group.ref,
            type: 'radio',
            label: clip(asAsked(group.field.groupLabel || group.field.label), LIMITS.label),
            options: group.members.map((m) => clip(m.field.label, 80)).filter(Boolean),
            value: chosen ? clip(chosen.field.label, 80) || '(chosen)' : '',
        };
        if (group.members.some((m) => m.field.required)) entry.required = true;
        return entry;
    });

    const url = typeof page.url === 'function' ? page.url() : '';
    const uniq = (xs) => [...new Set(xs)];

    const observation = {
        url,
        title,
        headings: uniq(headings).slice(0, LIMITS.headings),
        errors: uniq(errors).slice(0, LIMITS.errors),
        fields: described,
        controls,
        // The page's own words matter most when there is little form to read:
        // "this job is no longer accepting applications" lives in text, not fields.
        text: clip(text, described.length < 3 ? LIMITS.text : 400),
    };
    if (challenge) observation.challenge = true;
    if (passwordVisible) observation.passwordField = true;

    const signature = [
        url,
        described.map((e) => `${e.ref}=${e.value}`).join(','),
        observation.headings.slice(0, 4).join('/'),
        controls.length,
    ].join('|');

    return { observation, registry, signature };
};

/** The live element behind a ref, or null when it has gone. */
const locate = async (page, frameIndex, ref) => {
    const frames = framesOf(page);
    const candidates = [frames[frameIndex], ...frames].filter(Boolean);
    for (const frame of candidates) {
        try {
            const l = frame.locator(`[data-sa-ref="${ref}"]`).first();
            if (await l.count() > 0) return l;
        } catch { /* detached frame */ }
    }
    return null;
};

/**
 * Something the filler's dropdown and typeahead helpers can drive.
 *
 * Those helpers look for listboxes with `page.locator` and press Escape on
 * `page.keyboard`. A frame has the first and not the second, so a field inside
 * an iframe gets a small stand-in that looks in the frame and types on the page.
 */
const pageLikeFor = (page, frameIndex) => {
    const frame = framesOf(page)[frameIndex];
    if (!frame || frameIndex === 0) return page;
    return {
        locator: (s) => frame.locator(s),
        keyboard: page.keyboard,
        waitForTimeout: (ms) => page.waitForTimeout(ms),
    };
};

/** For a sign-in wait: does the page still ask for a password? */
const stillAsksForPassword = async (page) => {
    for (const frame of framesOf(page)) {
        try {
            const n = await frame.locator('input[type="password"]:visible').count();
            if (n > 0) return true;
        } catch { /* ignore */ }
    }
    return false;
};

/** For a bot-check wait: is a challenge still on screen? */
const stillChallenged = async (page) => {
    try {
        const { observation } = await observe(page);
        return Boolean(observation.challenge);
    } catch {
        return false;
    }
};

module.exports = {
    observe, locate, pageLikeFor, stillAsksForPassword, stillChallenged,
    LIMITS, CONTROL_SELECTOR, CHALLENGE_SRC,
};
