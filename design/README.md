# Design handoffs

How a design mockup becomes code in this repo.

## The loop

1. Design in the design system canvas.
2. Export a handoff bundle. Ask for an **HTML spec export**, not an app
   export — the useful bundle is a `.dc.html` mockup plus a `README.md` of instructions, not a
   compiled SPA.
3. Unzip it to `design/handoffs/<name>/`, where `<name>` is short and dated or sequenced
   (`2026-09-04-audit-filters`, `handoff-B3`).
4. Implement it following the rules below.


## What implementing a handoff means

Read `design/handoffs/<name>/README.md` first. It is the spec: tokens, layout, per-screen data
shapes, interaction notes. Then:

**Reuse what exists. Do not rebuild it.** Angular templates here use plain CSS classes, not
components. A handoff describing a pattern already styled in
`frontend/src/styles/vendor/demi-admin.css` means *use that class*, not invent new markup:

| Handoff calls it | Use |
| --- | --- |
| Panel | `.panel`, `.panel-grid` |
| Status pill | `.pill` |
| Stat card | `.stat-card` |
| Key/value grid | `.kv-grid` |
| Screen heading with a right-hand action | `.screen-header` |
| "Not wired yet" notice | `.callout` |
| Footnote | `.footnote` |
| Header, mark, env pill | `.eao-header` (in `components.css`) |
| Sidebar | `.eao-sidebar` (in `components.css`) |
| Account menu | `.account` |

A pattern with no class above is the one thing to build — add it to
`frontend/src/styles.css` as an app-local rule (the vendor files are synced from elsewhere and
get overwritten; see `frontend/scripts/sync-design-css.sh`).

**Strip the prototype runtime.** A `.dc.html` renders through `support.js`: `<x-dc>`, `<sc-for>`,
`<sc-if>`, `{{ }}` holes, `style-hover`. None of it is production code. Take the layout, the copy,
the data shapes and the exact token usage; leave the runtime behind.

**Keep values as tokens.** Every colour, space and radius in a mockup is a `var(--*)` into the BC
Design System or the EPIC layer. Wire to the token, never the resolved hex.

**Fixture-backed screens keep their banner.** Anything the API cannot serve yet renders a
`.callout` so nobody reads invented numbers as live data.

## Serving a bundle

Serve over HTTP — opening `.dc.html` from the filesystem blocks the stylesheet and font loads:

```sh
npx serve design/handoffs/<name>
```

## Bundles here

| Bundle | What it covers |
| --- | --- |
| `2026-08-28-revision/` | Redesign of the DEMI frontend: shell, discover, operate, developer and account screens. |
