# DEC-005: Database plan (OPEN, needs Bill's decision; ARCH-001 s14 "raise before build")

Fact: Neon is on Free, managed via the Vercel integration.

Problem: Fleet Console is never idle. 60-second heartbeats and a per-minute stale-detection cron keep compute awake around the clock, so Free's scale-to-zero does not help. Always-on at 0.25 CU is about 180 CU-hours a month. Storage at 8 nodes (about 350k Snapshots a month plus about 260k probes) is roughly 0.3 to 1 GB depending on row design, with 30-day retention.

Figures for Neon Free and Launch limits and prices are from the Architect's briefing assumptions and Lead Engineer's knowledge, not verified against current Neon pricing. Verify in Vercel > Integrations > Neon Database > Settings before deciding.

Options:
A. Upgrade Neon to Launch (usage-based), separate Neon project for the console. Est. $15 to $25 a month. Also unlocks the Neon consumption API that KPTR's cost provider needs.
B. Console database on another provider's free tier. $0, but a new vendor and pause or limit risks on a monitoring system.
C. Stay on Free. Not viable beyond a trial: compute allowance is exhausted mid-month.

Recommendation: A.
