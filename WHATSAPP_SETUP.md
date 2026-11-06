# Connect a WhatsApp Business sender

The app already supports Meta's official WhatsApp Cloud API. A phone number in Settings identifies the owner; automatic sending uses the separate sender registered with Meta.

## Account steps the owner must complete

1. Open [Meta for Developers](https://developers.facebook.com/apps/). Sign in to the owner's Facebook/Meta account and follow Meta's WhatsApp business onboarding. Workers do not need a Facebook account.
2. Add the WhatsApp product/use case and associate the appropriate business account. Use Meta's test sender while learning the API setup, or follow its registration flow for the business's own number.
3. For a number already used in the WhatsApp Business mobile app, first check the account's eligibility to use the mobile app and API together. Eligibility and available onboarding routes vary. Do not delete or deregister the existing WhatsApp account just to try this app; choose a supported coexistence or migration flow only after understanding its effect on the existing business number.
4. Complete number ownership verification directly with Meta. Passwords, one-time verification codes and recovery codes stay with the owner.
5. Create an approved message template such as `worker_advance_update`. Its five body text parameters, in order, are worker name, advance amount, advance date, Cash/Online, and the worker's private HTTPS page URL. Suggested wording: `Hello {{1}}, your advance record is now {{2}}, dated {{3}}. Payment method: {{4}}. View current entries: {{5}}`. The wording must cover corrections as well as new records. Cancellation messages currently use the explicit manual WhatsApp button.

## Secure server settings

Configure these on the host or in the cloud environment settings, never in browser code or a downloaded HTML preview:

| Name | Where it comes from |
| --- | --- |
| `WHATSAPP_ACCESS_TOKEN` | Meta's authorized API access token for the sending business; use a production token for live service |
| `WHATSAPP_PHONE_NUMBER_ID` | Meta's numeric **Phone Number ID**, which is different from the phone number itself |
| `WHATSAPP_EXPECTED_NUMBER` | The intended business number, with country code, digits only; lets the read-only check detect the wrong sender |
| `WHATSAPP_TEMPLATE_NAME` | Name of the approved template |
| `WHATSAPP_TEMPLATE_LANGUAGE` | Approved template language code, e.g. `en` |
| `PUBLIC_BASE_URL` | The app's publicly reachable HTTPS address |
| `WHATSAPP_APP_SECRET` | Meta app secret, used locally to verify webhook signatures |
| `WHATSAPP_VERIFY_TOKEN` | A private webhook verification token chosen by the owner/operator |

For this managed environment, the access token can be a proxy-backed secret restricted to `graph.facebook.com`. The app secret and verification token must be real runtime environment values because signature/token checks happen inside the server; proxy placeholders cannot perform local cryptographic checks. Declare their names in the environment settings and enter values through the secure settings flow. Do not paste tokens or app secrets into chat.

The saved cloud draft declares the required names and allows the HTTPS API destination `graph.facebook.com`. A saved draft does not apply settings to the running instance; the owner must review/save and publish the environment to activate it. Nothing is published by the app or this guide. The deployment host needs the equivalent configuration independently.

## Check and activate

1. Host the full server application with persistent storage and HTTPS. A downloaded interactive frontend stores data in one browser and cannot make authenticated API calls with server secrets.
2. Set the values above and restart the server so it receives the updated environment. A configured variable is not proof that Meta has authorized it.
3. Run `npm run whatsapp:check`. This makes a **read-only** sender lookup and optionally compares the registered phone number with `WHATSAPP_EXPECTED_NUMBER`. It never sends a message. A successful lookup does not prove template approval or delivery.
4. Configure Meta's HTTPS callback at `PUBLIC_BASE_URL` plus `/api/whatsapp/webhook`, using the verification token and app secret. Subscribe to message-status events.
5. Record each worker's consent before enabling automatic updates. Then use an explicitly chosen test recipient and an actual test entry to validate the approved template and delivery webhook.

## Use the friend's sender later

The friend must own or authorize the replacement WhatsApp Business sender and complete its verification. Replace the token, Phone Number ID and expected business number securely; use a template approved for that business. Restart the server and repeat the read-only sender check before use. Worker records and past advances remain stored independently of the sender. The current app uses one automatic sender at a time.
