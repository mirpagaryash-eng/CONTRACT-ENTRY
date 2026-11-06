# Hisab · worker advances

A shared advance register for a contractor and their workers. The owner records an advance, its date and payment method. Each worker has a private, read-only page that refreshes as entries change. WhatsApp can open a prepared message, or send an approved template automatically when a WhatsApp Business Platform connection is configured.

## Web app with no paid hosting plan

The Cloudflare deployment runs the full app and its shared D1 database on the **Free** plan, using a supplied HTTPS `workers.dev` address. It supports Android and iPhone browsers. See [the deployment instructions](cloudflare/README.md) and [verified Free-plan allowances](cloudflare/FREE_PLAN.md). Keep the account on Free; no billing or upgrade action is part of the deployment helper. Free quotas can stop service when reached, so this is not an unlimited or guaranteed-availability plan.

This deployment keeps WhatsApp sending manual: save the advance, open the prepared message, and tap Send. It does not enable a paid messaging API. Owner-only editing and private worker history use the shared database; they are separate from the browser-local downloadable preview.

For the Free runtime, password derivation runs in the browser over HTTPS using PBKDF2-SHA256 with 600,000 iterations. The server stores only a separately salted SHA-256 verifier of that derived proof. It never stores the proof itself. The proof is password-equivalent and is sent only to the same-origin API; it is never logged. This avoids placing a slow password derivation inside Workers Free’s small CPU allowance. Authentication and D1 workflows are tested locally; actual deployed limits and HTTPS behavior still need live verification after the hosting account is connected.

## Interactive frontend

`npm run build:preview` creates `preview-dist/hisab-interactive.html`, a single HTML file with its scripts and styles included. Open it in a modern browser to add workers, record/edit/cancel advances, switch between owner and worker views, and export CSV. It uses browser storage, with a clear preview banner; it does not create secure accounts or share records between devices. WhatsApp messages open only after an explicit click and still require tapping Send. The authenticated server application below remains separate.

The interface uses a **16px minimum** for text and controls, with larger headings and amounts. `npm run test:preview` checks the generated frontend, including persistence and mobile typography. This managed environment blocks direct file navigation in its browser, so the test serves the identical HTML from a temporary static server with no application API.

Chat attachment previews and phone document viewers can disable JavaScript even when a laptop browser runs the same file. The preview now displays browser-opening instructions when its JavaScript does not run. Touch tests cover adding workers and saving/editing advances at a 390px mobile viewport; file-viewer restrictions are outside the app's control.

For a website-uploadable frontend without local contact fixtures, build with `PREVIEW_PUBLIC=true npm run build:preview`, rename the resulting standalone HTML to `index.html`, and upload that file's folder to a static website host, for example through Netlify Drop. Sign in and complete the host's deployment flow to obtain an HTTPS address. This publishes only the interactive frontend; its records still stay in each browser. Shared worker records and automatic WhatsApp require hosting the full server below. Keep the original file/browser and export its CSV before switching, because browser-local records do not automatically move to a new website.

## Run locally

Requires **Node.js 24** and npm. From the checkout:

```sh
npm ci
cp .env.example .env
npm run dev
```

Open the frontend address printed by Vite. Create the owner account on the first visit; there is no default password. If `ADMIN_INVITE_CODE` is configured, enter that code during setup. Add a worker, their WhatsApp number and contract, then record an advance. Indian ten-digit numbers are accepted; include the country code for other countries.

Use the worker's **private link** to open their read-only view in another browser. Anyone with this link can view that worker's entries. Share it only with that worker; rotate the link if it is exposed. Links generated during local development work only where that development server is reachable. A publicly reachable HTTPS deployment is required for workers to use the app on their phones outside that machine.

```sh
npm test
npm run build
PUBLIC_BASE_URL=http://localhost:3001 npm start
```

The optional browser workflow test runs after building: `npm run test:ui`. It uses a system Chromium when available; otherwise install Playwright's browser with `npx playwright install chromium`. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to use another Chromium installation. The test uses temporary fixture data and never opens WhatsApp or sends messages.

`npm start` serves the built frontend and API together on port `3001`. The local command above overrides the `.env.example` frontend address (`5173`) so generated links and request-origin checks use the correct port. Both start commands load `.env` when it exists. Records persist in `.data/hisab.sqlite`; restarting the app does not clear them. Dates follow **Asia/Kolkata**. Amounts are stored as integer paise. Only the owner can create or edit entries; edits retain an audit history and worker pages show the updated record. Historical advances keep their original contract when a worker moves to another contract.

To correct an erroneous advance, the owner can cancel it with a required reason. It remains visible in the audit and worker history but is excluded from advance totals. Cancelled entries cannot be edited; record a new advance when needed.

## WhatsApp delivery

For account onboarding, secure field descriptions and switching the business sender later, see [WHATSAPP_SETUP.md](WHATSAPP_SETUP.md). `npm run whatsapp:check` verifies the configured sender through a read-only API request without sending messages.

**Open WhatsApp** prepares a message to the selected worker. The owner still needs to tap **Send** in WhatsApp. Opening the link does not prove the message was sent or received. This mode works without API credentials.

For automatic notifications, connect Meta's **WhatsApp Business Platform / Cloud API**. A regular WhatsApp account or the WhatsApp Business mobile app alone does not enable API sending. The sending number belongs to the connected Business Platform account; changing the owner's login/profile number does not change the WhatsApp sender.

1. Configure a WhatsApp Business Account, sending phone number and a production access token with the required permissions.
2. Create and obtain approval for a template in the configured language. Its body must use these **five text parameters in order**:

   | Parameter | Content |
   | --- | --- |
   | `{{1}}` | Worker name |
   | `{{2}}` | Advance amount, such as `INR 1,000.00` |
   | `{{3}}` | Advance date, such as `06 Nov 2026` |
   | `{{4}}` | Payment method: `Cash` or `Online` |
   | `{{5}}` | Absolute URL of the worker's private page |

   Use wording that applies to both a new record and an edited record. Example body: `Hello {{1}}, your advance record is now {{2}}, dated {{3}}. Payment method: {{4}}. View current entries: {{5}}`.
3. Enter the `WHATSAPP_*` settings from `.env.example` securely on the host. Never place access tokens in frontend code or commit `.env`.
4. Set `PUBLIC_BASE_URL` to this app's external HTTPS address. Configure Meta's webhook callback as `PUBLIC_BASE_URL` followed by `/api/whatsapp/webhook`. Set a matching verification token and the Meta app secret, then subscribe to WhatsApp message status events. The callback must be publicly reachable over HTTPS. If the host restricts outbound connections, allow HTTPS requests to **`graph.facebook.com`** through its supported network settings.
5. Record the worker's agreement to WhatsApp updates in their worker details. Automatic notifications require this consent. Test delivery with an opted-in recipient before relying on notifications.

An advance remains saved if messaging fails. Retry failed notifications from the register. **Accepted** means Meta accepted the request; **Delivered** or **Read** requires a corresponding verified webhook event. Fees, sender registration, template approval and account limits are managed by Meta. This repository does not contain a connected sender or live WhatsApp credentials.

Cancellation notifications use **Open WhatsApp**, which prepares a message with the cancellation reason. Automatic sending for cancelled entries is intentionally unavailable because a separate cancellation template has not been configured.

## Deploy with persistent storage

The app can run as one Node process behind an HTTPS reverse proxy. Set `NODE_ENV=production` to require secure session cookies. Set `TRUST_PROXY=true` only if the Node port is reachable exclusively through a trusted proxy that sets `X-Forwarded-Proto`. The proxy must preserve the app's host and forward HTTPS requests to port `3001`.

Configure a unique `ADMIN_INVITE_CODE` **before the first production startup**, and keep it private until the owner account is created. Production startup refuses to proceed without this code while no owner exists. It can be removed after the owner account has been created. Keep the database directory writable and persistent. Do not run several replicas against the same SQLite file or put it on an unreliable network filesystem.

Alternatively, build the supplied container:

```sh
docker build -t hisab .
docker volume create hisab-data
docker run --detach --name hisab --restart unless-stopped \
  --publish 127.0.0.1:3001:3001 \
  --mount type=volume,source=hisab-data,target=/app/.data \
  --env-file .env \
  --env NODE_ENV=production \
  --env PUBLIC_BASE_URL=https://advances.example.com \
  --env TRUST_PROXY=true \
  hisab
```

Replace the example domain with your own. Terminate HTTPS at a reverse proxy on the host and forward to the loopback-bound port. Do not expose the Node port directly when trusting forwarded headers. This command does not configure a domain, HTTPS certificate, reverse proxy or Meta account.

Before live use, verify owner login over HTTPS, worker isolation, advance creation/editing, backup restoration and actual WhatsApp delivery. No environment or website is automatically published by these scripts.

## Back up and restore

Use the provided SQLite backup command while the app is running; do not copy only the database file while it has active WAL writes.

```sh
npm run backup
# Optional explicit destination:
npm run backup -- /secure-backups/hisab.sqlite
# Container: the default backup remains in the mounted data volume.
docker exec hisab npm run backup
```

Backups default to timestamped files in `.data/backups`. Schedule backups and copy them to protected storage outside the app's disk. Treat them as private financial records. Test restoring a backup into a separate instance.

To restore, stop the app, move its current database and any associated `-wal`/`-shm` files to a recovery directory, place the backup at `DB_PATH`, then restart. Do not leave the old sidecar files beside the restored database. Ensure the app process owns the restored file. Restoring old data also restores the account, private links and records as they existed at backup time; rotate exposed links if necessary.

## Scope

This version handles worker records for SANJYOT and TECHNOEDGE, dated advances, cash/online labels, corrections and cancellations, private worker history, owner edit history, CSV export and WhatsApp notifications. It records payments already made; it does not transfer money. Salary, attendance, overtime and payroll reconciliation can be added once those rules are agreed. The uploaded payroll workbooks are not modified or bundled in this repository.
