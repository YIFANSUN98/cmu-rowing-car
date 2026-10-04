# Launch · CMU Rowing Carpool

A private weekly carpool planner with two shared access keys. Admins upload Excel inputs, calculate routes with TomTom, and publish the reviewed plan. Drivers and rowers can view the published routes and download their plan without accessing the input files. A small Node server stores private files; no individual accounts or database are needed. See [access, password changes and deployment](docs/ACCESS.md). Admins can also [manually arrange and revise routes](docs/MANUAL_PLANNING.md), including published plans, without changing the input sheets.

## Run locally

Use Node **24 LTS** (tested with 24.21.0) and npm:

```bash
npm ci
npm run access:init
npm run server
# In a second terminal:
npm run dev
```

Set `VITE_TOMTOM_API_KEY` in `.env.local` using [free TomTom setup](docs/TOMTOM.md), then restart Vite. Open **http://127.0.0.1:5173/cmu-rowing-car/**, sign in with the admin key from the private `data/private/server/access-keys.txt` file, select the three .xlsx files together, and click **Plan week**. TomTom is the website routing provider. Keep the account on its free allowance, without purchased credits or paid billing. For a production preview:

```bash
npm run build
APP_ORIGIN=http://127.0.0.1:4173 PORT=4173 npm start
```

Open **http://127.0.0.1:4173/cmu-rowing-car/**. The Node server serves `dist/` and the authenticated API. Keep the private data directory outside `dist/`.

On the development machine where this MVP was built, Node was absent from PATH. A checksum-verified official Node distribution was installed at the following user-local location; activate it if needed:

```bash
export PATH="$HOME/.local/share/cmu-rowing-toolchain/node-v24.21.0-linux-x64/bin:$PATH"
```

## What works

- One upload area accepts the three `.xlsx` files in a single selection or drop, detecting their roles by headers and Attendance/Drivers grid tab names. A workbook containing all three tables can also be selected once. Duplicate input types are rejected; hidden archive tabs are ignored. Native dates/times and boolean cells are supported. Templates download as `.xlsx`; CSV, XLS and renamed non-XLSX workbooks are rejected. Source file/tab/row references remain available in validation issues.
- Shared-key login enforces admin/team roles on the server. Admins can change either key online in **Manage access**, by editing the private `data/private/server/access-keys.txt` file, or with the local CLI, revoking old-key sessions. Saved local edits apply on the next website request without restarting. **Publish to team** shares only the selected route details; original spreadsheets stay admin-only.
- TomTom routing starts only when **Plan week** is clicked. Selecting files reads them locally. **Plan week** or **Save Excel files** sends the originals to private admin-only storage on the app server. On page load, the weather panel fetches public Pittsburgh observations from the National Weather Service; it sends no member data. Provider failures remain visible; there is no mock fallback.
- Explicit driver eligibility, capacities including the driver, shared pickup stops, date-specific pickup overrides, readiness, earliest departures, service times and route-duration limits.
- Driver-set exploration, exact pickup ordering for each car, insertion/local improvement, and weekly beam search for availability-adjusted fairness. A separate constraint checker replays every feasible result.
- Compact car cards show the driver and riders; **Show route** expands an interactive road map, numbered pickup sequences/times, seat occupancy, leg navigation links and copyable instructions. The map shows the road alternative used for the verified timing; it loads only when expanded and makes no additional Routing call. The result page omits travel-category lists, JSON/CSV/print controls and technical search details. A matching CMU Rowing crest finishes the page.
- The loading bar fills from 0 to 100% as work completes: pickup locations and travel estimates (65%), car assignments (10%) and route checks (25%). It never moves backwards or repeats an animation; 100% appears only after the result is ready. The percentage measures weighted work, not remaining time.
- **Download Excel** saves one tab per date, with cars stacked vertically and separated by a blank row. Each car has three columns: driver/pickup names, time and street address (omitting the shared Pittsburgh, PA and ZIP suffix). The driver comes first, followed by pickup names in route order without number prefixes, then the boathouse. Driver times are departure times; other times are arrivals, all Eastern Time. Shared pickups repeat the same time and address. Pickup names link to directions using the full original addresses. Any incomplete-day notes stay on that date's tab. Recalculate outdated plans before downloading. The export is generated locally without new routing calls. Website, copied instructions and Excel times display only hours and minutes; seconds are omitted from presentation while routing calculations retain their precision.
- Immediate stale marking on changed operational inputs/settings; cancellation terminates the planner Worker and ignores late provider results.
- TomTom HTTP adapter with explicit activation, future-date traffic, scoped travel estimates using Routing batches, in-session caching, and batched complete-route rechecks. It compares all pickup orders for each selected car and up to two road alternatives, including boarding pauses. Quota/access failures stop planning. Live browser API checks passed with the locally configured key, public campus locations, and fictitious member names; the automated regression tests use controlled HTTP responses. The Google adapter remains available to developer tests, but the website does not load it.
- Production Node server with private file storage and HTTPS deployment instructions. See [access setup](docs/ACCESS.md) and [TomTom quotas and limitations](docs/TOMTOM.md).

Simulation metadata is retained internally for hypothetical source data and in copied instructions. The website has no demo, mock selector, automatic test preparation, or hypothetical availability controls. The demo dates and locations are fictitious. Estimates are not guarantees of actual arrival.

## Inputs and review

See [the schema](docs/SCHEMA.md). Download simple, name-based Excel templates from the app. Members edit names, pickup addresses, attendance and driver availability; no IDs or pickup confirmations are required. Everyone marked attending needs a carpool seat. Attendance and Drivers use member rows and date columns with Yes/No answers. Drivers has no Seats column; the planner uses five total seats for each Yes driver. Use the same name in all three sheets. Complete fictitious inputs are in `public/demo/`. Older canonical inputs remain supported. Reupload reviewed files to correct errors; the app does not silently merge identities or confirm ambiguous values.

The destination is **300 Waterfront Dr, Pittsburgh, PA 15222**, as supplied by the user. Destination and arrival time sit beside the rowing illustration. Its clock shows the current Pittsburgh date and time in **America/New_York**, updates at each minute, and refreshes when the tab becomes visible. It reads the device clock and is independent of the chosen arrival deadline. Practice dates appear with the uploaded week. There is no arrival buffer; planning targets the selected deadline, including times after 05:15. The internal defaults remain 04:00 earliest departure, 60-minute maximum route, 60 seconds per boarding stop, a 10% fairness travel allowance and seed 42; these controls are not displayed. All times use **America/New_York**, and vehicles seat at most five people including the driver.

The illustration has one compact panel for the current Pittsburgh time/date, air temperature, and water flow. It leaves the yellow moon clear at desktop and mobile widths, with equal corner radii around the artwork. Temperature comes from the [National Weather Service observation at Pittsburgh–Allegheny County Airport](https://forecast.weather.gov/data/obhistory/KAGC.html). Flow uses the [USGS Allegheny River gauge at Natrona](https://waterdata.usgs.gov/monitoring-location/USGS-03049500/), an upstream station, displayed as cubic feet per second (ft³/s). This is river discharge, not current speed or a measurement at the boathouse. Both refresh every ten minutes while visible, and on returning to a tab when due. Missing readings and readings older than two hours show a dash. Observation times, station details and refresh failures are available on hover and to screen readers; clicking a reading opens its source. The [NWS API](https://www.weather.gov/documentation/services-web-api) and [USGS latest continuous API](https://api.waterdata.usgs.gov/docs/ogcapi/migration/) require no added key for these requests. The observations are independent of the selected practice date.

## Private examples for the supplied weeks

Real source records for weeks 1, 3, 4, and 5 are available as private Google Sheets. [Open the example index](example-files/README.md) for the online week folders and manual download/upload instructions. Each week folder contains only `members`, `attendance`, and `drivers` Sheets. Local examples contain only README links; the original files and removed Drive README/archive files are preserved in ignored private storage. Open each week’s three Sheets in Google Drive, choose **File → Download → Microsoft Excel (.xlsx)**, and select them together in the website’s **Choose Excel files** area. Only `.xlsx` is accepted. After editing the Sheets, download fresh copies and reupload. The website needs no Google sign-in or OAuth configuration. See [file preparation](docs/GOOGLE_DRIVE.md).

The sheets retain unresolved identities, attendance and missing pickup addresses. The October 2026 dates still need review. Driver Yes entries are initialized from the supplied weekly car arrangements, with five total seats per driver. Update the Yes/No grids when attendance or availability changes. Unanswered attendance is filled with No. A real schedule requires resolving the remaining data and collecting current availability. Original technical data and review evidence remain in hidden archive tabs; the website imports only the visible simple tables.

## Private legacy import

All four supplied workbooks were found at the repository root. They are ignored, unchanged and not tracked. The local import confirmed 63 roster records, 14 daily sheets, 29 normalized Rowers labels, and all the specified per-day counts. The complete private output is at **`data/private/normalized/`**, including `REVIEW.md`, `review-report.json`, draft members, staged attendance, assignment/pickup evidence, and alias/date templates. No birthdays, phone numbers or Andrew IDs were copied into these artifacts.

```bash
# Supplied workbooks currently at repository root:
npm run import:legacy -- --input-dir . --output-dir data/private/normalized

# Or put originals in an ignored directory:
npm run import:legacy -- --input-dir data/private/raw --output-dir data/private/normalized

# After manually reviewing exact-label aliases and calendar dates:
npm run import:legacy -- --input-dir data/private/raw \
  --output-dir data/private/reviewed-draft \
  --aliases data/private/approved-aliases.json \
  --dates data/private/reviewed-dates.json
```

Aliases are a JSON object mapping exact historical labels to roster `member_id`s. Dates are an object mapping `Workbook.xlsx::Sheet name` to `YYYY-MM-DD`; the importer validates weekday agreement. Missing workbooks are reported without stopping synthetic development. Output paths must remain under `data/private/`.

**These are drafts, not operational files.** Forty-three distinct labels across all historical lists/groups remain provisional pending review; this is not a count of new people. Abbreviations and nickname/typo suggestions never authorize a merge. The Saturday layout around D9:F13 is explicitly unresolved and preserved with cell references. Assignment-only attendance candidates, driver-list disagreements, conflicting pickup descriptions and old ownership flags remain review evidence. All historical attendance is staged as unknown until confirmed. No factual current availability file is invented.

Review identities, choose confirmed pickup defaults/overrides, map practice dates, resolve attendance/transport discrepancies, and collect current driver availability before producing the three operational CSVs. See [legacy import behavior](docs/LEGACY.md).

## Availability simulations

Offline simulation tools are available through the CLI for development; they are not exposed in the website:

```bash
npm run scenario -- --kind mixed --seed 42 --output-dir exports/private/demo
npm run scenario -- --kind rotating --people 30 --drivers 8 --seed 9
npm run scenario -- --kind zero
npm run scenario -- --kind insufficient
npm run scenario -- --kind cancellation --cancel-driver demo-001
```

Kinds: `broad`, `rotating`, `mixed`, `insufficient`, `zero`, `cancellation`. Cancellation preserves other availability/capacities and cancels the chosen driver across the supplied week. The UI cancellation selector uses previously selected drivers.

For source-based hypothetical schedules, first finish identity, attendance and date review, then supply an explicit candidate pool:

```bash
npm run scenario -- --input-dir data/private/operational \
  --output-dir data/private/scenario --kind broad --seed 42 \
  --candidates m-reviewed-id-1,m-reviewed-id-2

npm run scenario -- --input-dir data/private/operational \
  --output-dir data/private/observed-simulation --kind observed --seed 42 \
  --candidates m-reviewed-id-1,m-reviewed-id-2 \
  --reviewed-observed data/private/reviewed-observed-drivers.json
```

The observed file maps actual calendar dates to arrays of reviewed assigned-driver IDs. It restricts **hypothetical** availability; it is not reconstructed ground truth. The input directory contains all three canonical CSVs. Output includes those same three files plus `scenario.json` recording seed/configuration. Preserve that sidecar with externally generated simulations: ordinary CSVs do not encode scenario history. Internal plan metadata records the optimizer seed and scenario configuration for scenarios generated within that tab. Old car-ownership flags never select the pool automatically.

## Tests, benchmarks, and privacy audit

```bash
npm test                    # domain/import/provider/export tests
npm run build               # TypeScript check + Vite production bundle
npx playwright install chromium
npm run test:browser         # browser workflows against production subpath
npm run benchmark           # Node benchmarks; writes docs/benchmark-node.json
npm run audit:private       # tracked/public files + production assets
npm run estimate:routing -- members.xlsx attendance.xlsx drivers.xlsx # offline usage estimate
```

On this machine, tests used the existing Google Chrome installation:

```bash
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/google-chrome npm run test:browser
```

The browser suite uses America/Los_Angeles while checking New York output. It tests XLSX-only validation, Excel templates, automatic file detection, combined workbooks, duplicate rejection, single-file replacements, TomTom planning/replanning, route expansion, cancellation, API/quota failures, and mobile layout. TomTom HTTP responses are controlled fixtures: no live billing or traffic accuracy is claimed. Its build uses a fictitious key in a separate ignored output directory, leaving the production bundle and local key unchanged. Unit tests still exercise offline planner scenarios and export utilities.

Earlier measurements on an Intel Core i9-12900HK (20 logical CPUs), Linux, Chrome 151.0.7922.173 (before removing the export controls):

| Synthetic week                           | Browser Worker search | Browser click-to-export test wall time | Result   |
| ---------------------------------------- | --------------------: | -------------------------------------: | -------- |
| 30 people / 8 eligible drivers / 5 days  |                1.01 s |                                 1.54 s | Feasible |
| 60 people / 12 eligible drivers / 5 days |                0.05 s |                                 0.58 s | Feasible |

The larger case is easier here because 60 people require all twelve five-seat cars, leaving only one feasible driver set. These are individual measurements, not performance promises. Historical offline click-to-result measurements: [browser](docs/benchmark-browser.json). Search diagnostics: [Node](docs/benchmark-node.json). Search defaults: 64 subsets/day, 80,000 route-order evaluations/day, 96 weekly beam states. Runtime is recorded separately from the deterministic operation budget. See [planner details](docs/PLANNER.md).

The audit checks source identifiers against public text/build files when private sources are available, checks ignored/tracked paths, and rejects credential-like values. It is an additional check, not a substitute for reviewing what is staged. There are no commits yet; all implementation files and the lockfile remain in the working tree.

## TomTom and deployment

Follow [free TomTom setup and verification](docs/TOMTOM.md). The owner supplies a domain/product-restricted public browser key; crew members need no service login. The free allowance is finite. Planning stops on quota failures without retries or a paid fallback. The account must remain free of purchased credits/paid billing to enforce zero spending.

The [validation workflow](.github/workflows/checks.yml) runs tests, browser workflows, build checks and the privacy audit. Use [Cloudflare Pages with private Google Drive storage](docs/CLOUD_HOSTING.md) for the free-tier cloud deployment, or deploy the Node server with HTTPS and persistent storage using [these instructions](docs/ACCESS.md). Static GitHub Pages alone cannot enforce the shared-key access system. Cloud setup must pass account authorization and live verification before it is ready to use.

Deferred: return rides, individual accounts, historical multiweek fairness, assignment locks and change-minimizing replanning. Signup Sheets are downloaded manually; the optional cloud backend uses private Drive storage for saved inputs and publications. The website accepts simple name-based and older canonical tables inside .xlsx files; the original historical car-assignment layouts still use the separate review/import workflow. Excel reading uses the installed SheetJS 0.20.3 package locally in a worker.

## Initial release tutorial

See the v0.1.0 user tutorial ([PDF](docs/TUTORIAL.pdf), [Markdown](docs/TUTORIAL.md)) for Excel preparation, admin planning and publishing, and team access. Local release kits with real Week 3 examples live in the ignored `data/private/releases/v0.1.0/` directory and must remain private.
