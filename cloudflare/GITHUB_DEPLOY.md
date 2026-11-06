# Open the app on your phone using GitHub

You do not need to find Codex environment settings. Use your existing GitHub repository and Cloudflare Free account. This creates a shared internet app with a normal `https://…workers.dev` address for Android, iPhone and laptops.

## 1. Save two private values

Sign in to GitHub and open:

**[Repository secrets](https://github.com/mirpagaryash-eng/CONTRACT-ENTRY/settings/secrets/actions)**

Tap **New repository secret**. Enter the first name below in **Name**, paste its value in **Secret**, and tap **Add secret**. Repeat for the second name.

| Name | What to enter in Secret |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | The Cloudflare API token you already created. |
| `ADMIN_INVITE_CODE` | A private setup code you choose, at least 16 characters on one line. Keep a copy: you enter this code on the app's first owner registration screen. |

Do not send these values in chat or put them in a repository file. The setup code is separate from the login password you choose in the app. Keep it private so only you can create the first owner account.

The Cloudflare token needs account-scoped **Workers Scripts Edit**, **D1 Edit** and **Account Settings Read**. An account ID is usually unnecessary: deployment selects the account only when the token can access exactly one. If deployment reports multiple accessible accounts, add a third repository secret named `CLOUDFLARE_ACCOUNT_ID` with the correct 32-character Account ID from Cloudflare.

## 2. Run deployment

Open **[Deploy free mobile app](https://github.com/mirpagaryash-eng/CONTRACT-ENTRY/actions/workflows/deploy-free.yml)**.

1. If GitHub asks to enable Actions for this repository, enable it.
2. Tap **Run workflow**, leave the branch on **main**, then tap the green **Run workflow** button.
3. Open the new run. Wait until its steps finish, then open the run's **Summary**.
4. Tap **Open your app** in the summary. This is the address to use on your phone.

The workflow runs only when you press **Run workflow**. Saving code, opening a pull request or adding secrets does not deploy it. If the workflow is not listed yet, the source has not reached the repository's default branch.

Deployment builds the app, creates or reuses the named D1 database, publishes the Worker and installs your setup code privately. If the Cloudflare account has no `workers.dev` subdomain, it initializes an available `hisab-…` subdomain; an existing subdomain is kept. It does not buy a domain, change billing or upgrade a plan. Later runs retain the database and its records.

Keep **Cloudflare Workers Free** enabled. This uses GitHub's standard `ubuntu-latest` runner and no paid larger runner; GitHub's included Actions allowance depends on the repository and account. If GitHub asks you to buy minutes or increase a spending budget, stop rather than enabling a paid service. Cloudflare Free quotas can also stop operations when exhausted; see [the free-plan limits](FREE_PLAN.md).

## 3. Create your owner login

On the app's first screen, enter the setup code you stored as `ADMIN_INVITE_CODE`, then set your name, phone number and login password. Add a worker, save an advance, and open that worker's private link on another phone to confirm the entry is visible. Only the owner can edit.

The workflow checks that the public address responds over HTTPS and that its health and sign-in endpoints work. You still need to check the owner and worker screens on your phones before using real payroll records. No owner account, worker record or WhatsApp message is created by these checks.

On Android, use your browser's **Install app / Add to Home screen** option. On iPhone, open the address in Safari and use **Share → Add to Home Screen**. An internet connection is required. Workers can bookmark their own private page; keep each worker link private.

For WhatsApp, the app prepares the advance message. You tap **Open WhatsApp**, check the recipient and tap **Send**. The free version does not automatically send background messages.

If a run fails, read its failing step, correct the named setting and run it again. Never paste secret values into logs or chat. Do not enable debug logging or upload `.env`, `.data`, database files or deployment credentials to troubleshoot.
