# Parity screenshots

`capture.mjs` photographs the same screen in the Angular app and in the React app, at the same
widths, with the same API answers. It does no image comparison: a reviewer looks at the pairs.

## Run it

The Angular app was removed from `frontend/` when the React app replaced it. To get the reference
app back, check out a commit from before that change in a separate worktree. `0038d3e` is the
last commit that has both apps. It stays reachable only if the cutover pull request is merged
with a merge commit; a squash merge drops it from `main`.

Start both apps first, in two shells:

```
# shell 1, from the repo root
git worktree add /tmp/demi-angular 0038d3e
cd /tmp/demi-angular/frontend && yarn install && yarn start --host 127.0.0.1 --port 4200

# shell 2, from the repo root
cd frontend && yarn dev --host 127.0.0.1 --port 4300
```

Then, from `frontend/`:

```
node parity/capture.mjs                       # defaults below
node parity/capture.mjs --routes /workspace,/keys,/links --widths 1440,400
node parity/capture.mjs --only routes         # route screens only, skip the shell states
node parity/capture.mjs --only states         # shell states only, skip the route screens
node parity/capture.mjs --help
node parity/capture.mjs --dry-run             # browser check only, visits neither app
```

Defaults: Angular `http://localhost:4200`, React `http://localhost:4300`, routes
`/workspace,/keys`, widths `1440,1024,400`, output `parity/out`, shell states on `/keys`.

Pick different ports with `--angular` and `--react` if something already holds those.
Both must be on this machine: the script refuses any base URL that is not `localhost`,
`127.0.0.1` or `[::1]`, because it rewrites `env.js` in flight and photographs whatever answers.

The viewport height is fixed at 900 px at every width. Screenshots are full page, so the height
only decides how much of the screen is above the fold, which is what the sticky header and the
rail react to.

PNGs land at `parity/out/<screen>/<width>/{angular,react}.png`, where `<screen>` is the route with
slashes turned into dashes and the leading slash dropped: `/workspace` becomes `workspace`.
`parity/out/` is ignored by git. The script exits non-zero if any screen fails to capture.

## What the script feeds the apps

`env.js` is intercepted for both apps. Each app's own file is served as written, with an override
block appended that sets `configEndpoint=false`, `KEYCLOAK_ENABLED=false`, `API_LOCATION=''`,
`API_PATH='/api'`, `ENVIRONMENT='test'`, `NOTIFY_API_LOCATION='/notify-api'` and an empty
`APPINSIGHTS_CONNECTION_STRING`. Nothing on disk is edited, and a key either app adds later still
reaches the page.

`/api/**` and `/notify-api/**` are answered from `parity/fixtures/`. The file name is the path
after the `/api` or `/notify-api` prefix, query string dropped, slashes turned into dashes:

| Request | Fixture |
|---|---|
| `/api/config/public` | `config-public.json` |
| `/api/config` | `config.json` |
| `/api/me` | `me.json` |
| `/api/me/data` | `me-data.json` |
| `/api/admin/api-keys` | `admin-api-keys.json` |

A path with no fixture is answered with `{}` and its file name is printed at the end of the run.
A screen that wanted a list will show its own empty or error state, which is the signal to add the
fixture. Adding one is a new file in `parity/fixtures/`; the script needs no change.

`admin-api-keys.json` is not optional on the `/keys` state route: the Angular screen's `@for` over
that list throws when it gets `{}` instead of an array, and an exception thrown mid-render aborts
Angular's change detection pass for the whole page that tick — including the how-built panel,
which sits in the same view tree. That is what an earlier run's empty how-built panel actually
was: not a slow render, but this crash on a loop starving every sibling of a chance to paint.

## Waiting for the shell to settle

Before each shot the script waits, with a 15 second budget (`--timeout`), for all of:

- the real header, `header.eao-header:not([aria-hidden])`. The loading skeleton wears the same
  class with `aria-hidden`, so a page that never boots fails the run instead of producing a white
  PNG;
- the rail link for the current route carrying `aria-current="page"`. Both apps mark it that way
  and neither adds a class for it — Angular through `routerLinkActive`, React through `NavLink`.
  Without this wait a shot can land before the rail has caught up with the route, which is how an
  earlier run photographed Angular's `/workspace` at 1440 with nothing marked. Skipped below
  900 px, where the rail is off-canvas and no link is on the page until the drawer is open;
- no request still in flight (`networkidle`);
- `document.fonts.ready`, so nothing is measured against fallback metrics.

## Shell states

The routes above only ever show the shell at rest. These states are captured as well, for both
apps, under `parity/out/_shell/<state>/<width>/{angular,react}.png`:

| State | Widths | What it shows |
|---|---|---|
| `account-menu` | 1440, 400 | Account menu open |
| `how-built` | 1440, 400 | "How this is built" panel open |
| `drawer` | 400 | Navigation drawer open |
| `nav-focus` | 1440, 400 | Keyboard focus on the first rail link, tabbed from the skip link |
| `sign-in` | 1440, 400 | Keycloak on, nothing remembered |
| `loading` | 1440, 400 | `/me` held open, so the gate's skeleton is what lands |

The buttons carry the same `aria-label` in both apps, so one set of selectors drives both sides.
`--only states` runs just these; `--state-route` picks the screen they sit on.

`how-built` waits for the panel's own title (`[role="dialog"] h2`) and at least one tag chip
(`[role="dialog"] span`) to be visible before the shot, not just for the click to register — a
panel can be in the DOM and still be photographed empty (see `admin-api-keys.json` below for why
that actually happened on the `/keys` state route).

Neither app calls `GET /me` on the `sign-in` state: there is no session, so no token to send it.
An earlier version of this script forced that request to answer 401 to paper over a React bug
that called it anyway; the bug is fixed, so the workaround is gone and the fixture answers
normally like everywhere else.

### Loading state

`loading` delays the `/me` fixture by `meDelayMs` and photographs the page before it answers, with
`networkidle` skipped for that one wait — otherwise the script would just wait past the shot it is
trying to catch. Auth stays off (`KEYCLOAK_ENABLED: false`, the default below): with Keycloak on
and no session, the sign-in state's fix means React skips the `/me` call entirely and the skeleton
would drop immediately, before the delayed fixture ever mattered. With auth off, both gates await
`/me` unconditionally — Angular's `authSettled()` and React's `SessionProvider` — so this is the
one state where holding that response open holds the skeleton in both apps. `/config` is not
delayed: both apps await it before their root component mounts at all, so a slow answer there
produces a blank page instead of a skeleton.

## Why no sign-in appears

With `KEYCLOAK_ENABLED=false` both apps treat the visitor as staff and render the shell straight
away. In Angular, `registry-state.service.ts` sets `authEnabled` from `KEYCLOAK_ENABLED !== false`,
and `isStaff()` returns `true` whenever auth is off; `app.component.html` shows the sign-in screen
only when `isStaff()` is false. The React app applies the same rule in `src/session/`:
`authEnabled()` reads the same key and `isStaff` is `true` when it is off. So both apps skip
the sign-in screen and go straight to the routed screen, which is what makes the pairs comparable.

## Playwright

Playwright is not a dependency of this app and must not be added to `package.json`. The script
resolves it by name first, so a machine that has it on its module path just works. Otherwise point
at an existing install:

```
PLAYWRIGHT_MODULE=/abs/path/to/node_modules/playwright/index.mjs node parity/capture.mjs
```

With neither, the script says so and exits non-zero. No machine's own path is written down here:
this repository is public.
