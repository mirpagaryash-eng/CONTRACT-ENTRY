# Put Hisab online with no hosting bill

This version uses **Cloudflare Workers Free + D1 Free + static assets**. It stores entries in a shared database, so the owner and workers can use different phones. It does not use Google Sheets, require your laptop to remain running, buy a domain, or enable a paid add-on. It needs internet access. Keep the account on **Workers Free**; the free limits and their failure behavior are documented in [FREE_PLAN.md](FREE_PLAN.md).

WhatsApp remains free of Meta API integration fees in this version: the app prepares the message, and you tap **Send** in WhatsApp. It cannot silently send the message for you. The worker's private page shows saved entries independently of whether the message was sent. Do not confuse opening WhatsApp with confirmed delivery.

## What to connect

Create a free Cloudflare account. Complete the initial **Workers & Pages** setup and register the account's `workers.dev` subdomain if Cloudflare asks for it. Keep the plan on **Free** and do not enable paid services. The deployment helper does not register a global subdomain, change billing, or upgrade a plan.

Add these three values in the environment's **secure settings**:

| Setting | Where it comes from |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | An account-scoped Cloudflare API token with **Workers Scripts Edit** and **D1 Edit**; **Account Settings Read** may also be required to read the account's `workers.dev` subdomain. Scope it only to the selected account. Billing permissions are not needed. |
| `CLOUDFLARE_ACCOUNT_ID` | The account's 32-character hexadecimal Account ID, shown in the Cloudflare dashboard. |
| `ADMIN_INVITE_CODE` | A private, single-line setup code you choose, at least 16 characters long. You enter it once to create the owner account in the app. |

Do not paste token or setup-code values in chat. `.env.cloudflare.example` lists the setting names without values. For a private local shell, it may be copied to the ignored `.env.cloudflare` file instead; never commit that file. The owner chooses their own phone number and password during registration; the setup code is not their ongoing login password.

Restricted environments need HTTPS access to **`api.cloudflare.com`** for account/D1/Worker operations and the account's resulting **`<worker>.<subdomain>.workers.dev`** address for validation. Keep the inherited proxy and TLS verification enabled. Add required hosts through supported environment network settings, rather than bypassing the proxy.

## Check, then deploy

From the repository root, with Node.js 24 and the three settings available:

```sh
npm ci
npm run deploy:free -- --preflight
```

Preflight checks setting presence and format **without contacting Cloudflare**. It does not prove that a token is authorised. Missing or invalid required settings produce exit status `2`, show setting names, and perform no network calls.

When ready to publish the app:

```sh
npm run deploy:free
```

This is an explicit external deployment command. It builds the frontend, reads the account's registered `workers.dev` subdomain, reuses the D1 database named **`hisab-advances`** or creates it if absent, applies the additive schema, deploys the Worker/assets, and installs the owner setup code through standard input. It does not place the code in a CLI argument or configuration file. Owner registration stays blocked until this Worker secret is available.

The checked-in `wrangler.jsonc` contains a placeholder D1 ID for local development. Deployment writes the real binding and absolute paths into ignored `.data/wrangler.production.json`, leaving the checked-in configuration intact. On success, ignored `.data/deployment.json` records the public address and `verification: "not_run"`; it contains no token or setup code. Open the address and create the owner account using your setup code. Then add a worker and record an advance.

If the first account has no registered `workers.dev` subdomain, finish the one-time Cloudflare dashboard setup and rerun. The script does not choose a globally available name on your behalf. If a later step fails, the database is retained; the script does not delete records or replace a database to make a retry succeed. Resolve the access/configuration error and rerun to reuse it.

## Verify before relying on it

Deployment completion alone is not a readiness check. Verify these using the real HTTPS address:

1. Register and log in as the owner, then add a worker and save an advance.
2. Open that worker's private link on another phone. The entry should appear, and that page must not allow editing or expose other workers.
3. Edit or cancel the entry as owner and confirm the worker view updates. Cancellation remains in history but is excluded from totals.
4. Use **Open WhatsApp**, check the recipient, and tap **Send** yourself. No WhatsApp message is automatically sent by deployment or testing.
5. Export a backup and confirm you can recover it. Worker links are private access credentials; anyone with a link can see that worker's entries. Rotate an exposed link from worker details.

Private worker pages refresh automatically while open. HTTPS, the shared D1 database and owner authentication are part of this deployment; no process on your laptop must stay open.

On Android, the owner can use the browser menu's **Install app / Add to Home screen**. On iPhone, use Safari's **Share → Add to Home Screen**. This does not require publishing an app in either app store. Workers can bookmark their individual private page. An internet connection is required; this deployment does not pretend to save shared payments while offline.

Owner polling checks a small revision value before loading history again. Worker pages similarly check a private revision and refresh once a minute while visible; unchanged polls do not scan their history. The page loads current records immediately when opened, so a worker following a WhatsApp link sees the saved entry without waiting for a polling interval.

## Backups and limits

Keep CSV exports for convenient reporting and export D1 before major changes. CSV is not a full account/audit backup. Use the generated configuration to export the complete database:

```sh
npx --no-install wrangler d1 export DB --remote \
  --config .data/wrangler.production.json \
  --output .data/hisab-d1-backup.sql
```

Protect the SQL file like financial data and test recovery in a separate database; do not apply a restore blindly over live data. Free quotas are shared with any other Workers/D1 projects on the same account. When a Free limit is reached, operations can fail until limits reset or storage is freed; this project does not automatically upgrade the plan. See [FREE_PLAN.md](FREE_PLAN.md) for verified allowances and official sources.
