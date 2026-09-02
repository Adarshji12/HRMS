# HRDeskTimeSol — Modern Frontend Redesign Specification

## Purpose

This document defines a **frontend-only modernization plan** for the HRDeskTimeSol HRMS and time-tracking application.

The goal is to make all pages visually consistent, modern, professional, responsive, and maintainable **without changing backend code, APIs, routes, authentication, database logic, request payloads, response handling, business rules, or application behaviour**.

This specification is based on the current frontend architecture and CSS audit in the project documentation.

---

# 1. Project Safety Rules

## 1.1 Strict frontend-only scope

The redesign may change:

- CSS files
- CSS custom properties
- JSX/TSX class names
- JSX wrapper elements used only for layout
- semantic HTML where it improves accessibility without changing behaviour
- component presentation
- responsive layout rules
- visual states and animations

The redesign must **not** change:

- Backend APIs
- API URLs
- HTTP methods
- Request bodies
- Response parsing
- TypeScript business logic
- Authentication
- Authorization rules
- Role visibility logic
- Database models
- Route paths
- Route parameters
- Navigation data behaviour
- State management behaviour
- Existing event handlers
- Form field names required by backend integration

## 1.2 Dependency rules

Keep the current architecture:

- React 18
- TypeScript
- Vite
- react-router-dom
- Plain global CSS

Do not introduce:

- Tailwind CSS
- CSS Modules
- styled-components
- Emotion
- UI component libraries
- icon packages
- chart packages
- webfont dependencies
- additional npm packages

---

# 2. Current Architecture

The application contains:

- 71 page components
- 43 routes
- 13 navigation groups
- Tenant HRMS/time-tracking console
- Separate platform/super-admin console
- Login and signup surfaces
- Global CSS plus module CSS files

The application already has a strong foundation:

- Existing CSS custom properties
- Light, dark, and system theme support
- Floating sidebar design
- Floating topbar
- Shared cards, tables, buttons, tabs, badges and controls
- Existing inline SVG icon system
- Existing responsive sidebar drawer behaviour

The modernization should preserve these strengths while fixing inconsistency and CSS conflicts.

---

# 3. Primary Design Direction

## Design personality

The interface should feel:

- Professional
- Modern
- Enterprise-ready
- Calm
- Precise
- Dense but breathable
- Suitable for daily 8-hour business use
- Premium without becoming decorative

## Visual principles

### 1. Consistency over novelty

Every page should look like part of the same product.

### 2. Hierarchy before decoration

Use typography, spacing, grouping and surface elevation to communicate hierarchy.

### 3. Fewer visual patterns

Do not create a unique button, badge, card or table style for every HRMS module.

### 4. Data remains easy to scan

HRMS users frequently work with:

- employee lists
- approvals
- payroll values
- dates
- attendance
- leave balances
- status information

Layouts must support fast scanning.

### 5. Restrained brand usage

Violet remains the primary chrome colour.

Do not use brand colour everywhere. Brand colour should indicate:

- primary actions
- active navigation
- focus
- selected controls
- important product identity

### 6. Modern surfaces

Use subtle borders and restrained shadows.

Avoid:

- excessive gradients
- heavy shadows
- thick borders
- overly rounded controls
- colourful cards for every category

---

# 4. Non-Negotiable CSS Architecture

## 4.1 Global primitives only

Shared primitives belong in the main global stylesheet:

```text
styles.css
```

Examples:

- tokens
- reset
- typography
- buttons
- forms
- cards
- tables
- badges
- dialogs
- empty states
- utility classes
- layout primitives

Module CSS files must only contain module-specific layouts.

## 4.2 Unique module namespaces

Every module stylesheet must use a unique prefix.

Recommended prefixes:

| Module | Prefix |
|---|---|
| Platform | `.platform-*` |
| Performance | `.perf-*` |
| Expenses | `.expense-*` |
| Offboarding | `.offboard-*` |
| Onboarding | `.onboard-*` |
| Attendance | `.attendance-*` |
| Leave | `.leave-*` |
| Payroll | `.payroll-*` |
| Helpdesk | `.helpdesk-*` |
| Assets | `.asset-*` |
| Projects | `.project-*` |
| People | `.people-*` |
| Letters | `.letter-*` |
| Engagement | `.engagement-*` |
| Workflow | `.workflow-*` |

Avoid short generic module prefixes such as:

```text
.pf-*
.ex-*
.pr-*
```

when they can collide with another module.

## 4.3 Shared classes must never be redefined in module files

These are global primitives:

```text
.btn
.card
.badge
.meter
.empty-state
.loading
.card-title
.settings-grid
.table-wrap
```

Module files may compose them but must not redefine their global visual identity.

---

# 5. Modern Design Token Expansion

Keep all existing colour tokens unchanged.

Add a structured spacing, typography, radius, elevation and motion scale.

## 5.1 Spacing scale

```css
:root {
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
  --space-7: 32px;
  --space-8: 40px;
  --space-9: 48px;
  --space-10: 64px;
}
```

### Usage

| Situation | Token |
|---|---|
| Icon gap | `--space-1` |
| Compact control gap | `--space-2` |
| Normal component gap | `--space-3` |
| Card padding | `--space-4` |
| Section spacing | `--space-5` |
| Large section spacing | `--space-6` |
| Page section separation | `--space-7` |

Do not introduce arbitrary gaps such as:

```text
7px
11px
13px
17px
19px
23px
```

unless there is a genuine technical reason.

---

## 5.2 Typography scale

```css
:root {
  --text-xs: 11px;
  --text-sm: 12px;
  --text-md: 13px;
  --text-base: 14px;
  --text-lg: 16px;
  --text-xl: 20px;
  --text-2xl: 25px;
  --text-3xl: 30px;

  --weight-regular: 400;
  --weight-medium: 500;
  --weight-semibold: 600;
  --weight-bold: 700;
}
```

### Typography roles

| Role | Style |
|---|---|
| Metadata | 11–12px |
| Table body | 13px |
| Default UI text | 13–14px |
| Card heading | 13–14px / semibold |
| Section heading | 16px / semibold |
| Page title | 25px / semibold |
| Metric value | 28–30px / semibold |

### Rules

- Do not use more than one heading style inside a card unless required.
- Page titles establish the strongest hierarchy.
- Card titles remain visually secondary.
- Metadata should use muted colour rather than tiny unreadable text.

---

## 5.3 Radius scale

Preserve the existing visual character:

```css
:root {
  --radius-xs: 6px;
  --radius-sm: 8px;
  --radius: 12px;
  --radius-lg: 16px;
  --radius-xl: 20px;
  --radius-pill: 999px;
}
```

Recommended usage:

- Inputs: `--radius-sm`
- Buttons: `--radius-sm`
- Cards: `--radius`
- Topbar: `--radius-lg`
- Dialogs: `--radius-lg`
- Sidebar island: `--radius-xl`
- Status badges: `--radius-pill`

---

## 5.4 Motion scale

```css
:root {
  --duration-fast: 120ms;
  --duration-normal: 180ms;
  --duration-slow: 260ms;

  --ease-standard: cubic-bezier(.2, .8, .2, 1);
}
```

Use motion only to explain state changes.

Good:

- drawer opening
- tabs changing
- hover feedback
- popovers
- progress changes

Avoid:

- decorative floating animations
- continuously moving cards
- large entrance animations on every page

Respect:

```css
@media (prefers-reduced-motion: reduce)
```

---

# 6. Canonical Shared Components

## 6.1 Buttons

### Primary

```jsx
<button className="btn btn-primary">
```

Use for the primary action of a page or section.

Examples:

- Add employee
- Create request
- Save changes
- Submit approval

Limit primary buttons to one dominant action per context.

### Secondary

```jsx
<button className="btn">
```

Neutral bordered button.

### Ghost

```jsx
<button className="btn btn-ghost">
```

Use for repeated secondary actions.

### Small

```jsx
<button className="btn btn-sm">
```

Use inside dense tables and rows.

### Danger

```jsx
<button className="btn btn-danger">
```

Use only for destructive actions.

### Compatibility aliases

To avoid rewriting business-heavy JSX immediately:

```css
.btn.primary {
  /* same visual rules as .btn-primary */
}

.btn.small {
  /* same visual rules as .btn-sm */
}

.btn.danger,
.danger.btn {
  /* same visual rules as .btn-danger */
}
```

This fixes broken pages while allowing gradual migration to canonical classes.

---

# 7. Canonical Status System

Create one shared badge system.

## Base markup

```jsx
<span className="badge badge-success">
  <span className="badge-dot" />
  Approved
</span>
```

Supported variants:

```text
.badge-success
.badge-warning
.badge-danger
.badge-info
.badge-neutral
```

## Rules

Every status must communicate meaning through more than colour:

- dot
- icon
- text
- font weight

Do not create separate pill implementations for:

- leave
- loans
- assets
- timesheets
- payroll
- onboarding

Module-specific status classes should only map to canonical badge variants.

Example:

```css
.lv-pill,
.ln-pill,
.as-pill,
.ts-pill {
  /* migration alias or eventually removed */
}
```

Preferred long-term markup:

```jsx
<span className="badge badge-warning">
```

---

# 8. Modern Card System

## Standard card

```jsx
<section className="card">
```

Structure:

```jsx
<section className="card">
  <div className="card-head">
    <div>
      <h2 className="card-title">Title</h2>
      <p className="card-note">Optional description</p>
    </div>

    <div className="card-tools">
      {/* actions */}
    </div>
  </div>

  {/* content */}
</section>
```

## Card principles

- White/dark surface
- Thin border
- Subtle shadow
- 12px radius
- Comfortable padding
- No unnecessary coloured backgrounds

Cards should represent grouping, not decoration.

---

# 9. Page Layout System

## 9.1 Standard page

```jsx
<div className="page-content">
  <header className="page-head">
    <div>
      <h1 className="page-title">Page title</h1>
      <p className="page-sub">Supporting context</p>
    </div>

    <div className="head-actions">
      {/* actions */}
    </div>
  </header>

  {/* filters */}

  {/* page content */}
</div>
```

The existing `.main` shell remains responsible for the outer application layout.

`.page` should not become a competing layout system.

For compatibility:

```css
.page {
  width: 100%;
  min-width: 0;
}
```

---

# 10. Eight Page Archetypes

## A. Dashboard

Structure:

```text
Page Header
↓
Filter Row
↓
Metric Grid
↓
Primary Insights Grid
↓
Detailed Table / Activity
```

Use:

- 3–5 stat tiles
- 1–2 prominent charts
- one detailed table below

Avoid making every chart equal in visual weight.

---

## B. Filterable Data Table

Structure:

```text
Page Header + Primary Action
↓
Filter Row
↓
Results Count / Bulk Actions
↓
Card
  └── Table
↓
Pagination
```

Tables should:

- maintain consistent row height
- use readable headers
- align numeric values right
- use tabular numbers
- provide horizontal scrolling on smaller screens

---

## C. List + Detail

Use for:

- Helpdesk
- Tickets
- Approval review
- Document workflows

Desktop:

```text
┌───────────────┬──────────────────────────┐
│ List          │ Detail                   │
│ Search        │ Header                   │
│ Filters       │ Content                  │
│ Rows          │ Activity / Actions       │
└───────────────┴──────────────────────────┘
```

Mobile:

```text
List
↓
Selected Detail
```

Do not attempt to keep both columns visible on narrow screens.

---

## D. Settings

Structure:

```text
Page Header
↓
Settings Navigation / Tabs
↓
Settings Groups
  Label + Description | Control
  Label + Description | Control
↓
Sticky Save Bar
```

The left edge of labels must align.

Use consistent row spacing and avoid random form card layouts.

---

## E. Wizard / Multi-Step Form

Structure:

```text
Progress
↓
Step Title
↓
Step Description
↓
Form Content
↓
Back / Continue Actions
```

Each step should have one clear purpose.

Avoid placing too many unrelated form sections in one step.

---

## F. Card Grid

Use for:

- Projects
- Assets
- Plans
- Templates

Rules:

- equal card rhythm
- consistent title placement
- consistent action location
- responsive grid
- no unnecessary colour coding

---

## G. Checklist / Task Groups

Use for:

- Onboarding
- Offboarding
- Workflows

Structure:

```text
Group Title + Progress
↓
Task rows
↓
Task rows
↓
Next group
```

Each task row should clearly show:

- completion state
- title
- owner if applicable
- due information
- action

---

## H. Self-Service “My X” Page

Examples:

- My Leave
- My Attendance
- My Assets
- My Salary

Structure:

```text
Personal summary / hero action
↓
Key balances or metrics
↓
Primary task
↓
History / details
```

The user's most likely action should be visually obvious.

---

# 11. Responsive Strategy

## Desktop: above 1100px

- Full sidebar
- Full breadcrumb
- Multi-column layouts where appropriate

## Tablet: 860px–1100px

- Reduce secondary chrome
- Allow grids to reduce naturally
- Preserve readable tables

## Mobile: below 860px

Keep the existing application behaviour:

- sidebar becomes off-canvas drawer
- topbar becomes full-width
- drawer uses `100dvh`
- breadcrumbs are simplified
- search trigger is simplified

## Small mobile: below 640px

Module grids become single-column.

Forms should stack.

Split views should become sequential views.

Horizontal data tables should scroll instead of compressing text into unreadable columns.

---

# 12. Fixing the Current Broken Class Dialect

The project currently contains newer pages using class names that do not match the canonical CSS classes.

The safest first modernization step is **compatibility aliases**.

## Required aliases

```css
/* Primary button compatibility */
.btn.primary {
  /* canonical .btn-primary appearance */
}

/* Small button compatibility */
.btn.small {
  /* canonical .btn-sm appearance */
}

/* Danger compatibility */
.btn.danger,
.danger.btn {
  /* canonical .btn-danger appearance */
}

/* Row action layout */
.row-actions {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

/* Secondary text */
.muted {
  color: var(--text-muted);
}

/* Safe page wrapper */
.page {
  width: 100%;
  min-width: 0;
}
```

After all pages are visually stable, gradually migrate JSX to canonical classes.

Do not perform a large blind search-and-replace across the entire project.

---

# 13. CSS Conflict Elimination Strategy

## Phase 1 — Stabilize

Do not rewrite all module CSS immediately.

First:

1. Add missing aliases.
2. Define missing global utility classes.
3. Add missing tokens using existing semantic tokens.
4. Verify all pages render correctly.

## Phase 2 — Centralize primitives

Move shared visual primitives into `styles.css`:

- buttons
- badges
- cards
- meters
- empty states
- notices
- dialogs

## Phase 3 — Namespace modules

Rename conflicting module selectors carefully.

Example:

```text
.pf-actions
```

becomes:

```text
.platform-actions
```

or:

```text
.perf-actions
```

depending on ownership.

Do not rename both blindly.

Each selector rename must be updated in its matching TSX.

## Phase 4 — Remove duplicates

Once a module uses shared primitives, remove duplicate primitive styling from the module stylesheet.

---

# 14. Missing Token Strategy

Do not introduce random hardcoded colours.

Map undefined legacy tokens to existing semantic tokens.

Recommended compatibility mapping:

```css
:root {
  --danger-text: var(--status-critical);
  --danger: var(--status-critical);
  --status-bad: var(--status-critical);
  --status-ok: var(--status-good);
  --ok: var(--status-good);
  --surface: var(--surface-1);
  --radius-md: var(--radius);
}
```

For warning backgrounds, use token composition rather than fixed hex values where supported.

All new styling must remain compatible with light and dark themes.

---

# 15. Tables

Tables should become a consistent enterprise UI pattern.

## Requirements

- 13px body text
- compact but comfortable row spacing
- clear sticky header on desktop
- muted uppercase header labels
- subtle row separators
- hover state
- right alignment for numbers
- tabular numeric figures
- consistent action cells

Recommended action markup:

```jsx
<div className="row-actions">
  <button className="btn btn-sm">Edit</button>
  <button className="btn btn-sm btn-ghost">View</button>
</div>
```

On small screens:

- preserve table integrity
- use horizontal scrolling
- do not shrink text excessively

---

# 16. Forms

All controls sharing the same row must continue to use:

```css
--control-h: 34px;
```

Form design should be modern through consistency, not oversized controls.

Each field should have:

- clear label
- optional help text
- visible focus state
- error state
- sufficient spacing

Avoid floating labels unless already implemented intentionally.

---

# 17. Accessibility Requirements

Every redesign must preserve or improve accessibility.

Required:

- visible `:focus-visible`
- keyboard usable controls
- sufficient contrast
- semantic buttons remain buttons
- labels remain connected to form controls
- status meaning is not colour-only
- reduced motion support
- readable text sizes

Do not replace semantic elements with clickable `<div>` elements for visual reasons.

---

# 18. Platform Console

The platform/super-admin console must remain visually distinct from the tenant console.

This is intentional.

The redesign should preserve:

- darker operator chrome
- clear environment identity
- strong separation from customer-facing tenant UI

Do not accidentally make the platform console look identical to the tenant application.

Shared primitives may remain consistent, while the shell identity stays distinct.

---

# 19. Recommended Implementation Order

## Step 1 — Backup and visual baseline

Before changing CSS:

- capture screenshots of major routes
- test light mode
- test dark mode
- test mobile layout
- identify current visual regressions

## Step 2 — Add design scales

Add:

- spacing tokens
- typography tokens
- radius tokens
- motion tokens

Do not remove existing colour tokens.

## Step 3 — Fix broken compatibility classes

Add aliases for:

- `.btn.primary`
- `.btn.small`
- `.danger`
- `.muted`
- `.row-actions`
- `.page`

This should immediately improve many broken HRMS pages.

## Step 4 — Build canonical primitives

Standardize:

- buttons
- badges
- cards
- tables
- forms
- dialogs
- empty states
- notices

## Step 5 — Fix CSS collisions

Namespace conflicting modules one at a time.

## Step 6 — Modernize page archetypes

Apply shared templates to:

- dashboards
- tables
- settings
- split views
- wizards
- card grids
- checklists
- self-service pages

## Step 7 — Responsive QA

Test:

- desktop
- tablet
- mobile
- sidebar drawer
- horizontal tables
- forms
- dialogs

## Step 8 — Theme QA

Verify every major route in:

- system mode
- light mode
- dark mode

---

# 20. QA Checklist

## Visual consistency

- [ ] All primary buttons use one canonical style
- [ ] All secondary buttons use one canonical style
- [ ] All danger actions are visually distinct
- [ ] All statuses use the shared badge system
- [ ] Cards have consistent radius and spacing
- [ ] Tables have consistent headers and rows
- [ ] Page titles use the shared hierarchy
- [ ] Module CSS does not redefine shared primitives

## Responsive

- [ ] Sidebar drawer works below 860px
- [ ] Module grids collapse below 640px
- [ ] Tables remain usable
- [ ] Split views work on mobile
- [ ] Dialogs fit mobile viewports
- [ ] Sticky save bars remain accessible

## Theme

- [ ] Light theme works
- [ ] Dark theme works
- [ ] System theme works
- [ ] No critical hardcoded colours break dark mode
- [ ] Focus rings remain visible

## Backend safety

- [ ] No API endpoint changed
- [ ] No API request changed
- [ ] No API response handling changed
- [ ] No route changed
- [ ] No authentication logic changed
- [ ] No business logic changed
- [ ] No database/backend code changed

---

# 21. Definition of Success

The redesign is successful when:

1. Every existing route still works exactly as before.
2. Backend and API behaviour remain untouched.
3. Broken HRMS pages receive correct shared styling.
4. Shared components have one canonical visual implementation.
5. CSS selector collisions are removed.
6. Light and dark modes remain reliable.
7. Mobile layouts remain usable.
8. The interface feels like one professional enterprise product rather than multiple independently styled modules.
9. The existing violet floating-shell identity is preserved.
10. The application becomes easier to maintain without introducing new dependencies.

---

# Final Instruction for Implementation

Treat this as a **visual system migration**, not a product rewrite.

The preferred implementation pattern is:

```text
Existing API/business logic
        ↓ unchanged
Existing React components
        ↓ minimal structural changes only
Canonical semantic class names
        ↓
Shared design system CSS
        ↓
Modern, consistent UI
```

The backend is not part of this redesign.

**Only frontend presentation, CSS architecture, responsive layout, visual consistency and accessibility should change.**
