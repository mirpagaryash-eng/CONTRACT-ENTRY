# Netlify API with Supabase Postgres

Follow [the account and deployment steps](../NETLIFY_SETUP.md) to obtain a mobile HTTPS app link without Cloudflare. The app requires two server settings: `DATABASE_URL` and a private `ADMIN_INVITE_CODE` of at least 16 characters.

The frontend calls the same-origin `/api/*` Netlify Function. Only that server function connects to the database. No Supabase database password or privileged API key is included in the browser build. The existing phone-and-password owner account remains the app login; a Supabase user account is not a worker login.

Use Supabase's **shared Transaction pooler** URI, copied from the project's **Connect** panel. Its port is `6543`, it supports IPv4, and it is intended for serverless connections. The server uses parameterized, unnamed queries rather than session-bound prepared statements. TLS certificate verification must remain enabled.

On the first API request, the server initializes [schema.sql](schema.sql) in the private `hisab` schema. Tables have Row Level Security enabled and public/browser roles are denied access. Application reads and writes go through owner-session checks or a worker's private read-only link. Database triggers keep advance changes, cancellation history, audit entries and worker revision counters atomic.

The database survives Netlify function restarts and website deploys. Initialization is additive; it does not import an existing SQLite, D1 or browser-preview register. Free-plan limits and project pausing still apply. Export advance records and arrange private Postgres backups; the SQLite backup command does not back up Supabase.

This deployment prepares WhatsApp messages for the owner to send explicitly. It does not configure Meta's paid messaging API or send messages during deployment.

Account setup, TLS connectivity to a real Supabase project, Netlify deployment and the assigned public URL require verification in those services. Passing local tests alone does not establish a live deployment.
