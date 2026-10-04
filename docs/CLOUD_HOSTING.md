# Cloudflare Pages + private Google Drive

Production website: **https://cmu-rowing.pages.dev/**. It uses the existing admin/team keys and the private Apps Script deployment recorded in ignored `data/private/cloud/deployment.json`. Deploy frontend updates with `npm run cloud:deploy`; apply local key changes with `npm run cloud:sync-keys`.

The cloud build serves the website at `/` on a project address such as `https://cmu-rowing.pages.dev` (availability must be checked). It does not require a personal account name or `/cmu-rowing-car/` in the URL. No cloud account database is required.

Cloudflare serves the public application and a same-origin API gateway. Apps Script runs as the storage owner and checks the admin/team keys. Uploaded `.xlsx` files and the published plan live in an owner-only Google Drive folder. Do not share that backend folder with the team: team members see the plan through the website.

## Account setup

1. Run `npx wrangler login` and approve the Cloudflare authorization. Choose the free plan; do not enable paid Workers or add paid services for this setup.
2. Run `npx clasp login`, choose the Google account that will own storage, and grant Apps Script project/deployment and app-created Drive file permissions. Enable the Apps Script API at <https://script.google.com/home/usersettings>. A Workspace administrator may disallow anonymous web apps; a personal Gmail account can be used instead.
3. Create an owner-only Drive folder in that same account. Record its ID, then run:

   ```bash
   npm run cloud:prepare -- --folder YOUR_PRIVATE_FOLDER_ID
   npm run cloud:build
   ```

   Setup files, salted password hashes, and the server-to-server secret go only in ignored `data/private/cloud/`. Never upload this directory to Pages or GitHub. The public build is **only** `dist-cloud/`.

4. Create a standalone Apps Script project and use `clasp` with its root directory set to `data/private/cloud/apps-script`. Push `Code.js`, `Setup.js`, and `appsscript.json`. Run **setup** once in the Apps Script editor, accepting its Drive permission. This step requires the owner; rowers do not authorize Google. Setup refuses a folder shared with other users and does not overwrite existing keys.
5. Deploy the script as a web app, **Execute as: Me; Who has access: Anyone**. This makes the endpoint callable, but every request still needs the private Cloudflare signature and the user's authenticated session. Direct GET requests return no plan or files. Copy the deployed `/exec` URL:

   ```bash
   npm run cloud:configure -- --apps-script-url https://script.google.com/macros/s/DEPLOYMENT_ID/exec
   npm run cloud:check
   ```

6. Create the Pages project and install backend secrets (the file is passed directly; secrets are not printed):

   ```bash
   npx wrangler pages project create cmu-rowing --production-branch main
   npx wrangler pages secret bulk data/private/cloud/pages-secrets.json --project-name cmu-rowing
   npm run cloud:deploy
   ```

   If that project address is unavailable, choose a different project, update `wrangler.jsonc` and the `cloud:deploy` project argument, then run `cloud:configure -- --origin https://YOUR_PROJECT.pages.dev` and install the secrets again. The gateway accepts only its configured production origin; preview deployments cannot access production data.

7. Run `npm run cloud:migrate` to copy the current saved Excel files and published plan. Existing cloud data is preserved. Importing a plan republishes it and gives it the import time; it does not silently import unreviewed drafts. Keep the local files until live verification is complete.
8. Verify admin/team sign-ins, team denial of `/api/inputs`, upload/download, manual planning, publish/unpublish, and password resets at the live address. Add the new origin to the TomTom key's allowed websites if needed and verify live routing. Check the Google and Cloudflare quota dashboards.

Do not stop the temporary preview until the permanent deployment passes these checks.

### If Google CLI authorization grants only profile access

Use the Google editor directly rather than repeating CLI consent. Set `folderId` to an empty string in the private deployment settings, then run `cloud:prepare` and `cloud:build`. The resulting **private** `data/private/cloud/Install.gs` combines the complete backend and bootstrap configuration. It contains backend secrets; do not publish it or share the Apps Script project.

In the intended Google account, create a standalone project at <https://script.google.com/home/start>, replace `Code.gs` with `Install.gs`, save, and run `setup`. This creates an owner-only storage folder and prints its actual URL in the execution log. Deploy as a web app executing as yourself with access set to Anyone. Continue from step 5 with that deployment's `/exec` URL. The endpoint still requires the private signature; choosing Anyone does not share the Drive folder or expose the plan.

## Changing keys later

The admin's **Manage access** page changes cloud keys online immediately. The minimum is eight characters. Sessions for the changed role are revoked; the other role stays signed in.

For a local change, edit `data/private/server/access-keys.txt` and run:

```bash
npm run cloud:sync-keys
```

The cloud cannot watch a file on this computer. The explicit sync sends only changed salted hashes over the signed backend connection. Re-running sync with an unchanged file preserves a newer online password reset. `initial-access-keys.txt` remains a receipt, not an automatically applied settings file. Website rebuilds do not reset keys.

For backend code updates, build, push with `clasp`, and update the existing Apps Script deployment to a new version so the `/exec` URL remains unchanged. Then deploy the website build. Keep local cloud configuration files private and backed up: they are needed for deployment and key recovery.

## Performance and cache behavior

The browser keeps the last published plan in memory while it authenticates and checks for a newer publication. Every navigation back to the plan and every visible 30-second refresh still contacts the API; a transient 503 receives one retry after 750 ms; read-only bridge calls have an eight-second deadline across redirects so a hung Google request does not block the page for tens of seconds; unchanged publications return only a version confirmation. Admin/team login and initial session checks can include the publication to avoid a second round trip. With `SESSION_SIGNING_SECRET` configured, the Cloudflare gateway starts older backends with one authenticated plan read, then derives the matching session role and CSRF value. The backend still checks credential versions, expiry, revocations, and storage privacy on every read. A signing-key mismatch falls back to a backend session read. Without that secret, the gateway starts session and plan reads in parallel. After upgrading, set the Pages variable `COMBINED_PLAN_STARTUP=1` to use the backend’s single combined response and reduce Google executions. Signing out or changing sessions clears this memory. There is no persistent browser cache of private plans or Excel files.

The closed private-files panel makes no requests. Opening it fetches filenames and dates only; loading saved inputs fetches workbook contents. Planning saves files concurrently with travel preparation, assignment solving, and final route verification; results become ready once verification and saving both succeed, and unchanged inputs already saved or restored in the current session skip another upload. The explicit Save Excel files button always saves, including when another admin may have replaced the remote files.

Apps Script reads properties in one operation. Read-only requests do not acquire the writer lock; writes, password changes, replay protection, and login throttles remain serialized. Immutable Drive JSON files are cached compressed for up to six hours, keyed by file ID, and writes warm the cache so the first viewer avoids downloading the new JSON from Drive. Larger compressed plans use ordered cache chunks; missing chunks fall back to the complete Drive file. Publish/unpublish switches the authoritative pointer, so this cache does not delay a website update. Credentials and revocations are never cached, and Drive privacy checks still run before reading stored data. Cache eviction falls back to Drive.

Routing caches stay in the planner tab. Directed legs are reused across attendance edits only for the same departure timestamp and expire after ten minutes; rebuilding a matrix does not extend the lifetime of older estimates. Pickup geocoding runs with at most three requests in flight and starts requests at least 250 ms apart. Routing batches retain their existing rate-limit pauses. Complete route responses use TomTom's encoded polyline representation, decoded without changing pickup order, times, distances, or road geometry. The map module preloads while authentication is in flight, and the page preconnects to TomTom.

After a backend performance update, replace the existing editor's Code.gs with the newly built private Install.gs, then use Manage deployments → Edit → New version → Deploy. Do not rerun setup or create a second storage folder. Frontend changes remain compatible with the previous backend while this update is pending.

## Access controls and limits

- HttpOnly, Secure, SameSite cookies; CSRF protection; exact production origin checks. The browser never receives the Drive bridge secret or Drive OAuth credentials.
- The existing scrypt parameters are preserved (`N=32768, r=8, p=3`), executed in Apps Script. Cloudflare's free CPU budget is not used for password hashing. Sign-in may take several seconds.
- Published plans pass the same allowlist validator as the Node server. Team sessions cannot retrieve original Excel inputs.
- Apps Script locks serialize changes. Uploads write a new complete file set before committing a pointer; failures preserve the previous set. Replaced app files go to Drive Trash, which counts against storage until emptied. Unrelated Drive files are untouched.
- The Apps Script reply travels as inert encoded text through HtmlService; the Cloudflare gateway decodes it into the JSON API response without rendering or executing HTML. This avoids the intermittent anonymous POST redirect failures observed with ContentService. The gateway also accepts the older JSON response during upgrades and only follows bounded redirects to Google’s response host. It never repeats a signed write to recover a response.
- Signatures have a two-minute validity window. Writes reject replayed requests. Login throttles, logout revocations, and role versions persist across executions; they do not depend on an evictable cache.
- Free services have quotas, not an unlimited-service guarantee. Google account storage is shared with its other files. Apps Script has execution/concurrency limits and Cloudflare Functions have free request/CPU limits; large uploads or heavy team traffic need monitoring. Quota exhaustion fails closed and must not publish private Drive links as a fallback.

Official documentation: [Pages Functions](https://developers.cloudflare.com/pages/functions/), [Pages pricing](https://developers.cloudflare.com/pages/functions/pricing/), [Apps Script web apps](https://developers.google.com/apps-script/guides/web), [Content Service redirects](https://developers.google.com/apps-script/guides/content), [Apps Script quotas](https://developers.google.com/apps-script/guides/services/quotas).
