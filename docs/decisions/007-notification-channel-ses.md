# DEC-007: Notification channel for launch (OD-2): email through AWS SES

Status: Accepted by Bill, 2026-11-24 ("use SES for email").

Decision: alert and test notifications go by email through AWS SES, as the KPTR app does. The design keeps the channel behind an interface so a second channel is an addition (US-062).

To settle when US-062 is built, not now:
- SDK or hand-signed requests. KPTR uses `@aws-sdk/client-ses`; that is a new dependency here and is raised then, with the alternative of signing the one SES call by hand with Node's `crypto` (no dependency).
- The sending identity (verified domain or address), the region, and a dedicated IAM user limited to `ses:SendEmail`. KPTR's SES account is in production access (not the sandbox), but Fleet Console should use its own credentials, not KPTR's.
- Env: `AWS_REGION`, `SES_FROM`, `SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY` (names provisional).
