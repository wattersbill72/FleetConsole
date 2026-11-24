# US-062 Notifications and alert history: requirements

## What was built

**Delivery** (`server/notify/`)
- **Outbox**: an alert transition and its notifications are written in one transaction (`server/alerts.ts`), so neither can exist without the other. One row per transition per address; a unique index makes "once per transition per address" a database rule, so retries and re-runs cannot duplicate. Open and close are the only events that notify; an alert is opened once (partial unique index, US-060), so nothing repeats while it stays open.
- **Sending**: the per-minute cron (`/api/cron/evaluate`) evaluates, then delivers. Delivery claims due rows with `FOR UPDATE SKIP LOCKED` and leases them for 2 minutes, so concurrent or crashed runs neither double-send nor lose mail. A delivery fault can never stop detection (separate step, errors contained). An opening alert is emailed in the same cron run that detected it; a closing one within a minute of recovery.
- **Failure handling**: network errors, 429 and 5xx retry after 1, 5, 15, 60 and 240 minutes, then become `failed`. A provider refusal (rejected message, bad credentials) fails at once with the provider's own words. If email is not configured the message waits and is sent when it is. An address removed while its message waits is skipped, never written to. No recipient configured produces a visible `skipped` row, not silence. "Retry failed" re-queues the last 24 hours of failures.
- **Channels** (`channels.ts`): a channel is `{ name, configured(), send() }` in a registry; targets carry a channel name. A second channel is a new implementation plus target rows; a test registers one and proves alerts reach it alongside email with no change to the core (OD-2).
- **Email through SES** (`ses.ts`, DEC-007): SES v2 `outbound-emails`, signed by `sigv4.ts` using Node's `crypto`, no dependency added. The signer reproduces AWS's published "get-vanilla" test vector exactly. Env: `SES_REGION`, `SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY`, `SES_FROM` (AWS_* names are reserved by Vercel). Error text never includes the request, so it cannot carry the recipient or the signature.
- **Content** (`render.ts`, pure): subject names the product (the organisation's product-name setting) and the subject of the alert; body gives the condition, the opened and resolved times in the farm's time zone, how long the machine was silent, and a link (`CONSOLE_URL/#alerts/<id>`). Operator-supplied names have control characters stripped and are HTML-escaped, so a node called `x\r\nBcc: ...` cannot inject headers or markup.

**API and UI**
- `GET /api/alerts`: open first, then history, with durations; filter by name text (wildcards are literal), state, rule, opened-within range, alert id; paged. Organisation-scoped.
- `GET /api/notifications`, `POST/DELETE /api/notifications/targets`, `POST /api/notifications/test`, `POST /api/notifications/retry`. Target changes, tests and retries are audit events.
- UI: Alerts tab (search, state, range, durations, deep link from the email), Settings tab (email set-up status, addresses, send test, retry failed, recent notifications with errors), and a banner on every screen when notifications failed in the last 24 hours.

## Acceptance

| Criterion | Status | Proof |
|---|---|---|
| Email when an alert opens and when it closes, stating subject, condition, time, link | Met against a fake SES | full-path test: real stale detection, real ingest recovery, two emails with the expected subject, body, link, signed request |
| No repeat notifications while an alert stays open | Met | four evaluator runs with the node still silent: exactly one email |
| A test notification can be sent from settings | Met | test: per-address result, provider error shown, never retried in the background, audited |
| Console lists open alerts and a searchable history with durations | Met | search, state, range, rule, id, paging, org isolation tests |
| Notification failures are visible in the console | Met | failed and waiting and skipped notifications listed with their reason; banner; retry action |
| Second channel can be added without rework | Met | stub-channel test |

## Not verified

1. **A real SES send.** Everything is tested against a fake SES. The first live send needs: an SES identity (the `SES_FROM` address or its domain) verified in the chosen region; the account out of the SES sandbox, otherwise every recipient must be verified too (KPTR's account is in production access; whether this is the same AWS account is yours to confirm); and an IAM user limited to `ses:SendEmail` with its keys set in Vercel. The test notification button is the check: it shows SES's own refusal if anything is wrong.
2. **The UI has not been run in a browser** (typecheck and build only).
3. **Cron on Vercel**, as in US-060.

## Changes outside the story
- `npm test` now runs test files one at a time (`--test-concurrency=1`, 13 s instead of 6 s). The suite shares one database and the evaluator and delivery jobs act on all organisations, so parallel files could interfere with each other.

## To enable
In Vercel: `SES_REGION`, `SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY`, `SES_FROM`, `CONSOLE_URL`, `CRON_SECRET`. Then Settings, add your address, Send test notification.
