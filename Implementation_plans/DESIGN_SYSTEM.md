# Design system

**Read this before writing any UI.** Every surface in both applications is defined once.
If you are about to type a class string that already exists here, use the token instead —
that is the whole point.

| Where | What lives there |
|---|---|
| `client/src/index.css` `@theme` | **Values.** Colour, radius, shadow, type scale, motion, layout constants — and the dark-mode re-point of all of them. |
| `client/src/design/tokens.js` | **Shapes.** Card, input, button, badge, table, tab, nav, modal, empty-state class strings. |
| `client/src/components/ui/` | **Components.** Modal, Card, Badge, Alert, Avatar, StatCard, PageHeader, EmptyState, Brand, ThemeToggle. |
| `client/src/context/ThemeContext.jsx` | Light / dark / system, and the `data-theme` attribute everything is keyed off. |
| `client/src/context/LookupContext.jsx` | Reference data — role names, statuses, dropdown options. |
| `desktop/src/renderer/styles.css` | The **same** system, hand-written for the Electron renderer (no build step, no remote assets). |

---

## 0. Light and dark

Both applications support light, dark, and "follow the system", and **no component knows
which one it is in.**

### How it works

Every colour is a CSS variable. `<html data-theme="dark">` re-points the same variable
names to a second set of values. That single attribute repaints the entire interface —
there is no re-render, no `dark:` twin of every class, and no screen that can be
forgotten when a colour changes.

```
:root                       --color-surface: #ffffff   --color-slate-900: #141a26
:root[data-theme="dark"]    --color-surface: #131926   --color-slate-900: #f0f4fa
```

### The two inversions that make it work

**The neutral ramp inverts.** `slate-50` means *the quietest surface tint* and `slate-900`
means *the loudest text* — those are **roles**, not brightness values. In dark mode the
same roles need different hex codes, so the ramp is re-pointed rather than every component
being rewritten.

**Semantic ramps invert too.** `-50` is always *the quiet tinted background for this
meaning* and `-700` is always *the legible text on top of it*. `bg-danger-50
text-danger-700` is a pale red chip in light mode and a deep red chip with bright red text
in dark mode, from one class string.

### The rules this imposes

| Do | Don't | Why |
|---|---|---|
| `bg-surface` | `bg-white` | White is a light-mode implementation detail; `surface` is the idea. |
| `bg-canvas` | `bg-slate-50` for a page | The page ground is its own token. |
| `bg-overlay/50` | `bg-slate-900/40` | `slate-900` becomes near-white in dark mode — the scrim would white out. |
| `border-line` | `border-slate-200` | Reads as a role. (Both work; `line` says what it is.) |
| `text-white` on a coloured button | — | Correct, and deliberately **not** remapped. A primary button is brand-600 with white text in both themes. |

`text-slate-*` needs no change: the ramp inverts under it.

### No flash on load

`client/index.html` carries a nine-line inline script that stamps `data-theme` **before
the first paint**. If React set it, a dark-mode user would see a white flash for as long
as the bundle takes to parse. The desktop renderer does the same from `theme.js`, imported
at the top of `main.jsx` — its CSP forbids inline scripts, so a local module import is the
earliest point available.

### Using it

```jsx
import { useTheme } from '../context/ThemeContext.jsx';
const { preference, resolved, isDark, setPreference, toggle } = useTheme();
```

`preference` is what the user asked for (`light` / `dark` / `system`); `resolved` is what
is on screen (`light` / `dark`). They are different things — `system` is a valid
preference and never a valid attribute value.

`<ThemeToggle />` is the header's one-click switch. `<ThemeToggle variant="segmented" />`
shows all three settings, for a menu or a settings panel. **Ctrl/⌘ + J** toggles.

---

## 1. Colour

### Brand

An indigo-blue. The blue half reads as trust and infrastructure; the indigo half keeps it
from looking like every other B2B dashboard. `brand-600` is **the** brand colour —
everything else in the ramp exists to support it, and it is the same value in both themes
so a primary button never changes colour.

### The six tones

Everything that carries **meaning** picks one of them.

| Tone | Means | Use for |
|---|---|---|
| `success` | it worked, it is live, it is approved | Active badge, approved field |
| `warning` | reversible problem, needs attention | Suspended, unassigned, "will be moved" |
| `danger` | refused, failed, or permanent | Terminated, errors, destructive buttons |
| `info` | neutral notice, in progress | Pending, informational banners |
| `brand` | the product's own accent | Active tab, primary button, counts |
| `neutral` | no signal | Chips, counters, secondary text |

```jsx
import { TONE, TONE_OUTLINE, TONE_ALERT, TONE_TEXT, TONE_SOLID, TONE_RAIL } from '../design/tokens.js';

<span className={`${badge} ${TONE.success}`}>Active</span>
<span className={`${badge} ${TONE_OUTLINE.danger}`}>Terminated</span>   // on a tinted row
<AlertCircle className={TONE_TEXT.warning} />
<span className={`${statusDot} ${TONE_SOLID.info}`} />
```

**Never** write `bg-red-50 text-red-700` in a component — there is no raw palette colour
left anywhere in `client/src`, and adding one back is a bug. Raw `slate-*` is still
correct for **structure**: borders, chrome, muted text. Structure is not meaning.

For a block-level notice, use the component rather than the token — it picks the icon
from the tone, so an alert whose icon and colour disagree cannot be written:

```jsx
import Alert from '../components/ui/Alert.jsx';
<Alert tone="danger">{error}</Alert>
<Alert tone="warning" title="3 questions waiting on you">…</Alert>
```

### Role, and data visualisation

`--color-role-*` gives each role in the product one colour, so a person's badge is the
same in the sidebar, the user table and the audit log. `--color-viz-1…6` is an ordered
categorical series for charts — hues far enough apart to stay distinguishable side by
side, and all six hold up in both themes.

---

## 2. Type, size, elevation, motion

| Scale | Steps |
|---|---|
| Type | `text-2xs` `xs` `sm` `base` `md` `lg` `xl` `2xl` `3xl` `4xl` `5xl` — each with its own line-height and tracking |
| Radius | `rounded-xs` (4) `sm` (6) `md` (8) `lg` (10) `xl` (12) `2xl` (16) `3xl` (20) `4xl` (28) |
| Shadow | `shadow-xs` `sm` `md` `lg` `xl` `2xl` `shadow-brand` |
| Motion | `animate-fade-in` `rise` `pop` `slide-in` `shimmer` `breathe`; `--ease-out-soft`, `--ease-spring` |
| Layout | `w-sidebar` (17rem) `w-rail` (4.5rem) `h-header` (3.75rem) `max-w-content` (88rem) |

**Radius encodes size.** The bigger the surface, the rounder the corner — a 6px chip and a
6px modal look like a mistake.

**Shadows are two-layer**: one tight contact shadow plus one wide ambient shadow. A single
large blur reads as a smudge. In dark mode they do almost no work — depth comes from the
surface ramp instead — so pair a dark card with the `lit` utility, which adds the hairline
top highlight that stops it reading as a hole in the page.

**Two typefaces.** `font-display` (Plus Jakarta Sans) carries headings and figures;
`font-sans` (Inter) carries everything a person reads a paragraph of. `h1`–`h4` pick up
the display face automatically. `font-mono` is for values that change in place.

Composite effects that a single class cannot express live as utilities in `index.css`:
`.glass` (the sticky translucent header), `.lit`, `.skeleton`, `.grid-fade`,
`.brand-mesh`, `.fade-edge-r`.

---

## 3. Popups

Every dialog is `<Modal>`. It guarantees, identically everywhere:

- portalled to `<body>`, so a table's `overflow` cannot clip it
- one backdrop colour, one blur, one z-index, one radius and shadow
- Escape closes, backdrop click closes, and there is always an X
- the page behind cannot scroll while it is open
- header / body / footer with the same borders and padding

### Sizes — the whole scale

| Size | Width | For |
|---|---|---|
| `sm` | `max-w-sm` | confirmations, single-field forms |
| `md` | `max-w-lg` | forms and pickers — **the default** |
| `lg` | `max-w-2xl` | side-by-side or long content |
| `xl` | `max-w-4xl` | a full working surface inside a dialog |
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

`ModalActions` exists so Cancel and Confirm sit in the same place with the same emphasis
in every dialog: stacked on phones with confirm on top, side by side from `sm` up with
confirm last.

For a record opened beside the list it came from, use `DRAWER_BACKDROP` / `DRAWER_PANEL`.

---

## 4. Cards, inputs, buttons

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
| `btn.ghost` | secondary but still affirmative |
| `btn.pill` | a screen's single full-width action |

`btnSm` is the same intents at table-row scale. `iconBtn` is the icon-only affordance in a
cell; `iconBtnShell` is the bigger one in the app chrome.

Card padding: `cardPadTight` (p-4) · `cardPad` (p-5, default) · `cardPadRoomy` (p-6).
`<Card divided>` promotes the title into a header band — use it when the card holds a list
rather than a paragraph.

### The page skeleton

```jsx
<div className={stack}>
    <PageHeader title="Users" subtitle="…" icon={Users} actions={<button className={btn.primary}>…</button>} />
    <div className={statGrid}>
        <StatCard icon={Users} label="Consultants" value={42} tone="brand" hint="…" />
    </div>
    <TableShell title="All users" minWidth={880}>…</TableShell>
</div>
```

`PageHeader` exists so "where is the New User button?" has the same answer on all twenty
screens. `EmptyState` exists so an empty list always says **why** it is empty — "no
results" is the same message for three completely different situations.

Also in `tokens.js`: `pageTitle` `pageSubtitle` `sectionTitle` `eyebrow` `prose`
`badge` `pill` `chip` `countPill` `statusDot` `avatar` · `tableHead` `tableCell`
`tableRow` `tableEmpty` · `tabBar` `tabNav` `tabItem` `tabActive` `tabIdle` ·
`segmentGroup` `segmentItem` · `navItem` `navGroupLabel` `navMarker` · `menuPanel`
`menuItem` `menuSeparator` · `stack` `statGrid` `toolbar` `pageShell` `pageGutter`.

---

## 5. The shell

`Layout` + `Sidebar` are the frame every signed-in screen renders inside.

- **Sidebar** is grouped, not flat — Platform / People / Review / Sourcing / System / My
  account. Eight flat destinations are eight things to read every time; four labelled
  areas can be skipped without reading. Items are filtered by the **same role lists used
  on the routes**, so a user never sees a link they cannot open.
- It **collapses to an icon rail** on wide screens, remembered in `localStorage`. This is
  not a gimmick: the tables in this app are wide, and 13rem of page is the difference
  between a readable Assignments grid and one that scrolls sideways. In the rail a badge
  count becomes a dot — still "something is waiting", just quieter.
- **Header** is sticky and `.glass`, so a long table scrolls *under* it and the account
  menu stays reachable from row 400. Its breadcrumb reads from a map in `Layout.jsx`, not
  from the page component, because the header renders before the lazily-loaded page
  arrives.
- **Avatars** hash the name into a fixed six-colour palette. The same person is the same
  colour on every screen and every machine — recognisable before the name is read, with no
  column in the database spent on it.

---

## 6. No hardcoded labels — use the lookups

`GET /api/lookups` returns every `lkp_` table in one call. `LookupProvider` fetches it
once per session.

### The rule

A value the **database stores** (`ORG_ADMIN`, `SUSPENDED`) is a **contract**. It belongs in
code — route guards and comparisons must not depend on a network fetch, and a label change
must never break authorisation.

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

If the fetch has not landed yet, labels fall back to a humanised form of the stored value
(`ORG_ADMIN` → `Org Admin`) rather than rendering blank.

### Colour for a looked-up value

The **label** comes from the database; the **colour and icon** are design decisions and
stay in code. `STATUS_TONE` and `ROLE_TONE` in `tokens.js` map a stored value to a tone.

Adding a new employment status is therefore: seed `lkp_user_statuses`, add one line to
`STATUS_TONE`, add one line to `STATUS_ICON` in `EmploymentStatus.jsx`. No screen changes.

---

## 7. The desktop app

`desktop/src/renderer/styles.css` is the **same design system**, hand-written. The
renderer loads nothing remote (see the CSP in `index.html`), so a build-time CSS framework
would be more machinery than the thing it dresses.

It is the same indigo-blue brand, the same neutral ramp, the same radii, the same five
semantic tones, the same two-layer shadows, and the same light/dark mechanism —
`[data-theme]` on `<html>`, re-pointing one set of variable names.

The variable names are the originals (`--paper`, `--ink`, `--raised`, `--line`, `--brand`,
`--ok` / `--warn` / `--stop`) because two screens set them inline from JavaScript.
Renaming them would be a silent break, and the names still say the right thing.

Icons are drawn in `icons.jsx` on a 24-unit grid with a 2-unit round-capped stroke. They
inherit `currentColor`, so a tab, a pill and a button each colour their own icon and none
of them needs a light and a dark copy. Eleven paths, rather than an icon package inside an
Electron bundle.

A consultant who signs in to the web portal and then opens the desktop app should not feel
they have changed products.

---

## 8. Adding something new

1. Does a token already cover it? Use it.
2. Is it a variation of an existing surface? Add a variant **in `tokens.js`**, then use it.
3. Genuinely new shared surface? Define it in `tokens.js` (or as a `ui/` component) first,
   then consume it. Never inline it "just this once" — that is how a design system dies.
4. New colour? It goes in `index.css` `@theme` **and** in the dark block, or it will be
   wrong for half the users.
5. New dialog? `<Modal>`. Never a fresh `fixed inset-0`.
6. New dropdown of reference data? A lookup table + `useLookups()`. Never a literal array
   of labels.
7. Changing the desktop app? Make the same change in `styles.css`, or the two products
   drift apart.
