> Legacy developer adapter. The website now uses [TomTom](TOMTOM.md); Google API billing and keys are not required for the website.

# Google Maps browser routing

**Verification status:** implemented and checked against the official browser API references on 2026-09-18; tested with a mocked SDK; **not exercised against the live Google service**. The user supplied the boathouse address; a real browser key and reviewed scheduling data are still required for live verification.

## Configure

1. Create/use a Google Cloud project with billing. Enable the Maps JavaScript API, Routes API and Geocoding API needed by the browser routing/geocoding workflow. Review current project-specific quotas and feature availability in the console. The adapter uses the documented `Route` and `RouteMatrix` browser classes, loaded through `@googlemaps/js-api-loader` only after a deliberate calculation action. See [Routes library overview](https://developers.google.com/maps/documentation/javascript/routes/overview).
2. Create a **browser API key** with website/HTTP-referrer restrictions for your exact localhost and Pages origins (for example, `http://127.0.0.1:5173/*`, `http://127.0.0.1:4173/*`, and your `https://…github.io/*` site). Restrict APIs to those used by this application, and use separate development/production keys if appropriate. Follow [Google's key-security guidance](https://developers.google.com/maps/api-security-best-practices).
3. Copy `.env.example` to `.env.local`, set `VITE_GOOGLE_MAPS_API_KEY`, and restart Vite/rebuild. Every `VITE_` value is public in the browser bundle. **Never use a service-account credential, private key, or server secret.** For Pages, the optional `GOOGLE_MAPS_BROWSER_KEY` repository variable is passed at build time.
4. In the app, upload reviewed `.xlsx` inputs and select future practice dates. The destination defaults to `300 Waterfront Dr, Pittsburgh, PA 15222`. Use **Plan week**; Google Maps is always selected. Loading the page or uploading files does not load its SDK. Self/external modes and unresolved identities still require the same input review.

The adapter deliberately has no public proxy or direct server-only REST call. It sends address/coordinate points and driving/time settings, never names, member IDs, birthdays, attendance arrays or ownership evidence. Its location type contains no membership fields. Location resolution rejects multiple/partial geocoding matches for human review.

## Requests, units, costs and failures

`RouteMatrix.computeRouteMatrix()` returns `{ matrix }`, whose `rows[].items[]` have `durationMillis`, `distanceMeters`, condition and possible errors. The boundary explicitly rounds milliseconds up to seconds and treats missing/error/fallback results as unreachable. Requests use `TRAFFIC_AWARE_OPTIMAL`, explicit future New York early-morning departure instants and minimal fields. Batches are at most 10×10 (100 elements), within the documented optimal-traffic limit. See the [matrix reference](https://developers.google.com/maps/documentation/javascript/reference/route-matrix).

`Route.computeRoutes()` rechecks each selected leg separately at its proposed departure, advancing time by each travel duration and pickup service interval. Up to three route timing passes can advance departure; any remaining constraint failure is shown as a timing failure, never replaced by mock estimates. Route response units and request methods follow the [Route reference](https://developers.google.com/maps/documentation/javascript/reference/route).

Routing is billable. Matrix billing depends on origin×destination elements; route queries, geocoding, and traffic-related features can affect charges. Default documented rate limits include 3,000 route queries/minute and 3,000 matrix elements/minute; this adapter paces matrix batches at about 2,400 elements/minute per tab. Other tabs/apps sharing the project still consume quota. Configure hard quotas and budget alerts; do not treat alerts as spending caps. Consult the current [Routes usage and billing page](https://developers.google.com/maps/documentation/routes/usage-and-billing) and Cloud console before enabling real calculations. A complete weekly matrix can require many billable elements even for a small crew.

Network/transient/quota errors receive at most two retries after the initial request (0.8/1.6-second backoff). Authentication/invalid requests fail directly; each request has a 20-second UI timeout. Cancellation stops future work and ignores late SDK responses; requests already submitted may complete and be billed. Google's network implementation may also have its own behavior. No silent straight-line fallback is used.

Matrices are reused in memory for at most ten minutes with exact location/date/departure keys. Geocoded locations remain only in the current tab session. There is no persistent provider cache. The result page has no bulk export controls. Copying route instructions is an explicit action. See [Maps policies and attribution](https://developers.google.com/maps/documentation/javascript/policies). The app includes a privacy notice and terms page, with Google Maps attribution adjacent to live route estimates. No map tiles are loaded.

## Live verification still required

With an authorized restricted key and reviewed destinations, exercise one small future-date calculation; verify geocoding, actual SDK field availability, quotas/billing, leg timings, route attribution and failure UI in the intended deployment origin. Check that browser-key website/API restrictions match that origin. This external verification was intentionally not claimed as completed. The automated browser suite uses controlled SDK fixtures and a fictitious key in a separate test build; it does not call the live service.

Each pickup and final destination has its own explicitly opened [Maps navigation URL](https://developers.google.com/maps/documentation/urls/get-started); the app does not rely on a many-waypoint link working on every mobile browser. Opening a navigation link shares the corresponding origin/destination with Google.
