# HRDeskTimeSol — Frontend Design System & Page Inventory

**Purpose of this file:** a complete, accurate description of how the admin frontend is
built today — every design token, every layout primitive, every page and its structure,
plus an honest audit of where the CSS is wrong or inconsistent. Hand this file to a
design LLM (ChatGPT / Claude / v0) together with the prompt in [§13](#13-ready-to-paste-prompt-for-chatgpt)
to get a redesign that actually drops into this codebase.

Generated from source on 2026-08-27. Everything below was read out of the repo, not
assumed.

---

## Table of contents

1. [Stack & hard constraints](#1-stack--hard-constraints)
2. [File map](#2-file-map)
3. [Design tokens (the full set)](#3-design-tokens-the-full-set)
4. [Theming model](#4-theming-model)
5. [App shell anatomy](#5-app-shell-anatomy)
6. [Layout primitives](#6-layout-primitives)
7. [Component catalogue](#7-component-catalogue)
8. [Navigation map (13 groups, 43 routes)](#8-navigation-map)
9. [Page inventory — every screen and its layout](#9-page-inventory)
10. [Responsive behaviour](#10-responsive-behaviour)
11. [CSS audit — status](#11-css-audit--status)
12. [Rules any redesign must obey](#12-rules-any-redesign-must-obey)
13. [Ready-to-paste prompt for ChatGPT](#13-ready-to-paste-prompt-for-chatgpt)

---

## 1. Stack & hard constraints

| Thing | Value |
|---|---|
| Framework | React 18.3 + TypeScript 5.7 |
| Bundler | Vite 6 |
| Router | react-router-dom 6.28 (`BrowserRouter`, `<Routes>`) |
| Styling | **Plain global CSS files imported from `.tsx`**. No Tailwind, no CSS Modules, no CSS-in-JS, no PostCSS plugins, no preprocessor. |
| Component library | **None.** Every control is hand-written. |
| Icon set | **None.** 31 hand-drawn inline SVG components in `admin/src/components/Icons.tsx` (`IconDashboard`, `IconClock`, `IconGauge`, `IconSitemap`, …). |
| Charts | **None.** Hand-written inline `<svg>` in `admin/src/components/charts.tsx`. |
| Webfont | **Deliberately none.** `--font: "Segoe UI Variable Text", system-ui, -apple-system, "Segoe UI", sans-serif` — the console must render instantly on locked-down machines. |
| Dependencies total | 3 runtime deps (`react`, `react-dom`, `react-router-dom`) |

**These are non-negotiable for any redesign.** No new npm packages, no Tailwind classes,
no `styled-components`. The output must be CSS that consumes the existing custom
properties, plus JSX that uses semantic class names.

Scale of the surface:

- **71 page components**, ~35,000 lines of TSX
- **21 CSS files**, 5,943 lines total
- **43 routes** (34 tenant + 9 platform console)
- **13 nav groups**, ~55 nav links
- 2 fully separate design surfaces: the **tenant console** and the **platform (super-admin) console**
- 1 unauthenticated surface: **signup / login**

---

## 2. File map

```
admin/src/
├── styles.css                       1988 lines  ← tokens + all shared primitives
├── styles/
│   ├── platform.css                  566   super-admin console (own dark chrome)
│   ├── org.css                       431   org chart, permissions, agent install, report picker
│   ├── attendance.css                309   calendar, punch clock, regularization
│   ├── offboarding.css               288   exit checklist, F&F settlement
│   ├── onboarding.css                267   joiner checklist, templates
│   ├── hrmshome.css                  252   employee home + approvals inbox
│   ├── signup.css                    232   signup wizard + login card
│   ├── payroll.css                   226   pay runs, structures, tax, payslips
│   ├── helpdesk.css                  201   ticket list/detail split view
│   ├── leave.css                     183   balances, request form, team queue
│   ├── assets.css                    150   asset register + my kit
│   ├── projects.css                  133   project cards + kanban board
│   ├── people.css                    103   profile, directory, documents
│   ├── expenses.css                  100   claims, review, payment queues
│   ├── letters.css                    98   letter compose + template editor
│   ├── loans.css                      90   loan cards + repayment schedule
│   ├── timesheets.css                 54   timesheet status pills
├── pages/hrms/engagement/engagement.css   124   noticeboard, surveys, kudos wall
├── pages/hrms/performance/performance.css 105   appraisal goals + scales
└── pages/hrms/workflow/workflow.css        43   approval chain levels
```

Only `styles.css` is imported globally (from `main.tsx`). Every other file is imported
from the page that needs it — **but Vite concatenates them all into one global
stylesheet, so there is no scoping.** This is the root cause of most of the bugs in
[§11](#11-css-audit--status).

---

## 3. Design tokens (the full set)

Declared on `:root` in `admin/src/styles.css`. **55 colour/geometry tokens, plus the scales and legacy aliases in §3.8–3.9.** Two palettes that must
never mix: `--brand-*` dresses chrome, `--prod`/`--seq-*`/`--series-*` dress data marks.

### 3.1 Brand (chrome only — never a data mark)

| Token | Light | Dark | Use |
|---|---|---|---|
| `--brand` | `#5b18d9` | `#6d3ff0` | primary fill, focus ring, active rail |
| `--brand-strong` | `#4a0fc0` | `#7d54f5` | primary button hover |
| `--brand-accent` | `#7c56ee` | `#a78bfa` | active nav icon, logotype first word |
| `--brand-soft` | `#f1ecfe` | `#241a44` | active nav pill, tab badge fill |
| `--brand-ink` | `#3d0fa6` | `#ddd1fe` | text on brand-soft, row links, active tab label |
| `--brand-on` | `#ffffff` | `#ffffff` | text on a solid brand fill |
| `--warn-ink` | `#92400e` | `#fcd34d` | degraded-but-working state (amber, not red) |
| `--focus` | `var(--brand)` | `var(--brand-accent)` | focus outline colour |

### 3.2 Surfaces & text

| Token | Light | Dark |
|---|---|---|
| `--page` | `#f6f6fb` | `#0c0a16` |
| `--surface-1` | `#ffffff` | `#161324` |
| `--surface-2` | `#f2f1f8` | `#1e1a30` |
| `--surface-hover` | `rgba(20,18,31,.045)` | `rgba(255,255,255,.055)` |
| `--text-primary` | `#14121f` | `#f5f3ff` |
| `--text-secondary` | `#55526b` | `#b4b0c9` |
| `--text-muted` | `#8c89a3` | `#85819b` |
| `--gridline` | `#e6e4ef` | `#272238` |
| `--baseline` | `#c7c4d6` | `#3a3550` |
| `--border` | `rgba(20,18,31,.09)` | `rgba(255,255,255,.10)` |
| `--border-strong` | `rgba(20,18,31,.14)` | `rgba(255,255,255,.17)` |
| `--track` | `#eceaf5` | `#141122` | segmented-control groove |
| `--track-thumb` | `#ffffff` | `#2b2542` | segmented-control pill |

### 3.3 Elevation (3-step ramp — each step is a tight contact shadow + a wide soft one)

| Token | Light |
|---|---|
| `--shadow-sm` | `0 1px 2px rgba(20,18,31,.06)` |
| `--shadow` | `0 1px 2px rgba(20,18,31,.05), 0 8px 24px rgba(20,18,31,.05)` |
| `--shadow-lg` | `0 2px 4px rgba(20,18,31,.06), 0 18px 40px rgba(20,18,31,.10)` |
| `--shadow-brand` | `0 1px 2px rgba(74,15,192,.20), 0 6px 18px rgba(74,15,192,.18)` |

Dark mode replaces all four with pure-black variants at 0.4–0.55 alpha.

### 3.4 Data colour (charts only — **not** a style choice)

Productivity is a **diverging** scale, not a good/bad pair. Green-vs-red fails
colour-vision separation (deutan ΔE 4.1); the blue↔red poles clear every gate
(worst pair ΔE 23.8 light / 25.7 dark).

| Token | Light | Dark | Role |
|---|---|---|---|
| `--prod` | `#2a78d6` | `#3987e5` | productive pole |
| `--prod-soft` | `#cde2fb` | `#184f95` | productive tint |
| `--unprod` | `#d03b3b` | `#d03b3b` | unproductive pole |
| `--unprod-soft` | `#f6d7d7` | `#6b2020` | unproductive tint |
| `--neutral-mark` | `#c3c2b7` | `#383835` | midpoint |
| `--seq-100/250/450/600` | `#cde2fb`→`#184f95` | reversed | sequential blue ramp |
| `--series-1..4` | `#2a78d6` `#eb6834` `#1baf7a` `#eda100` | `#3987e5` `#d95926` `#199e70` `#c98500` | categorical, fixed slot order, **never cycled** |

### 3.5 Status (state only — never a series)

| Token | Light | Dark |
|---|---|---|
| `--status-good` | `#0ca30c` | `#0ca30c` |
| `--status-critical` | `#d03b3b` | `#d03b3b` |
| `--status-warn` | `#b06f00` | `#e0a33a` |
| `--success-text` | `#006300` | `#0ca30c` |

### 3.6 Geometry & metrics

| Token | Value | Notes |
|---|---|---|
| `--radius-xl` | `20px` | rail card, drawer |
| `--radius-lg` | `16px` | topbar, login card, popover |
| `--radius` | `12px` | **the card radius** |
| `--radius-sm` | `8px` | buttons, inputs, chips |
| `--control-h` | `34px` | **one height for every control that shares a row** — input, select, button, segmented toggle |
| `--control-px` | `10px` | control horizontal padding |
| `--rail-w` | `256px` (`80px` collapsed) | sidebar track width incl. gutter |
| `--rail-gutter` | `12px` (`0` on phones) | inset that floats the rail off the window edge |
| `--caret` | inline SVG data-URI | custom `<select>` chevron (Chromium abandons the theme-aware native arrow once an author sets a background) |
| `--picker-invert` | `0` / `1` | flips UA date/time picker glyphs in dark mode |
| `--font` | `"Segoe UI Variable Text", system-ui, -apple-system, "Segoe UI", sans-serif` | |

### 3.7 Locally-set tokens (assigned inline from JS, defaulted in CSS)

| Token | Set by | Default |
|---|---|---|
| `--tile-accent` | `StatTile` `accent` prop | `var(--brand)` |
| `--avatar-bg` | `Avatar`, hashed from the name into 8 fixed hues | `var(--brand)` |
| `--meter-accent` | `Meter` `accent` prop | `var(--brand)` |

### 3.8 Scales (added in the redesign migration)

Theme-independent, so declared once on `:root` and never restated in the dark blocks.

| Group | Tokens |
|---|---|
| Spacing | `--space-1` 4px · `-2` 8 · `-3` 12 · `-4` 16 · `-5` 20 · `-6` 24 · `-7` 32 · `-8` 40 · `-9` 48 · `-10` 64 |
| Type size | `--text-xs` 11px · `-sm` 12 · `-md` 13 · `-base` 14 · `-lg` 16 · `-xl` 20 · `-2xl` 25 · `-3xl` 30 |
| Type weight | `--weight-regular` 400 · `-medium` 500 · `-semibold` 600 · `-bold` 700 |
| Radius | `--radius-xs` 6px · `-pill` 999px (joining the existing `-sm`/base/`-lg`/`-xl`) |
| Motion | `--duration-fast` 120ms · `-normal` 180ms · `-slow` 260ms · `--ease-standard` `cubic-bezier(.2,.8,.2,1)` |

Usage: icon gap `--space-1`, compact control gap `--space-2`, component gap
`--space-3`, card padding `--space-4`, section spacing `--space-5`/`-6`, page
section separation `--space-7`.

### 3.9 Legacy token map

Eight tokens the module stylesheets referenced but never declared. Each now
aliases a semantic token that already existed, which closed ~21 dark-mode
contrast failures without touching a module file.

| Alias | Points at |
|---|---|
| `--danger-text`, `--danger`, `--status-bad` | `var(--status-critical)` |
| `--status-ok`, `--ok` | `var(--status-good)` |
| `--surface` | `var(--surface-1)` |
| `--radius-md` | `var(--radius)` |
| `--warn-bg` | `color-mix(in srgb, var(--status-warn) 12%, var(--surface-2))` |
| `--nav-hover` | `var(--surface-hover)` |

Do not add a ninth. A module needing a colour uses `--status-*` directly.

---

## 4. Theming model

Three states, not two. `admin/src/lib/theme.tsx` writes `data-theme` on `<html>`:

| Mode | Attribute | Resolved by |
|---|---|---|
| `system` (default) | *none* | `@media (prefers-color-scheme: dark)` |
| `light` | `data-theme="light"` | explicitly excluded from the media block |
| `dark` | `data-theme="dark"` | its own `:root[data-theme='dark']` block |

Persisted in `localStorage` under `hrdesktimesol.theme`. The OS flip is listened for
live via `matchMedia().addEventListener('change')`.

**The dark palette is duplicated verbatim in two blocks** (the media query and the
attribute selector) — ~50 lines repeated. Any token change has to be made three times.

Body background is an ambient brand wash, `background-attachment: fixed`:

```css
background:
  radial-gradient(900px 520px at 12% -8%, color-mix(in srgb, var(--brand) 7%, transparent), transparent 70%),
  radial-gradient(760px 460px at 100% 0%, color-mix(in srgb, var(--brand-accent) 5%, transparent), transparent 72%),
  var(--page);
```

---

## 5. App shell anatomy

```
.shell (flex row, min-height 100%)
├── .scrim                       (phone only — dismiss-on-tap drawer backdrop)
├── .sidebar                     width: var(--rail-w); padding-left: var(--rail-gutter)
│   └── .sidebar-inner           position: sticky; top: 12px; height: calc(100vh - 24px)
│       │                        radius 20px, background surface-1, own scroll
│       ├── .sidebar-head        sticky, backdrop-blur(10px), surface-1 @ 72%
│       │   ├── .brand           28px mark (drop-shadow, no box) + .brand-word
│       │   └── .icon-btn        30×30 collapse toggle / drawer close
│       ├── .nav-section ×13     gap 1px; section+section margin-top 14px
│       │   ├── .nav-group-toggle    collapsible heading button + .nav-group-count + .nav-chevron
│       │   └── .nav-link            34px row, radius 10px, 13.5px/500
│       │       └── .nav-sub         padding-left 22px, 13px, ::after rail
│       └── .sidebar-foot        sticky bottom: org name, user chip, sign-out
└── .shell-body                  flex column; padding: 12px 12px 0
    ├── .topbar                  sticky top 12px, h 54px, radius 16px,
    │                            backdrop-blur(14px) saturate(1.3), surface-1 @ 76%
    │   ├── .icon-btn.topbar-menu   (phone only)
    │   ├── .crumbs                 breadcrumb, root+group hidden ≤1100px
    │   ├── .topbar-gap
    │   ├── .search-trigger         "button dressed as a field", clamp(180px, 26vw, 300px)
    │   ├── .topbar-rule            1px × 20px hairline separating groups
    │   ├── .bell-wrap              notification popover trigger
    │   └── .icon-btn               theme cycle
    └── .main                    flex 1; padding: 20px 18px 60px
        └── <page>
```

### Active nav link — four channels, deliberately

```css
.nav-link[aria-current='page'] {
  background: linear-gradient(100deg, brand-soft@92%, brand-soft@34%);
  color: var(--brand-ink);
  font-weight: 620;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--brand) 13%, transparent);
}
.nav-link[aria-current='page']::before {   /* 3px left rail with a 9px glow */
  position: absolute; left: 0; top: 8px; bottom: 8px; width: 3px;
  border-radius: 0 3px 3px 0; background: var(--brand);
  box-shadow: 0 0 9px color-mix(in srgb, var(--brand) 45%, transparent);
}
```

Hover nudges `translateX(2px)` — the affordance is the shift, not another grey fill.
The current page never nudges (it would promise a navigation that never happens).

### Collapsed rail (`.shell-collapsed`, `--rail-w: 80px`)

Hides `.brand-word`, `.nav-label`, all group headings; nav links become 36px centred
squares; the active rail `::before` is dropped for a solid `brand-soft` fill.

---

## 6. Layout primitives

Every page is built from these six things.

### 6.1 Page header (used by 54 of 71 pages)

```jsx
<div className="page-head">
  <div>
    <h1 className="page-title">Timesheets</h1>
    <p className="page-sub">Week of 12 Aug · 8 people · times in Asia/Kolkata</p>
  </div>
  <div className="head-actions">{/* ExportButton, primary CTA */}</div>
</div>
```

| Class | Spec |
|---|---|
| `.page-head` | flex, `align-items: flex-start`, `justify-content: space-between`, gap 20, wrap, `margin-bottom: 20px` |
| `.page-title` | 25px / 680 / `-0.025em` / line-height 1.15 (→ 21px ≤860px) |
| `.page-sub` | 13px, `--text-secondary`, `max-width: 76ch`, line-height 1.55 |
| `.head-actions` | flex, gap 10, wrap |

### 6.2 Filter row (23 pages)

One filter row above everything it scopes — **never inside a chart card.**

```jsx
<div className="filter-row">
  <label className="field">Range <DatePresets … /></label>
  <label className="field">Team <select>…</select></label>
  <div className="filter-spacer" />
  <span className="filter-count">14 of 92</span>
  <button className="filter-reset">Reset</button>
</div>
```

`.filter-row` = flex, gap 10, wrap, `margin-bottom: 18px`.
`.field` = flex, gap 7, 13px, `--text-secondary`.

### 6.3 Card

```css
.card {
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: var(--radius);   /* 12px */
  padding: 16px 18px;
  box-shadow: var(--shadow);
}
.card-head  { flex; space-between; gap 12px; margin-bottom: 14px; }
.card-title { 13px / 600 / +0.01em; }
.card-note  { 12px; --text-muted; }
.card-tools { flex; gap 10px; flex: none; }  /* note + view switch, right of title */
```

Used 93 times. `.card-title` is deliberately **small** (13px) — the page title carries
the hierarchy, cards are peers.

### 6.4 Grids

```css
.grid       { display: grid; gap: 14px; }
.grid-tiles { grid-template-columns: repeat(auto-fit, minmax(168px, 1fr)); }
.grid-2     { grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); }
```

### 6.5 Table

Bare-element styling — no wrapper class needed beyond `.table-wrap` for overflow.

```css
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th {
  text-align: left; font-size: 11.5px; font-weight: 600;
  color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em;
  padding: 9px 10px; border-bottom: 1px solid var(--border-strong);
  position: sticky; top: 0; z-index: 1; background: var(--surface-1);
}
td { padding: 10px; border-bottom: 1px solid var(--gridline); vertical-align: middle; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
tbody tr:hover { background: var(--surface-hover); }
tbody tr:last-child td { border-bottom: none; }
.row-link { text-decoration: none; font-weight: 600; color: var(--brand-ink); }
```

Sticky `th` is disabled ≤860px (nothing useful to stick to on a short viewport).

### 6.6 Form controls

One rule covers **every** text-ish input via a **deny-list**, not an allow-list —
so a bare `<input>` with no `type` still gets styled:

```css
input:not(:where([type='checkbox'],[type='radio'],[type='range'],[type='file'],
                [type='color'],[type='submit'],[type='button'],[type='reset'])),
select, textarea {
  height: var(--control-h);            /* 34px */
  padding: 0 var(--control-px);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  background: var(--surface-1);
}
input:hover { border-color: var(--text-muted); }
input:focus-visible { outline: 2px solid var(--focus); }
input:user-invalid { border-color: var(--status-critical); }
input[type='number'] { max-width: 14ch; }
input[type='time']   { max-width: 15ch; }
```

`<select>` gets the custom `--caret` background image. Date/time picker glyphs get
`filter: invert(var(--picker-invert))`.

---

## 7. Component catalogue

All in `admin/src/components/`. Class specs are the *current* values.

| Component | File | Renders | Key spec |
|---|---|---|---|
| **StatTile** | `ui.tsx` | `.card.tile` with a 3px gradient accent rail (`::before`), label, value, meta | label 11.5px/550/+0.02em; **value 29px/650/-0.025em**; accent set via `--tile-accent`, tints rail *and* numeral together |
| **Meter** | `ui.tsx` | `.meter` + `.meter-fill` | 6px tall, radius 99px, track `--gridline`, fill `--meter-accent`, `role="progressbar"`, 260ms width transition. **Always paired with the literal figure.** |
| **Avatar** | `ui.tsx` | `.avatar` initials disc | 30px (24px `.avatar-sm`), 11.5px/650, white text, `inset 0 0 0 1px rgba(255,255,255,.18)`. 8 fixed hues hashed from the name — identity, never status. |
| **Identity** | `ui.tsx` | `.identity` = Avatar + `.identity-name` + `.identity-meta` | name 600 truncated; meta 11.5px muted truncated |
| **OnlineBadge / ProductivityBadge** | `ui.tsx` | `.badge` + `.badge-dot` | 11.5px/550, 3px 9px, radius 999px, tonal fill (`color-mix` 12%) + 28% border. Dot stays because tint alone is one channel. |
| **EmptyState** | `ui.tsx` | `.empty-state` icon/title/body/action | centred, `.empty-title` 14.5px/620, `.empty-body` 13px `max-width: 46ch`. Body must say *what would make something appear*, not restate emptiness. |
| **Loading** | `ui.tsx` | `.loading` + `.spinner` | `role="status"`; sibling `.refetching { opacity: .55 }` for background refresh |
| **Topbar** | `Topbar.tsx` | breadcrumb + search trigger + bell + theme cycle | see §5 |
| **Tabs** | `Tabs.tsx` | `.tabs` recessed track + travelling `.tab-thumb` pill + `.tab-badge` counts | track `--track` radius 13px pad 4px; thumb `--track-thumb` radius 9px, `transform` 260ms cubic-bezier(.4,0,.2,1); tab 13.5px/500 → active `--brand-ink`/650 |
| **ChartCard** | `ChartCard.tsx` | `.card` + `.card-head` + `.legend` + chart/table switch (`.ts-toggle-xs`) | every chart ships a legend *and* a table view — hue is never the only channel |
| **charts.tsx** | | `.hbar-*`, `.timeline*`, `.chart-svg`, `.gridline`, `.baseline`, `.axis-label` | hbar track 8px radius 4; timeline 30px radius 8 |
| **CommandPalette** | `CommandPalette.tsx` | `.palette-layer` → `.palette-scrim` + `.palette` | radius `--radius-lg`, scope chips, grouped hits, `.kbd` footer |
| **Notifications** | `Notifications.tsx` | `.popover` with `pop-in` keyframe, `.note` rows | `.note-warn` / `.note-critical` / `.note-info` glyph tints |
| **Tooltip** | `Tooltip.tsx` | `.tooltip` fixed, `pointer-events: none`, z 60 | title 600 + `.tooltip-row` key/value with tabular-nums |
| **ExportButton** | `ExportButton.tsx` | `.export-wrap` + `.btn` + `.export-error` | |
| **DatePresets** | `DatePresets.tsx` | `.field` + `.ts-toggle` segmented control | shares `--control-h` so it lines up with date fields |
| **Icons** | `Icons.tsx` | 31 inline SVGs, `size` prop | stroke-based, `currentColor` |

### Buttons

```css
.btn        { height: var(--control-h); padding: 0 14px; 13px/550;
              background: var(--surface-1); border: 1px solid var(--border-strong);
              border-radius: var(--radius-sm); box-shadow: var(--shadow-sm); }
.btn:active { transform: translateY(1px); box-shadow: none; }
.btn-primary{ background: linear-gradient(180deg, brand@86%+white, var(--brand));
              border-color: transparent; color: var(--brand-on);
              box-shadow: var(--shadow-brand); }
.btn-sm     { height: 28px; padding: 0 10px; font-size: 12px; }   /* in-table actions */
.btn-ghost  { background: var(--surface-2); border-color: var(--border);
              box-shadow: none; color: var(--text-secondary); }   /* repeated row actions */
.btn-group  { display: inline-flex; gap: 6px; }
.icon-btn   { 30×30, transparent, radius --radius-sm, colour --text-muted }
```

`.btn-primary` lifts its top edge with a white-mixed gradient rather than interpolating
two brand tokens — `--brand-strong` is *darker* in light mode and *lighter* in dark, so
a literal two-stop ramp would flip direction between themes.

### Settings rows

```css
.set-rows   { flex column }
.set-row    { grid: 1fr auto; label left, control right; border-bottom hairline }
.set-hero   { border-left: 3px solid; --brand + --brand-soft when on }
.savebar    { sticky bottom, slides up when dirty }
.toggle     { 34×19 switch, --brand when checked, 17px thumb travel }
.settings-grid { repeat(auto-fit, minmax(260px, 1fr)); gap 16px 24px }
```

A settings page is read down its **left edge** — the labels are the column that must
line up, not the inputs.

---

## 8. Navigation map

13 groups in `admin/src/lib/nav.tsx`. The first is unheaded and never collapsible
(those are the three most-clicked links). Every other group collapses; the group holding
the current page opens itself. Open groups persist per-browser in `localStorage`.

| # | Group | Items |
|---|---|---|
| 0 | *(unheaded)* | Dashboard `/` · Home `/home` · Approvals `/approvals` · My performance `/me` |
| 1 | **Time & Work** | Timesheets · Time & Activity · Apps & Websites · Screenshots · Projects · Reports |
| 2 | **People** | My profile · Directory · Employees · My letters · Letters · Letter templates · Teams & Departments · Hierarchy |
| 3 | **Attendance** | My attendance · Team attendance · Attendance settings |
| 4 | **Leave** | My leave · Team leave · Leave settings |
| 5 | **Expenses & Loans** | My expenses · Approvals · Payments · Expense settings · My loans · Loans & advances · Loan deductions |
| 6 | **Payroll** | My salary · My payslips · Tax declaration · My Form 16 · Pay runs · Salary structures · Pay components · Statutory settings · Tax declarations · Year end & Form 16 |
| 7 | **Workplace** | My assets · Assets · Helpdesk · Ticket queue |
| 8 | **Joiners & Leavers** | My onboarding · Onboarding · Offboarding |
| 9 | **Noticeboard** | Noticeboard · Communication |
| 10 | **Performance** | My review · Appraisals |
| 11 | **Setup** | Approval workflow |
| 12 | **Account** | Notifications · Email setup · Subscription & Billing · Settings |

Visibility flags per item: `adminOnly`, `teamOnly`, `ownerOnly`, `approverOnly`, plus a
per-employee `page` deny-list. An admin sees ~55 links; an employee sees ~20.

`nav.tsx` is read by **three** surfaces — the rail, the breadcrumb, and the command
palette's Pages section — via `visibleItems()` and `locate()`.

---

## 9. Page inventory

Format: **Route** — file · layout pattern · what it shows.
`◆` = uses the broken class dialect (see [§11](#11-css-audit--status)).

### 9.1 Time-tracking console (the original product)

| Route | File | Layout |
|---|---|---|
| `/` | `Dashboard.tsx` (290) | page-head + filter-row(DatePresets) → `.grid-tiles` of 4 StatTiles → `.grid-2` of ChartCards (bar + hbar) → table of people |
| `/me` | `MyPerformance.tsx` (236) | StatTiles + Meter + ChartCard + `.delta` up/down deltas + `.kv` list |
| `/employees` | `Employees.tsx` (506) | filter-row w/ `.filter-count`+`.filter-reset` → table of `Identity` rows + `.badge-ok`/`.badge-warn` → `EmployeeEdit` dialog (`.hx-backdrop`/`.hx-dialog`, `.perm-grid`, `.page-chips`) |
| `/employees/:id` | `EmployeeDay.tsx` (427) | StatTiles + `.timeline` day strip + ChartCards + `.device-warning` amber notice |
| `/organisation` | `OrgStructure.tsx` (602) | Tabs → tables + `.settings-grid` + `.day-picker` chips |
| `/hierarchy` | `Hierarchy.tsx` (422) | `.tree` recursive org chart: `.tree-row`/`.tree-avatar`/`.tree-toggle`/`.tree-tags` + `.hx-dialog` manager picker |
| `/projects` | `Projects.tsx` (429) | `.pj-grid` of `.pj-card` w/ `.pj-budget` meter + `.pj-swatch` colour dot |
| `/projects/:id` | `ProjectDetail.tsx` (592) | StatTiles → Tabs → `.pj-board` kanban (`.pj-column` / `.pj-task`) |
| `/timesheets` | `Timesheets.tsx` (652) | StatTiles + `.ts-nav` week stepper + table w/ `.ts-pill` status + `.ts-entry-form` |
| `/activity` | `TimeActivity.tsx` (294) | StatTiles + ChartCards + table |
| `/apps` | `AppsWebsites.tsx` (270) | table + `.pager` + `ProductivityBadge` |
| `/screenshots` | `Screenshots.tsx` (262) | filter-row → `.shot-grid` (auto-fill minmax 230px) of `.shot-card` (16:9 img) → `.lightbox` overlay |
| `/reports` | `Reports.tsx` (263) | `.rp-layout` = `.rp-picker` list + `.rp-totals` panel |
| `/billing` | `Billing.tsx` (187) | StatTile + Meter seats + `.check-list` plan features + `.kv` |
| `/settings` | `Settings.tsx` (700) | Tabs → `.set-rows` / `.set-hero` / `.toggle` / `.preset-row` → sticky `.savebar` |
| `/notifications` | `NotificationSettings.tsx` (188) | `.notif-row` checkbox list |
| `/email` | `EmailSetup.tsx` (250) | `.settings-grid` + `.switch-row` + `.test-result` |

### 9.2 HRMS — home & approvals

| Route | File | Layout |
|---|---|---|
| `/home` | `EmployeeHome.tsx` (968) | `.hm-greeting` → `.hm-grid` of `.hm-card`s: punch clock (`.hm-clock`/`.hm-punch`), week meter (`.hm-week-*`), 7-bar `.hm-spark`, `.hm-list` rows, holiday card |
| `/approvals` | `ApprovalsInbox.tsx` (972) | StatTiles → `.ai-filters` `.ai-chip`s → `.ai-row` cards colour-coded by type (`.ai-row-leave`, `.ai-row-expense`, `.ai-row-loan`, …) with `.ai-age` freshness + `.ai-actions` |

### 9.3 HRMS — Core HR & People

| Route | File | Layout |
|---|---|---|
| `/profile`, `/people/:id` | `MyProfile.tsx` (639) ◆ | `.hr-profile-grid` sections of `.hr-field-grid` label/value pairs + `.hr-confirm` + `.hr-upload` |
| `/directory` | `Directory.tsx` (103) ◆ | `.hr-search` + plain table |
| — (embedded) | `EmployeeDocuments.tsx` (229) ◆ | `.hr-section-wide` + upload table |
| `/my-letters`, `/letters` | `Letters.tsx` (521) ◆ | table + `.lt-detail` preview pane + `.lt-compose` form + `.lt-pill` status |
| `/letters/templates` | `LetterTemplates.tsx` (334) ◆ | `.lt-editor-grid` = `.lt-fields` sidebar + `.lt-editor-main` body editor + `.lt-token` chips |

### 9.4 HRMS — Attendance & Leave

| Route | File | Layout |
|---|---|---|
| `/attendance` | `MyAttendance.tsx` (1087) | `.att-clock` punch card → `.att-cal-grid` month calendar (`.att-cell` states: present/absent/holiday/on_leave/half_day/weekly_off) + `.att-legend` → `.att-detail` day panel with `.att-pairs` in/out + `.att-flags` |
| `/attendance/team` | `TeamAttendance.tsx` (491) | StatTiles + `Identity` table + `.att-cal-nav` |
| `/attendance/settings` | `AttendanceSettings.tsx` (1213) | `.settings-grid` + `.att-choices` cards + `.att-offices` geofence table |
| — | `regularization.tsx` (1221) | `.att-reg-cards` request cards + `.att-reg-form` + `.att-reg-preview` |
| `/leave` | `MyLeave.tsx` (1129) | `.lv-balances` of `.lv-bal` cards (figure + Meter) → `.lv-form` request → `.lv-cost` breakdown → `.lv-ledger` history |
| `/leave/team` | `TeamLeave.tsx` (433) | `.lv-queue` of `.lv-item` cards + `.lv-clash` conflict warning + `.lv-decide` |
| `/leave/settings` | `LeaveSettings.tsx` (1091) | Tabs → `.lv-tab-body` forms + `.lv-year-preview` |

### 9.5 HRMS — Money (Expenses, Loans, Payroll)

| Route | File | Layout |
|---|---|---|
| `/expenses` | `MyExpenses.tsx` (486) ◆ | `.ex-tiles` → `.ex-list` of `.ex-card` (head/amount/body) → `.ex-newclaim` with `.ex-lines` line items |
| `/expenses/review`, `/payments` | `ExpenseQueues.tsx` (207) ◆ | `.ex-decide` cards + `.ex-headline` |
| `/expenses/settings` | `ExpenseSettings.tsx` (185) ◆ | `.ex-row` table |
| `/loans`, `/loans/manage`, `/loans/deductions` | `Loans.tsx` (614) ◆ | `.ln-tiles` → `.ln-list` of `.ln-card` → `.ln-schedule` repayment table + `.ln-pill` (uppercase, `currentColor` border) |
| `/salary` | `MySalary.tsx` (125) ◆ | `.pr-tiles` + `.pr-components` breakdown table + `.pr-total-row` |
| `/payslips` | `PayRuns.tsx` (720) ◆ | `.pr-runs` of `.pr-run` cards → `.pr-payslip` `.pr-payslip-cols` earnings/deductions |
| `/tax` | `TaxDeclaration.tsx` (488) ◆ | `.pr-regimes` old/new comparison + `.pr-slab` table + `.pr-addclaim` |
| `/form16`, `/payroll/year-end` | `YearEnd.tsx` (308) ◆ | `.pr-certs` list |
| `/payroll` | `SalaryStructures.tsx` (512) ◆ | `.pr-picker` + `.pr-form` + `.pr-preview` |
| `/payroll/components` | `PayComponents.tsx` (301) ◆ | `.pr-form` + `.pr-checks` |
| `/payroll/statutory` | `StatutorySettings.tsx` (680) ◆ | `.pr-form` grouped fields |
| `/payroll/tax` | `TaxVerification.tsx` (219) ◆ | `.ln-card` reused for claim cards |

### 9.6 HRMS — Workplace, Joiners/Leavers

| Route | File | Layout |
|---|---|---|
| `/assets` | `Assets.tsx` (980) | StatTiles + filter-row → table + `.as-panel` detail with `.as-ledger` assignment history + `.as-pill` state |
| `/my-assets` | `MyAssets.tsx` (101) | `.as-my-grid` of `.as-my-card` |
| `/helpdesk` | `Helpdesk.tsx` (680) | `.hd-split` = list + `.hd-detail`; `.hd-thread` comments, `.hd-facts` sidebar, `.hd-prio-*` priority, `.hd-composer` |
| `/helpdesk/queue` | `HelpdeskQueue.tsx` (800) | same split + StatTiles + `.hd-counts` + `.hd-internal-tag` |
| `/onboarding` | `Onboarding.tsx` (2284) | StatTiles → `.ob-groups` of `.ob-group` task groups → `.ob-task` rows w/ `.ob-tick` state + `.ob-progress` Meter + `.ob-tpl-list` templates |
| `/my-onboarding` | `MyOnboarding.tsx` (270) | `.ob-my-top` progress + `.ob-docs` upload list |
| `/offboarding` | `Offboarding.tsx` (2616) | StatTiles → `.ex-groups` exit tasks → `.ex-blockers` → `.ex-fnf-figures` full-&-final settlement + `.ex-assets` recovery |

### 9.7 HRMS — Engagement, Performance, Workflow

| Route | File | Layout |
|---|---|---|
| `/noticeboard` | `Engagement.tsx` (431) ◆ | `.eg-post` announcement cards (`.eg-pin`) + `.eg-survey` question cards (`.eg-scale` 1–5 `.eg-point`) + `.eg-wall` kudos |
| `/communication` | `EngagementAdmin.tsx` (559) ◆ | `.eg-tabs` → compose forms + `.eg-dist` result bars (`.eg-bar-fill`) + `.eg-withheld` |
| `/reviews` | `MyReview.tsx` (354) ◆ | `.pf-goals` of `.pf-goal` + `.pf-scale` rating + `.pf-outcome` |
| `/appraisals` | `Appraisals.tsx` (616) ◆ | `.pf-cycle-tabs` → `.pf-competencies` + `.pf-self-view` / `.pf-manager` side-by-side |
| `/workflow` | `WorkflowSetup.tsx` (379) ◆ | `.wf-tabs` scope → `.wf-levels` of `.wf-level` (`.wf-level-no` numbered chain) |

### 9.8 Unauthenticated

| Route | File | Layout |
|---|---|---|
| `/login` | `Login.tsx` (108) | `.login-wrap` grid centre → `.login-card` (max 400px, radius `--radius-lg`, `--shadow-lg`) |
| `/signup` | `Signup.tsx` (596) | `.signup-wrap` (radial brand wash) → `.signup-card` (max 720px) → `.stepper` → `.plan-grid` of `.plan-card` → `.quote-box` → `.review` |

### 9.9 Platform console (`/platform/*`) — separate design surface

Own shell in `PlatformApp.tsx`, own stylesheet `platform.css`. **Deliberately darker and
cooler than the tenant console** — an operator has both open in adjacent tabs and the one
destructive action (suspend) stops a paying customer's data collection, so "which system
am I in" must be answerable at a glance. `.pf-sidebar-inner` is hardcoded `#14121f` in
**both** themes for exactly this reason.

| Route | File |
|---|---|
| `/platform` | `PlatformOverview.tsx` (182) — `.pf-tiles` + `.pf-mailrow` |
| `/platform/companies` | `PlatformCompanies.tsx` (232) — `.pf-table` + `.pf-seats` meter |
| `/platform/companies/:id` | `PlatformCompany.tsx` (454) — `.pf-grid-2` + `.pf-activity` log |
| `/platform/companies/new` | `NewCompany.tsx` (278) — `.pf-form-grid` |
| — | `CompanyEdit.tsx` · `CompanyModules.tsx` · `CompanyDelete.tsx` (dialogs) |
| `/platform/plans` | `PlatformPlans.tsx` (208) — `.pf-plangrid` |
| — | `PlanEditor.tsx` (398) |
| `/platform/mail` | `PlatformMail.tsx` (253) |
| `/platform/audit` | `PlatformAudit.tsx` (115) |

---

## 10. Responsive behaviour

| Breakpoint | Count | What changes |
|---|---|---|
| `1100px` | 2 | breadcrumb drops root + group, keeps the leaf |
| `900px` | 1 | org tree narrows |
| `860px` | 5 | **the big one** — see below |
| `720px` | 2 | savebar stacks |
| `640px` | 14 | module grids collapse to 1 column |
| `560px` | 1 | signup stepper wraps |
| `prefers-reduced-motion` | 5 | tab thumb, rp-item, savebar transitions off |

### The 860px transformation

- `.shell` → `flex-direction: column`, `--rail-gutter: 0`
- `.sidebar` → `position: fixed`, 288px, `translateX(-100%)`, slides in on `.shell-drawer-open` (240ms cubic-bezier(.4,0,.2,1))
- `.sidebar-inner` → `height: 100dvh` (**not** `vh` — mobile chrome shrinks the viewport and a `100vh` drawer hides its own sign-out button behind the address bar), only the trailing corners stay round
- `.scrim` → visible, `rgba(0,0,0,.45)`, fades 200ms
- `.topbar` → full-bleed, square, 52px, one bottom hairline; gains `.topbar-menu` + `.topbar-brand` + `.search-icon-btn`; loses `.crumbs` + `.search-trigger` + `.topbar-rule`
- `.shell-collapsed` overrides are **all undone** (a drawer is already off-canvas; collapsing would remove labels for nothing)
- `.main` padding → `18px 16px 48px`; `.page-title` → 21px; `th` → `position: static`

---

## 11. CSS audit — status

Phase 1–3 of `HRDeskTimeSol_Modern_Frontend_Redesign_Spec.md` has been applied.
This section records what was fixed and what is still open.

### Fixed

| # | Problem | Fix |
|---|---|---|
| 11.1 | **23 pages used class names that didn't exist** — `btn primary`, `btn small`, `btn danger`, `row-actions`, `muted`, `page`, `table`. Primary CTAs rendered as grey secondary buttons; action cells stacked vertically. | Compatibility aliases added to `styles.css` (`.btn.primary`, `.btn.small`, `.btn.danger`, `.btn.is-disabled`) plus real definitions for `.row-actions`, `.muted`, `.muted-sm`, `.page`, `.table`. No JSX rewritten — the spec explicitly rules out a blind search-and-replace. |
| 11.2 | **`.pf-*` collision** — `platform.css` vs `performance.css`. Performance loaded second and was overriding the platform console's `.pf-field` (forcing `flex:1; min-width:180px` on every operator form field), `.pf-pill` (11px radius + `currentColor` outline instead of a pill), `.pf-check` (block instead of inline-flex) and `.pf-actions`. | Performance renamed to `.perf-*` — 49 CSS + 56 TSX replacements across `performance.css`, `Appraisals.tsx`, `MyReview.tsx`. Platform keeps `.pf-*`. |
| 11.2 | **`.ex-*` collision** — `expenses.css` vs `offboarding.css` on `.ex-actions` and `.ex-pill`. | Offboarding renamed to `.offboard-*` — 96 CSS + 166 TSX replacements. Expenses keeps `.ex-*`. |
| 11.2 | **`.plan-features` collision** — a `<textarea>` in `org.css` (plan editor) and a `<ul>` in `signup.css` (marketing page). `org.css` resolved later, so the public signup feature list was inheriting `resize: vertical` and a 96px min-height. | `org.css` renamed to `.plan-features-input`; `PlanEditor.tsx` updated. |
| 11.2 | **`.link-btn` defined three times** (`styles.css`, `people.css`, `signup.css`) with different sizes and underlines. `styles.css` resolves last so the module copies were already dead code. | Both module copies removed. |
| 11.2 | `.muted-sm` lived in `org.css`, but 8 of its 20 callers never import that file. | Moved to `styles.css` with its `margin-top: 2px` intact. |
| 11.2 | `.btn.is-disabled` defined in `expenses.css` — a module file dressing a shared primitive. | Moved to `styles.css`. |
| 11.3 | **8 tokens referenced but never declared**, each falling through to a hardcoded light-mode hex (`#b3261e`, `#2e7d32`) that failed contrast on `--surface-1` in dark mode. | `--danger-text`, `--danger`, `--status-bad`, `--status-ok`, `--ok`, `--surface`, `--radius-md`, `--warn-bg` and `--nav-hover` now declared on `:root`, aliased to the semantic tokens that already existed. All 32 dead hex fallbacks stripped. **Zero `#b3261e` / `#2e7d32` left in the bundle.** |
| 11.5 | Seven visually different status-pill treatments. | Canonical `.badge-success` / `.badge-warning` / `.badge-danger` / `.badge-info` / `.badge-neutral` added — one tonal recipe (12% fill, 28% border, semantic text colour) on five tokens. `.badge-ok` / `.badge-warn` kept as aliases. |
| 11.6 | No spacing, type, radius or motion scale — 24 font sizes, 17 gap values, all literals. | `--space-1..10`, `--text-xs..3xl`, `--weight-*`, `--radius-xs` / `--radius-pill`, `--duration-fast/normal/slow` and `--ease-standard` added to `:root`. Theme-independent, so declared once. |
| — | No canonical destructive button. | `.btn-danger` added: outlined at rest (a solid red block in a row of grey ones reads as an alarm, not a choice), filling on hover. |
| — | Six classes used in JSX with no rule: `hr-section`, `lt-editor`, `pf-error`, `pf-table-wrap`, `pf-module-text`, `set-hero-text`, plus a vestigial `notes` modifier. | Defined in their owning stylesheets; `notes` removed from `Notifications.tsx` since `.popover` already sizes it. |

**Verification:** production build clean; zero undefined classes; zero undefined
custom properties; each of `.pf-pill`, `.pf-field`, `.pf-check`, `.pf-actions`,
`.ex-pill`, `.ex-actions` now has exactly one definition. The bundle emits
`styles.css` after every module file (byte 104,006 vs a last-module rule at
96,961), so the aliases win every same-specificity tie.

### Still open

| # | Problem | Notes |
|---|---|---|
| 11.4 | **10 chart tokens defined, never used** — `--series-1..4`, `--seq-100/250/450/600`, `--prod-soft`, `--unprod-soft`. The diverging-palette system documented at the top of `styles.css` was never wired into `charts.tsx`. | Needs chart work, not CSS work. |
| 11.5 | Twelve module pills (`.as-pill`, `.lv-pill`, `.ln-pill`, `.ts-pill`, `.pj-pill`, `.ex-pill`, `.hd-pill`, `.lt-pill`, `.ob-pill`, `.pf-pill`, `.pr-pill`, `.eg-pill`) still exist. Four re-implementations of StatTile (`.ex-tile`, `.ln-tile`, `.pr-tile`, `.pf-tile`) too. | Spec Phase 4 — migrate markup to `.badge badge-*` / `StatTile`, then delete. Each is a per-module JSX change. |
| 11.6 | The existing literals (11.5px, 12.5px, 620/640/660 weights, 7/11/13px gaps) have not been migrated onto the new scales. | Spec says migrate per module as each is touched, not in one pass. |
| 11.7 | The dark palette is still triplicated — ~50 lines repeated in `@media (prefers-color-scheme: dark)` and `:root[data-theme='dark']`. | Unavoidable without a build step; the alternative is `light-dark()`, which needs a browser-support decision. |
| 11.8 | `styles.css` is now ~2,150 lines holding nine concerns. | Spec Phase 2 suggests splitting shared primitives into their own files. |
| 11.8 | `EmployeeDay.tsx`, `Screenshots.tsx`, `Settings.tsx`, `regularization.tsx` and 9 platform pages use module classes without importing the stylesheet, relying on another page having loaded it. | Harmless today (single CSS bundle); would break under code-splitting. |
| — | Section 10 of the spec — modernising the eight page archetypes — has not been started. | This is the large remaining piece. |

---

## 12. Rules any redesign must obey

Hard constraints — a redesign that breaks these cannot be merged:

1. **No new dependencies.** Plain CSS + inline SVG only. No Tailwind, no CSS-in-JS, no icon package, no chart library, no webfont.
2. **Consume the existing custom properties.** Redefine token *values* freely; do not rename tokens or replace them with literals.
3. **All three theme modes must work**: system (no attribute), `[data-theme="light"]`, `[data-theme="dark"]`. Never give a colour its only definition inside a media query.
4. **Brand and data palettes stay separate.** Chrome never borrows `--prod`; charts never borrow `--brand`. A stat tile showing a data-coloured number passes the matching data token so rail and numeral agree.
5. **Colour is never the only channel.** Every status carries a dot, a glyph, or a weight change as well as a hue. Every chart ships a legend and a table view.
6. **One control height per row.** `--control-h: 34px` governs inputs, selects, buttons and the segmented toggle so a filter row is never ragged.
7. **Accessibility gates**: body text ≥ 4.5:1, focus visible on every interactive element (`outline: 2px solid var(--focus)`), `prefers-reduced-motion` honoured, sticky `th` disabled on short viewports.
8. **The platform console stays visually distinct** from the tenant console in both themes — that is a safety feature, not an inconsistency to iron out.
9. **The rail must fit a laptop viewport without scrolling** at 13 groups collapsed. That is what drives the 34px nav row height.
10. **`nav.tsx` is the single source of truth** for the rail, the breadcrumb and the command palette. Any nav restructure edits that one file.

---

## 13. Ready-to-paste prompt for ChatGPT

> Copy everything below the line, and attach or paste §3, §6, §7 and §11 of this document.

---

I'm redesigning the frontend of an HRMS + time-tracking SaaS console. It is React 18 +
Vite + TypeScript with **plain global CSS files** — no Tailwind, no CSS Modules, no
CSS-in-JS, no component library, no icon package, no webfont, no chart library. The only
runtime dependencies are `react`, `react-dom` and `react-router-dom`. Any solution that
adds a dependency is unusable.

**The product:** 71 pages across 13 navigation groups — a time-tracking console
(dashboard, timesheets, activity, screenshots, projects, reports) plus a 19-module HRMS
(attendance, leave, payroll, expenses, loans, assets, helpdesk, onboarding, offboarding,
letters, performance, engagement, approval workflow) plus a separate super-admin platform
console and a signup wizard. Users are HR admins, managers and employees; the same page
often renders three different scopes depending on role.

**Current state:** there is a genuinely considered token system (55 CSS custom
properties, three-state theming, a diverging data palette chosen for colour-vision
separation) applied to a shell, navigation rail, topbar and a core set of primitives.
But the 23 newest HRMS pages were written against class names that don't exist, twelve
modules each reinvented the status pill and the stat tile, there is no spacing or type
scale (24 font sizes, 17 gap values), eight colour tokens are referenced but never
defined and fall back to hardcoded hex that fails contrast in dark mode, and two "scoped"
stylesheets collide on the same `.pf-*` prefix.

**What I need from you:**

1. **A consolidated design language** — a single spacing scale, a single type scale
   (size + weight + letter-spacing + line-height per role), a single radius scale, and a
   single elevation ramp, expressed as new CSS custom properties that sit alongside the
   existing colour tokens. Map every current value onto the nearest step and tell me what
   moves.
2. **One canonical spec per primitive**, replacing the duplicates: status pill/badge,
   stat tile, card, table row, form field, button (primary / secondary / ghost / small /
   icon / danger), empty state, tabs, segmented control, dialog, side panel, progress
   meter, toast/notice, avatar, kanban card, calendar cell, checklist row, split-view
   list+detail.
3. **A `danger` and a `success` treatment** built from the existing `--status-critical`
   and `--status-good` tokens, working in both themes.
4. **Layout templates** for the eight page archetypes this product actually uses:
   (a) dashboard with stat tiles + charts, (b) filterable data table, (c) list + detail
   split view, (d) settings page with label-left/control-right rows and a sticky save
   bar, (e) multi-step form/wizard, (f) card grid, (g) checklist/task groups with
   progress, (h) self-service "my X" page with a hero action.
5. **Complete CSS**, written to consume the existing custom properties, plus the JSX
   class names each template expects.
6. **A migration note** for each of the 23 broken pages: which existing class name maps
   to which new one.

**Non-negotiable constraints:**

- Plain CSS only, consuming existing custom properties. No renaming tokens.
- Three theme modes must work: system (no attribute on `<html>`),
  `[data-theme="light"]`, `[data-theme="dark"]`. Never define a colour only inside a
  media query.
- Brand colour (`--brand*`) is for chrome only; the data palette (`--prod`, `--unprod`,
  `--seq-*`, `--series-*`) is for chart marks only. They must not mix.
- Colour is never the only channel for meaning — pair every status hue with a dot, glyph
  or weight change.
- One control height (`--control-h: 34px`) for everything that shares a filter row.
- Body text ≥ 4.5:1, visible focus rings, `prefers-reduced-motion` honoured.
- Responsive: the sidebar becomes an off-canvas drawer at 860px; module grids collapse
  to one column at 640px.
- The super-admin console must stay visually distinct from the tenant console in both
  themes — that is a safety cue, not an inconsistency.

**Design direction:** keep the current character — a floating "island" rail and topbar on
a soft brand-tinted page wash, 12px card radius, restrained violet chrome, dense but
breathable data tables, numbers as the hero on stat tiles. Make it more consistent and
more confident, not more decorative. This is a tool people use for eight hours a day.

Start with the token scales and the primitive specs; I'll ask for the page templates
next.

---

*End of document.*
