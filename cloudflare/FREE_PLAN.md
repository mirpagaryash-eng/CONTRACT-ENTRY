# Using the app without a hosting bill

Checked against Cloudflare's official documentation source on 6 November 2026. Prices and limits can change; check the linked pages when setting up the account.

The deployment uses **Cloudflare Workers Free**, **Workers static assets**, and **D1 Free**. A Cloudflare account is needed. Keep the Workers plan on **Free**; this project does not require Workers Paid, a purchased domain, R2, or any paid add-on.

| Component | Current Free allowance |
| --- | --- |
| Frontend static assets | Free, unlimited requests; no additional asset storage charge |
| Dynamic Worker API | 100,000 requests per account per day; 10 ms CPU per invocation |
| D1 database reads | 5 million rows read per account per day |
| D1 database writes | 100,000 rows written per account per day |
| D1 storage | 5 GB per account; 500 MB per database; up to 10 databases |
| App address | A `workers.dev` subdomain supplied with the account; no domain purchase required |

Daily limits reset at 00:00 UTC. Rows scanned and index updates count toward database usage, so these allowances are not counts of user actions. Other platform limits also apply.

On Workers Free, excess dynamic requests fail rather than becoming paid overage. Cloudflare documents Error 1027 for the daily request limit; requests matching static asset `run_worker_first` patterns can receive HTTP 429. On D1 Free, exceeding daily read/write limits makes queries return errors until the allowance resets; reaching storage limits requires deleting unused data before more writes. The Paid plan is a separate upgrade. Do not upgrade or enable paid services if the requirement is a zero hosting bill.

Cloudflare currently recommends a custom domain or route for production, and describes `workers.dev` as intended for personal or hobby projects that are not business-critical. The supplied address is a practical no-domain-cost starting point; it is not a guarantee of uninterrupted payroll service. Export backups regularly. Account creation requirements, including whether Cloudflare asks this particular user for payment details, have not been verified in a live signup.

## WhatsApp

The free workflow opens WhatsApp with the worker's number and a prepared payment message. The owner taps **Send** in WhatsApp. The app cannot silently send WhatsApp messages this way. Fully automatic proactive messages require an approved WhatsApp Business Platform integration, credentials, and applicable Meta/provider pricing; a permanent zero-cost automatic notification service is not promised. Existing internet/mobile data costs are separate.

## Why GitHub Pages alone is insufficient

GitHub Pages can serve the HTML, CSS, and JavaScript frontend. It is a static hosting service and does not run this app's server or shared database. Publishing the frontend alone would not provide synchronized owner/worker accounts. The Worker and D1 supply that shared backend.

## Official sources

- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) — Free by default, 100,000 dynamic requests/day, 10 ms CPU, static asset requests free and unlimited, D1 available on Free. [Source](https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/workers/platform/pricing.mdx).
- [Static assets billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/) — no asset storage charge and `run_worker_first` limit behavior. [Source](https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/workers/static-assets/billing-and-limitations.mdx).
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/#daily-requests) — daily reset and Error 1027. [Source](https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/workers/platform/limits.mdx).
- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) — daily quotas, storage, and excess Free usage behavior. [Pricing table source](https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/partials/workers/d1-pricing.mdx), [FAQ source](https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/partials/d1/faq-pricing.mdx).
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) — database size and account storage caps. [Source](https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/d1/platform/limits.mdx).
- [`workers.dev`](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/) — supplied address, public access, and intended-use guidance. [Source](https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/workers/configuration/routing/workers-dev.mdx).
- [GitHub Pages description](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages) — static hosting. [Source](https://github.com/github/docs/blob/main/content/pages/getting-started-with-github-pages/what-is-github-pages.md).
