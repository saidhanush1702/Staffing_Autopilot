# Design system

**Read this before writing any UI.** Every surface in this app is defined once.
If you are about to type a Tailwind class string that already exists here, use the
token instead — that is the whole point.

| Where | What lives there |
|---|---|
| `client/src/index.css` `@theme` | **Colours.** Brand, five semantic tones, role accents, audit verbs. |
| `client/src/design/tokens.js` | **Class strings.** Card, input, button, badge, table, tab, modal sizes. |
| `client/src/components/ui/Modal.jsx` | **The** dialog. There is no second modal implementation. |
| `client/src/components/ui/Card.jsx` | The white panel. |
| `client/src/components/ui/Badge.jsx` | Badge + `RoleBadge`. |
| `client/src/context/LookupContext.jsx` | Reference data — role names, statuses, dropdown options. |

---

## 1. Colour

Six tones. Everything that carries **meaning** picks one of them.

| Tone | Means | Use for |
|---|---|---|
| `success` | it worked, it is live, it is approved | Active badge, approved field |
| `warning` | reversible problem, needs attention | Suspended, unassigned, "will be moved" |
| `danger` | refused, failed, or permanent | Terminated, errors, destructive buttons |
| `info` | neutral notice, in progress | Pending, informational banners |
| `brand` | the product's own accent | Active tab, primary button, counts |
| `neutral` | no signal | Chips, counters, secondary text |

```jsx
import { TONE, TONE_ALERT, TONE_TEXT } from '../design/tokens.js';

<span className={`${badge} ${TONE.success}`}>Active</span>
<div className={`rounded-lg p-3 text-sm ${TONE_ALERT.danger}`}>{error}</div>
<AlertCircle className={TONE_TEXT.warning} />
```

**Never** write `bg-red-50 text-red-700` in a component. Raw `slate-*` is still fine
for **structure** — borders, page chrome, muted secondary text. Structure is not meaning.

---

## 2. Popups

Every dialog is `<Modal>`. It guarantees, identically everywhere:

- portalled to `<body>`, so a table's `overflow` cannot clip it
- one backdrop colour, one z-index, one radius, one shadow
- Escape closes, backdrop click closes, and there is always an X
- the page behind cannot scroll while it is open
- header / body / footer with the same borders and padding

### Sizes — the whole scale

| Size | Width | For |
|---|---|---|
| `sm` | `max-w-sm` | confirmations, single-field forms |
| `md` | `max-w-lg` | forms and pickers — **the default** |
| `lg` | `max-w-2xl` | side-by-side or long content |
| `viewer` | full viewport | media, e.g. a resume preview |

Anything not on this scale is a bug, not a special case.

```jsx
import Modal, { ModalActions } from '../components/ui/Modal.jsx';

<Modal
    size="sm"
    tone="danger"
    icon={AlertTriangle}
    title={`Terminate ${user.name}?`}
    onClose={close}
    footer={<ModalActions onCancel={close} onConfirm={run}
                          confirmLabel="Terminate permanently" variant="danger" busy={busy} />}
>
    …body…
</Modal>
```

A dialog that is a form passes `as="form" onSubmit={…}` and gives its confirm button
`confirmType="submit"`.

`ModalActions` exists so Cancel and Confirm sit in the same place with the same
emphasis in every dialog: stacked on phones with confirm on top, side by side from
`sm` up with confirm last.

---

## 3. Cards, inputs, buttons

```jsx
import { card, cardPad, input, fieldLabel, btn, btnSm, iconBtn } from '../design/tokens.js';

<div className={`${card} ${cardPad}`}>…</div>          // or <Card title="…">
<label><span className={fieldLabel}>Name</span>
       <input className={input} /></label>
<button className={btn.primary}>Save</button>
<button className={btnSm.danger}>Terminate</button>     // table-row scale
<button className={iconBtn}><Pencil className="h-3.5 w-3.5" /></button>
```

| Button | When |
|---|---|
| `btn.primary` | the one affirmative action on a screen |
| `btn.secondary` | Cancel, Back — abandons rather than commits |
| `btn.danger` | destructive and irreversible |
| `btn.caution` | reversible but disruptive (suspend, pause) |
| `btn.subtle` | low-emphasis inline action |
| `btn.pill` | the login screen's single full-width action |

Card padding: `cardPadTight` (p-4) · `cardPad` (p-5, default) · `cardPadRoomy` (p-6).

Also in `tokens.js`: `pageTitle`, `pageSubtitle`, `sectionTitle`, `badge`, `countPill`,
`tableHead`/`tableCell`/`tableRow`/`tableEmpty`, `tabBar`/`tabNav`/`tabItem`/`tabActive`/`tabIdle`.

---

## 4. No hardcoded labels — use the lookups

`GET /api/lookups` returns every `lkp_` table in one call. `LookupProvider` fetches
it once per session.

### The rule

A value the **database stores** (`ORG_ADMIN`, `SUSPENDED`) is a **contract**. It belongs
in code — route guards and comparisons must not depend on a network fetch, and a label
change must never break authorisation.

The **text shown to a person** for that value is **not** a contract. It comes from the
lookup table.

```jsx
✅  if (user.role === 'ORG_ADMIN')     // compare against the stored value
✅  <RoleBadge role={u.role} />        // display via the lookup
✅  {roleLabel('RECRUITER')}           // → "Recruiter", from lkp_roles
❌  <span>Organization Admin</span>    // hardcoded label
```

```jsx
import { useLookups } from '../context/LookupContext.jsx';

const { roleLabel, statusLabel, workAuthLabel, options, labelFrom, labelById } = useLookups();

<select>
    {options('workAuthStatuses').map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
</select>
```

If the fetch has not landed yet, labels fall back to a humanised form of the stored
value (`ORG_ADMIN` → `Org Admin`) rather than rendering blank.

### Colour for a looked-up value

The **label** comes from the database; the **colour and icon** are design decisions and
stay in code. `STATUS_TONE` and `ROLE_TONE` in `tokens.js` map a stored value to a tone.

Adding a new employment status is therefore: seed `lkp_user_statuses`, add one line to
`STATUS_TONE`, add one line to `STATUS_ICON` in `EmploymentStatus.jsx`. No screen changes.

---

## 5. Adding something new

1. Does a token already cover it? Use it.
2. Is it a variation of an existing surface? Add a variant **in `tokens.js`**, then use it.
3. Genuinely new shared surface? Define it in `tokens.js` (or as a `ui/` component) first,
   then consume it. Never inline it "just this once" — that is how a design system dies.
4. New dialog? `<Modal>`. Never a fresh `fixed inset-0`.
5. New dropdown of reference data? A lookup table + `useLookups()`. Never a literal array
   of labels.
