# Building with DEMI Admin

The staff-facing admin UI for DEMI, the EAO's project and document registry. React 19, styled
with the B.C. Design System tokens plus the EPIC (EAO) layer on top.

These 35 components are the whole importable surface. The BCDS React primitives some of them wrap
are compiled in but not re-exported, so there is no `Button` or `InlineAlert` to import here — the
button inside `ScreenHeader` and the alerts inside `ErrorAlert` and `ProposalBanner` come along
with those components. Need a bare BCDS primitive? Compose one of these instead, or style your own
element with the tokens below.

## Setup

Most components need no wrapper. Four read react-router and must be inside a router:
`Layout`, `Header`, `Sidebar`, `AccountMenu`. `Layout` renders an `<Outlet />`, so it needs a
route tree, not just a router:

```jsx
<MemoryRouter initialEntries={['/']}>
  <Routes>
    <Route path="/" element={<Layout />}>
      <Route index element={<Overview />} />
    </Route>
  </Routes>
</MemoryRouter>
```

`AccountMenu` reads the Keycloak session. With no session it renders a `?` avatar — that is the
signed-out state, not a bug.

## The styling idiom

**Plain CSS classes, BEM-ish, defined in `styles.css`'s import closure.** No utility framework, no
style props, no CSS-in-JS. Components carry their own classes; write your own layout glue with
tokens, not with new component classes.

The vocabulary, by family:

| Family | Classes |
|---|---|
| Surfaces | `panel`, `panel--padded`, `panel--scroll`, `panel__title`, `panel__title--inline`, `panel__lede`, `panel__actions`, `panel-grid` |
| Table and row cells | `cell__title`, `cell__sub`, `cell__mono`, `cell--muted`, `cell--right`, `cell--nowrap`, `cell--truncate`, `cell--figures`, `row-actions` |
| Status | `pill` + `pill--success` / `--warning` / `--danger` / `--info` / `--neutral`, `pill--caps` |
| Figures | `stat-card`, `stat-card__value`, `stat-card__note`, `stat-grid`, `micro-label`, `row-grid`, `row-grid__figure` |
| Progress | `progress` + `progress--small` / `--medium`, `progress__fill` |
| Roles | `role-chip`, `role-chips`, `role-card`, `role-card__name`, `role-card__desc`, `role-card__tier`, `role-card__tier--write`, `role-grid` |
| Screen chrome | `screen-header`, `screen-header__text`, `footnote`, `proposal-banner`, `alert-row`, `callout`, `callout--warning` |
| App shell | `app`, `app__body`, `app__main`, `app-header`, `app-header__title`, `app-header__env`, `app-sidebar`, `app-sidebar__link`, `app-sidebar__heading`, `app-footer` |
| Key/value | `kv-grid`, `kv-row`, `kv-row--stacked`, `kv-row__key`, `kv-row__value` |

`micro-label` is the uppercase letter-spaced label above every figure. Use it, don't restyle a
`<div>` to look like it.

## Tokens

Every colour, space, radius and type ramp is a `var(--*)`. Never hard-code a hex.

- **B.C. Design System** (in `tokens/variables.css`): `--surface-color-background-white`,
  `--surface-color-background-light-gray`, `--surface-color-border-default`,
  `--surface-color-primary-default`, `--typography-color-primary`, `--typography-color-secondary`,
  `--typography-color-link`, `--typography-regular-body`, `--typography-bold-h4`,
  `--typography-regular-small-body`, `--layout-padding-{xsmall,small,medium,large}`,
  `--layout-margin-{hair,xsmall,small,medium,large}`, `--layout-border-width-small`,
  `--layout-border-radius-{small,medium,circular}`.
- **EPIC (EAO) layer**: `--theme-primary-gold` (the gold rule under the dark blue header — the EAO
  tell), `--eao-on-dark-muted`, `--eao-on-dark-divider`, `--eao-sidebar-width`,
  `--eao-header-mark-height`, and the nine phase colour triples (`--eao-decision-main`,
  `--eao-effects-assessment-dark`, …).

Phase colours are decoration only — most fail 4.5:1 on white. Never signal status by colour alone;
that is what `StatusPill` text is for.

Type is BC Sans, shipped in `fonts/`. Read `styles.css` and the files it imports before styling
anything; per-component API is in each `<Name>.d.ts` and `<Name>.prompt.md`.

## A typical screen

```jsx
<>
  <ScreenHeader title="Uptime" lede="Availability of DEMI and the services it depends on."
                action="Open status page" />
  <ProposalBanner />

  <StatGrid>
    <StatCard label="Documents indexed" value="61,204" note="median 3.4s each" />
  </StatGrid>

  <Panel title="Services" scroll>
    <RowGrid columns="minmax(12rem, 1fr) 7rem 8rem" minWidth="38rem">
      <div>
        <div className="cell__title">demi-api</div>
        <div className="cell__sub">Azure Functions, Canada Central</div>
      </div>
      <RowStat label="Latency" value="84ms" />
      <div className="cell--right"><StatusPill variant="success">Healthy</StatusPill></div>
    </RowGrid>
  </Panel>

  <Footnote>Figures lag up to 24 hours.</Footnote>
</>
```

Use `DataTable` when the columns are regular, `RowGrid` when they are not. `ProposalBanner` marks
a screen the API cannot serve yet — keep it on anything showing invented data.

# EagleDemiAdmin (eagle-demi-admin@0.0.0)

This design system is the published eagle-demi-admin React library, bundled as a single
browser global. All 35 components are the real upstream code.

## Where things are

- `_ds_bundle.js` — the whole-DS bundle at the project root; loads every component to `window.EagleDemiAdmin`. First line is a `/* @ds-bundle: … */` metadata header.
- `styles.css` — the single stylesheet entry: it `@import`s the tokens, fonts, and component styles (`_ds_bundle.css`). Link this one file.
- `components/<group>/<Name>/<Name>.prompt.md` (example JSX + variants), `<Name>.d.ts` (types), `<Name>.html` (variant grid).
- `tokens/*.css` — CSS custom properties, names verbatim from upstream.
- `fonts/` — `@font-face` files + `fonts.css` (when the package ships fonts).

For a specific component, `read_file("components/<group>/<Name>/<Name>.prompt.md")`.

## Loading

Add these two lines to your page once (React must be on the page first):

```html
<link rel="stylesheet" href="styles.css">
<script src="_ds_bundle.js"></script>
```

Components are then available at `window.EagleDemiAdmin.*`. Mount into a dedicated child node (e.g. `<div id="ds-root">`), not the host page's own React root, so the two trees don't collide:

```jsx
const { AccountMenu } = window.EagleDemiAdmin;
ReactDOM.createRoot(document.getElementById('ds-root')).render(<AccountMenu />);
```

Wrap the tree in the provider — most components read theme/i18n from context:

```jsx
<PreviewRouter>{children}</PreviewRouter>
```

## Tokens

204 CSS custom properties from @bcgov/design-tokens. Names are
preserved verbatim from upstream. See `tokens/` for the full list.

- **color** (79): `--surface-opacity-0`, `--surface-opacity-10`, `--surface-opacity-20`, …
- **spacing** (17): `--layout-padding-none`, `--layout-padding-hair`, `--layout-padding-xsmall`, …
- **typography** (25): `--typography-font-families-bc-sans`, `--typography-line-heights-xxxdense`, `--typography-line-heights-xxdense`, …
- **radius** (5): `--layout-border-radius-none`, `--layout-border-radius-small`, `--layout-border-radius-medium`, …
- **other** (78): `--icons-size-xsmall`, `--icons-size-small`, `--icons-size-medium`, …

## Components

### shell
- `AccountMenu`
- `Footer`
- `Header`
- `Layout`
- `Sidebar`

### screens
- `ApiKeys`
- `AuditLog`
- `AzureSpend`
- `DataExport`
- `DataSourceSyncs`
- `DocumentProcessing`
- `EagleNotify`
- `GeolocationSync`
- `Overview`
- `Profile`
- `Roles`
- `Sessions`
- `ShortUrls`
- `SiteAnalytics`
- `Uptime`

### general
- `DataTable`
- `ErrorAlert` — A failed DEMI call, shown in place. ApiError's message already carries the status and the body
- `Footnote`
- `Panel`
- `PanelGrid`
- `ProgressBar`
- `ProposalBanner` — Marks a screen, or one region of it, the API cannot serve yet, so nobody reads it as live data.
- `RoleChip`
- `RoleChips`
- `RowGrid` — One row of a grid that stands in for a table when the content is too irregular for one.
- `RowStat` — A stacked micro-label over its value, used inside row grids.
- `ScreenHeader`
- `StatCard`
- `StatGrid`
- `StatusPill`
