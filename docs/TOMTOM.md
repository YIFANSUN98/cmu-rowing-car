# Free TomTom routing setup

The website now uses TomTom for travel estimates. Admins select their three downloaded `.xlsx` files together and click **Plan week**. They do not need a Google, TomTom, or ChatGPT account. The site owner supplies one restricted TomTom browser API key.

## One-time setup

1. Create a free account at [MyTomTom](https://my.tomtom.com/). Leave it on the free allowance: do not add payment details, purchase credits, or enable a paid plan.
2. Open [API & SDK Keys](https://my.tomtom.com/keys) and copy **My first API key**, which TomTom normally creates automatically. A separate planner key also works. Check that the key has **Geocoding**, **Routing** (including Batch Routing), and **Map Display** access. This adapter uses the TomTom Maps endpoints, not the Orbis variants. Use [key management](https://docs.tomtom.com/platform/documentation/my-tomtom/api-key-management) to restrict products and whitelist the development and published website domains. Use a separate development key when practical.
3. Put this line in the ignored `.env.local` file at the project root:

   ```dotenv
   VITE_TOMTOM_API_KEY=your_key_here
   ```

4. Restart `npm run dev`, or rebuild the production site. Open [the local planner](http://127.0.0.1:5173/cmu-rowing-car/).

`VITE_` values are embedded in the browser bundle. This key is public to site visitors, so its domain/product restrictions matter. Keep its source out of version control and chat. The app sends addresses/coordinates, departure times and stop durations, never member names or spreadsheet contents. Location results are cached only in this tab; closing/reloading the tab clears them. The app does not contact Google for estimates. Clicking an existing Google Maps navigation link opens Google Maps separately; Google may choose different roads from the TomTom estimate.

## Staying at zero cost

As checked on 2026-09-24, TomTom lists **20,000 Routing requests**, **20,000 Geocoding requests**, and **200,000 raster map tiles per month**, without a credit card. These are finite allowances. See [current pricing](https://docs.tomtom.com/pricing).

The planner builds its directed travel matrix using ordinary Calculate Route requests, sent through [synchronous Batch Routing](https://docs.tomtom.com/routing-api/documentation/tomtom-maps/v1/batch-routing/synchronous-batch) in groups of at most 100. Each origin-to-destination pair uses one Routing request; batching does not turn the whole batch into one billable route. Identical coordinates use a zero-distance edge without a request. A complete 20-location matrix would use 20 × 19 = 380 Routing requests and **zero Matrix API units**. The separate Matrix API allowance is no longer required. The website skips pairs that cannot occur in any feasible carpool: origins outside possible driver starts and passenger pickups, and destinations outside possible passenger pickups and the boathouse. A driver is excluded from possible passengers only when removing that driver would leave insufficient total seats. Shared locations remain included whenever another passenger needs them. This reduces requests without removing feasible routes; omitted edges are unavailable, never zero-cost shortcuts.

The app stops on quota and access failures. It recognizes both HTTP 429 and HTTP 403 with `InsufficientFunds` as allowance failures, including failures inside an otherwise successful batch. It does not retry failed calls automatically, upgrade the account, buy credits, or switch providers. **The free account configuration enforces the spending boundary**; the browser cannot inspect your account balance or guarantee zero charges if the owner later purchases credits or enables paid billing.

Only one organizer needs to calculate the week. Completed batches, matrices, and routes are reused for ten minutes in the current tab; geocodes are reused for that tab's lifetime. Completed batches remain reusable after a later batch is cancelled. Changing the departure context, refreshing the page, or waiting beyond that cache window requires fresh requests. Quotas are account-wide; the in-memory usage record is not a monthly account meter.

Each selected car evaluates at most 24 complete pickup orders. A request asks for the fastest route and up to two alternative roads; the existing time/distance cost chooses among feasible alternatives. At most two additional requests move the chosen order earlier if needed. The search itself runs locally and makes no API calls. Complete-route checks across the selected week are now also sent in batches of at most 100, preserving every pickup permutation, road alternative, dated departure and boarding pause. Late winners are grouped into another timed pass. Batching reduces sequential HTTP round trips; each route item still consumes the Routing allowance.

## Expanded route maps

**Show route** loads a Leaflet map with TomTom raster tiles, driver/pickup/boathouse markers and the road shape from the exact alternative selected during verification. Pickup numbers match the timeline. Co-located stops share one labelled marker. The stop buttons focus any pickup, including markers that overlap in the overview. Fit route restores the view; the mouse wheel zooms in and out while the pointer is over the map. Tiles are requested only for expanded maps; they use the separate Map Display allowance. Opening a map makes no new Routing calls. Missing geometry is labelled as stop locations only, without inventing a road line.

Member names appear locally in marker popups and are never included in tile or routing requests. Map tiles identify the displayed geographic area. Tile images can use the browser's ordinary HTTP cache; published plan data is stored privately on the app server and requires the team or admin key to retrieve. No additional account, key, paid plan or billing change is needed with the current key, whose Map Display access was verified on September 24.

## Estimating usage

For each day with N distinct pickup/destination coordinates, budget N × (N − 1) Routing requests for the matrix, plus the complete-route checks below. An ordinary week with 15 locations on five days uses 1,050 requests for its matrices. Repeated planning and usage by other people share the same monthly allowance.

To estimate another week's files locally:

```bash
npm run estimate:routing -- /path/to/members.xlsx /path/to/attendance.xlsx /path/to/drivers.xlsx
# A single combined workbook is also accepted.
```

This command makes no network calls and outputs counts without names or addresses. Its conservative Routing upper bound includes all matrix pairs before the safe exclusions above, plus complete-route checks. The plan's internal `travelUsage.routingRequests` counts Routing batch items plus individual route requests (map tiles are separate); the legacy Matrix counters remain zero. Failed attempts may be counted; this is not an invoice. HTTP calls are paced at up to four per second in each tab, with an additional 1.25-second pause after a completed batch so the shared Routing rate window can clear. Another user sharing the key can still cause a rate-limit error.

## Timing and verification

Dates and times use America/New_York. Matrices request live traffic with the selected future practice date. Complete-route checks use each car's planned departure, fixed pickup order, and boarding pauses. Far-future results are forecasts based on traffic patterns, not observations of traffic that has not happened yet. Replan nearer practice if updated conditions are needed.

Full-route timestamps are checked for consistency and boarding is counted once. The independent checker verifies every rider, seat capacity, pickup readiness, earliest departure, maximum duration, and buffered arrival. Failed rechecks leave an incomplete day without a falsely valid route. Driver assignments still come from the bounded matrix-based optimizer; complete-route checking does not exhaustively reassign every rider/driver or prove a globally optimal weekly solution. Pickup orders are compared at the initial departure; earlier-departure retries check the chosen order only.

Automated tests use synthetic HTTP responses and a fictitious key. They cover directed batch ordering, the 100-item limit, zero-length edges, cancellation and reuse, quota failures within batches, malformed results, and complete-route timing. Browser tests cover upload, planning, expansion, stale results and failure handling.

On 2026-09-23, a live browser check found that Geocoding and Routing worked while Matrix Routing returned HTTP 403 with `InsufficientFunds`. Synchronous Batch Routing succeeded with the same existing key. The adapter now uses that documented Routing endpoint directly. No keys, billing settings or account products were changed. Private live verification artifacts are under `data/private/allweeks-repair/`.

## September 24 performance check

With the current Week 3 sheets, a fresh live browser plan verified all five days in **186.87 seconds**. It used 17 geocodes, 692 matrix-pair Routing items in 10 batches, and 192 complete-route checks in 3 batches (884 Routing items total). Expanding the map loaded six visible tiles, with no additional Routing calls or service errors. The previous implementation's recorded run used 886 matrix items and 192 separate complete-route HTTP calls. A same-session intermediate run with batching but before matrix exclusions took 223.31 seconds; this is not a timed benchmark of the original implementation. Live timings vary with the service and network.

The remaining cold-plan delay is predominantly online route processing: batches of 100 matrix items took around 20 seconds in this account's observed runs. Batching preserves the candidate search and reduces round trips; excluding impossible pairs reduces both work and quota use. Identical replans reuse ten-minute in-tab caches. Production-build browser tests verify that an unchanged repeat makes no new routing/geocoding calls and opening a map does not reroute. Vite prebundles the lazy Leaflet dependency at startup so first expansion cannot trigger a dependency-discovery page reload.

Private live results and recorded-response visual checks are under `data/private/route-map/`; replay timings are not live performance measurements. Map tiles in the visual checks are live.

## Hosting with team access

The shared-key version needs a Node server, HTTPS and persistent private storage. GitHub Pages alone is insufficient. See [access and deployment](ACCESS.md). The owner configures one restricted public TomTom browser key at build time; admin/team access keys are separately stored as server-side hashes and must never be put in `VITE_` variables.
