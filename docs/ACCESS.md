# Admin and team access

One website, two shared keys, no individual accounts or account database:

| Key                | Access                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------- |
| Admin              | Upload and retrieve the original Excel files, calculate routes, publish/unpublish the plan, change either key |
| Drivers and rowers | View the latest published plan, expand maps and pickup instructions, download the plan Excel                  |

The server checks authorization for every API request. Hiding controls is only a convenience. Keys never appear in frontend code, `VITE_` variables, URLs or localStorage. The public JavaScript and branding do not contain private team data. Admin workbooks and the published plan are stored outside the public build directory.

## Local setup

Use Node 24 or later. From the repository root:

```bash
npm ci
npm run access:init
npm run server
```

In a second terminal, run `npm run dev` and open **http://127.0.0.1:5173/cmu-rowing-car/**. The API listens only on `127.0.0.1:5174`; Vite proxies same-origin API requests. The initializer prints the path to the private `data/private/server/access-keys.txt` file, not the keys. Open it locally to read or edit the two keys. Initialization refuses to replace existing credentials.

On the current development machine, the API and Vite are also installed as user services:

```bash
systemctl --user restart cmu-rowing-car-api.service cmu-rowing-car-dev.service
systemctl --user status cmu-rowing-car-api.service cmu-rowing-car-dev.service
```

These are local development services; they are not public hosting and run while the user's service manager is active.

## Planning and publishing

1. Sign in with the admin key and upload the three `.xlsx` inputs together.
2. **Plan week** saves the current Excel originals privately, then calculates and checks the routes. **Private Excel files** also lets an admin save, download or load the last saved inputs without planning. Partial file replacements and combined workbooks are preserved correctly.
3. Review the result and click **Publish to team**. Incomplete, stale, hypothetical or unchecked plans cannot be published from the planner. Replanning or changing inputs does not automatically replace the published plan.
4. Share the same website address and the **team key** with drivers and rowers. The top buttons switch between **Plan the route**, **View published plan** and **Manage access**. Only the selected page is shown; planner inputs and results stay available when you return. **View published plan** opens a fresh copy of the team view. **Unpublish plan** removes it from the team view.

Only the most recently published week and most recently saved input set are retained. Team responses contain selected driver/rider names, route addresses, coordinates, road paths, times and capacity. They omit unused members, input workbooks, attendance/availability grids, internal member IDs, notes and travel matrices. Published route addresses are visible to everyone with the team key. Members can copy or download what they can view.

The published plan loads automatically when opening its page or reloading the website. It also refreshes every 30 seconds while visible and on returning to the browser tab. There is no separate refresh button; the published timestamp remains visible for synchronization. A publication replaces the previous result as a whole. The published map and Excel use the saved verified routes, without recalculating them or making new routing calls.

## Change a leaked key online

Sign in as admin, select **Manage access**, choose **Drivers and rowers** or **Admin**, and enter the current admin key and the new key twice. Use at least 8 characters; the two roles must have different keys. Share the replacement team key through your usual private team channel.

The server immediately rejects sessions issued under the changed key. Open pages clear at their next session check (within 30 seconds while visible, or on returning to the tab). Changing the admin key signs you out too. It does not change the team key, or vice versa. Previously copied/downloaded information cannot be recalled. Shared keys do not identify individual people or let you revoke just one person.

## Change a key locally / recover access

Open **`data/private/server/access-keys.txt`** in a text editor. It contains these two fields, with your private values after the colons:

```text
Admin:
Team:
```

Enter the key you want after either label and save. Use 8–256 characters, different for each role. Leave a value blank to keep its current key. Keep both labels; comments can start with `#`. Surrounding spaces are trimmed. Save as plain UTF-8 text.

The next website request applies edited values automatically, including at server startup. Refresh the website and sign in with the new key. No restart, rebuild, or publication is needed. Changing one role revokes only that role's existing sessions. Unchanged values and formatting changes do not sign anyone out. Saved spreadsheets and the published plan are preserved.

An invalid or incomplete file leaves the last valid keys active and logs an error without the key values. To validate/apply the file immediately and see any error locally, run:

```bash
npm run access:apply
```

Online changes through **Manage access** and generated CLI replacements remain supported. A value already applied from the text file is ignored until you edit it, so an older value in the file cannot undo a newer online change. The file is an input for changes, not a guaranteed record of the latest online keys. You may clear its values or delete it after storing the keys privately; doing so does not remove access. To reapply a previously used value after an online change, first clear that field, save and run `access:apply`, then enter the desired value and save again.

Keep this file private. The app restricts it to the local owner, excludes its directory from Git and the website, and stores only salted password hashes for active and previously applied values in `credentials.json`. Never edit `credentials.json` manually. Older `initial-access-keys.txt` and `*-replacement-key.txt` files are receipts; editing them does not change login access. For an older installation, create `access-keys.txt` with the two blank labels above in the same private directory.

To generate a random replacement instead of choosing your own, run on the machine that hosts the private server, with the same private data directory:

```bash
npm run access:rotate -- team
# Or, to replace the admin key:
npm run access:rotate -- admin
```

This generates a new strong key in a private `team-replacement-key.txt` or `admin-replacement-key.txt` file. It does not print the key. Read and store it, then delete that file. The server reads credential versions for each request, so no restart or rebuild is needed. The original initialization key file is removed after CLI rotation because it contains outdated keys; save both original keys before rotating.

For a remote host, edit `access-keys.txt` in that server's `PRIVATE_DATA_DIR`, privately transfer your edited file there, run the command there, or use **Manage access**. Editing only this computer's copy or redeploying frontend files alone does **not** change the remote website's passwords. Never put a plaintext key file in the website bundle or repository.

## Public hosting

The two-key version needs a Node server, HTTPS and a persistent private directory. A static GitHub Pages deployment alone cannot run it. The previous Pages deployment workflow has been replaced with validation checks so it will not publish a nonfunctional static-only login. A temporary phone preview is available as described below; permanent hosting has not been configured.

On the chosen server, install Node 24+, copy the source/build files, and configure these server environment variables (not `VITE_` variables):

```dotenv
APP_ORIGIN=https://your-club-domain.example
HOST=127.0.0.1
PORT=5174
PRIVATE_DATA_DIR=/srv/cmu-rowing/private
STATIC_DIR=/srv/cmu-rowing/app/dist
```

Run `npm ci`, configure the restricted public `VITE_TOMTOM_API_KEY`, and run `npm run build`. With the server environment loaded, run `npm run access:init` once, then `npm start` under your hosting provider's process supervisor. `APP_ORIGIN` is the exact scheme and hostname (plus port if nonstandard), without a path or trailing slash. The site is served at `/cmu-rowing-car/`.

Put an HTTPS reverse proxy in front of the Node server, preserving the original Host header. Proxy the whole website to it, including `/cmu-rowing-car/api/`. Permit request bodies up to 22 MiB. Bind Node to loopback unless your host requires otherwise. The app deliberately ignores forwarded IP headers; with a proxy its built-in login limit is shared across visitors, so also configure client-IP rate limits at the proxy. Do not cache API responses or login pages. Restrict the TomTom browser key to the new website domain.

Keep the private directory on a persistent volume outside `dist/`, with access limited to the service user. It contains salted scrypt password hashes, a session-signing secret, revoked sessions, saved originals, and the published plan. Source uploads can contain hidden worksheet data; those full originals are admin-only. Back up this directory privately. Deploy updates without replacing or clearing it. The app uses atomic file replacement and is intended for a single server process, not distributed serverless instances.

Server sessions use signed HttpOnly, SameSite=Strict cookies (Secure on HTTPS), expire after 12 hours for admins or 7 days for the team, and are revoked on logout or a matching key change. Mutations require same-origin requests and a session-bound CSRF token. Failed key attempts are rate limited. Passwords use scrypt with a unique salt, N=32768, r=8, p=3. There is no account database, analytics, messaging or browser storage of access keys. HTTPS is required except for explicit localhost development.

The software adds no paid service or database subscription. Hosting availability and cost depend on the server you choose; the local development link is accessible only on this computer.

## Temporary phone preview

The development computer can serve the production build through a free [Cloudflare Quick Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/). The current URL is recorded in ignored `data/private/phone-preview.json`. Open that HTTPS URL on the phone and use the existing admin or team key. It uses the same private key file, saved inputs, and published plan as the local website. Changes made through either address affect that same data.

The preview serves `dist/` through a separate Node listener on loopback port 5175. Its exact HTTPS origin is configured as `APP_ORIGIN`, so Host checks, same-origin requests, CSRF checks, and Secure/HttpOnly cookies remain enforced. The tunnel does not expose the Vite development server or project directory. TomTom geocoding and routing were checked from the public origin.

The two transient user services keep the preview running after the terminal closes:

```bash
systemctl --user status cmu-rowing-car-phone-web.service cmu-rowing-car-phone-tunnel.service
```

To take the preview offline without stopping the ordinary local website:

```bash
systemctl --user stop cmu-rowing-car-phone-tunnel.service cmu-rowing-car-phone-web.service
```

This preview requires the computer and its internet connection to stay on. It does not automatically survive a computer restart. Starting a new Quick Tunnel changes its hostname, so the preview server's `APP_ORIGIN`, the saved preview URL, and any TomTom website restrictions must match the new address. Rebuild with `npm run build` to update frontend assets. For permanent hosting, use [the Cloudflare and private Drive setup](CLOUD_HOSTING.md), or one supervised Node server with persistent storage.
