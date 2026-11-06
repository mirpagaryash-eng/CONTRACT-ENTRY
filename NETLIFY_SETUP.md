# Put Hisab online with Netlify and Supabase

Netlify serves the app and its API. Supabase keeps the shared records in Postgres, so closing a browser or redeploying the website does not erase them. Use the services' Free plans and stay within their allowances. Free projects can be restricted or paused; this is not a promise of unlimited or uninterrupted hosting.

The app code handles owner sign-in, private worker pages and database setup. You must sign in to the two hosting accounts and enter the private settings yourself. Do not send passwords or connection strings in chat.

## 1. Create the database

1. Open [Supabase](https://supabase.com/dashboard) and sign in with GitHub.
2. Create a project in a **Free** organization. Choose a nearby region and save its database password privately. A long, randomly generated password using letters and numbers avoids special-character escaping in the next step.
3. Wait for the project to become ready, then open its **Connect** panel and choose **Transaction pooler**.
4. Copy the Postgres connection URI. Replace its `[YOUR-PASSWORD]` placeholder with your database password. If the password contains reserved URL characters, percent-encode that password portion. Keep the rest of the URI exactly as Supabase supplies it.

Use the shared pooler address ending in `.pooler.supabase.com` on port `6543`. Copy the full host and username from Supabase; do not construct them from your region. The shared pooler supports IPv4 without buying the IPv4 add-on. You do not need a Supabase API token, browser key, or SQL Editor step for this app.

## 2. Import the existing project into Netlify

1. Open [Netlify](https://app.netlify.com/) and sign in with GitHub.
2. Import an existing GitHub project and authorize access to **mirpagaryash-eng/CONTRACT-ENTRY**.
3. Select branch **main**. The repository's `netlify.toml` supplies the build and routing settings: build command `npm run build`, publish directory `dist`, and the API functions directory.
4. Before deploying, add these private environment settings:

   | Private setting | Supply your own value as described below |
   | --- | --- |
   | `DATABASE_URL` | The complete Transaction pooler URI from step 1, including the real database password. |
   | `ADMIN_INVITE_CODE` | A new private setup code with at least 16 characters. Keep it for the owner's first visit. |

5. Deploy the project. Keep these values on the server; do not add a `VITE_` prefix or put them in source code. If you change them after deployment, deploy again so the functions use the new settings.

Use the existing-repository import flow above. Netlify's separate template-deployment button creates another GitHub repository, which is unnecessary here. Cloudflare settings and the old GitHub deployment workflow are not used by this route.

## 3. Open and check the app

After deployment succeeds, Netlify displays the site's HTTPS address ending in `.netlify.app`. That assigned address is the app link; this document does not contain an already deployed app URL.

1. Open the address in Chrome on Android or Safari on iPhone. Use the browser itself rather than a chat attachment preview.
2. Open `/api/health` on that same address and check for `{"ok":true}`. Then check `/api/session` returns JSON with `setupRequired: true` before the owner account exists. The first API request initializes the app's private database schema and can take longer than later requests.
3. Return to the main address. Create the owner's account using the private setup code from Netlify. There is no default login.
4. Add a worker and record an advance. Open that worker's private link in another browser or on another phone. Confirm the record is visible and editing controls are absent.
5. Edit the entry as the owner and refresh the worker page to confirm the correction is shared. Check an unrelated worker's private link does not show this record.

Share each worker's own private link only with that worker. Anyone holding that link can view that worker's history; the owner can replace an exposed link.

**WhatsApp stays manual and free of API setup:** save an advance, tap **Open WhatsApp**, then tap **Send** in WhatsApp. Opening the prepared message does not send it automatically or prove delivery.

## If something fails

- **Build failed:** check the Netlify build log and confirm the deployment uses the latest `main` branch and the checked-in configuration.
- **Database not connected:** confirm `DATABASE_URL` is the full shared Transaction pooler URI, the password placeholder has been replaced, and the Supabase project is running. Redeploy after correcting settings. Do not post that URI in screenshots or logs.
- **Owner setup blocked:** confirm `ADMIN_INVITE_CODE` has at least 16 characters and enter the same code in the app. Only one owner account can be registered.
- **Previously working database stopped:** check Supabase for a paused project or usage restriction, and check both services' usage dashboards.

Startup failures show a safe diagnostic code without exposing the connection URI or driver error. `DB_AUTH` identifies rejected database credentials; `DB_ENDPOINT` identifies a rejected Supabase tenant/user; `DB_DNS`, `DB_NETWORK` and `DB_TIMEOUT` identify connection failures. `DB_PERMISSION`, `DB_SCHEMA_FILE` and `DB_SCHEMA` identify initialization problems. Share the diagnostic code, never passwords or the complete connection URI.

For `DB_TLS`, use Supabase's **Database → Settings** certificate download. Add the public PEM certificate as an optional Netlify environment variable named `DATABASE_CA_CERT`, then redeploy. The value can contain real line breaks or literal `\n` escapes. Existing trusted roots remain trusted, and certificate/hostname verification remains enabled. This setting accepts public certificates only, never private keys. See [Supabase SSL guidance](https://supabase.com/docs/guides/platform/ssl-enforcement). A certificate setting cannot repair an incorrect password or hostname.

Export records regularly and keep a database backup outside these accounts. The app's CSV contains advance records; it is not a complete account-and-history database backup. Existing browser-preview, SQLite or Cloudflare D1 records are not automatically imported into this new database.

## Local validation

Run `npm ci`, `npm run build`, `npm run test:netlify` and `npm run test:netlify-ui` with Node.js 24. The PostgreSQL tests use a local PostgreSQL engine through PGlite; they do not connect to a hosting account or submit WhatsApp messages. The browser test requires Playwright Chromium or a system Chromium configured with `PLAYWRIGHT_CHROMIUM_EXECUTABLE`. Local success does not verify the deployed Supabase connection or the assigned Netlify address.

Sources: [Supabase connection methods](https://supabase.com/docs/guides/database/connecting-to-postgres), [Supabase billing and Free plan](https://supabase.com/docs/guides/platform/billing-on-supabase), and [Netlify plans](https://www.netlify.com/pricing/). Check current plan terms in each account before enabling paid features.
