# DEC-005: Database plan (ACCEPTED: option A, 2026-11-24)

Fact: Neon is on Free, managed via the Vercel integration.

Problem: Fleet Console is never idle. 60-second heartbeats and a per-minute stale-detection cron keep compute awake around the clock, so Free's scale-to-zero does not help. Always-on at 0.25 CU is about 180 CU-hours a month. Storage at 8 nodes (about 350k Snapshots a month plus about 260k probes) is roughly 0.3 to 1 GB depending on row design, with 30-day retention.

Figures for Neon Free and Launch limits and prices are from the Architect's briefing assumptions and Lead Engineer's knowledge, not verified against current Neon pricing. Verify in Vercel > Integrations > Neon Database > Settings before deciding.

Options:
A. Upgrade Neon to Launch (usage-based), separate Neon project for the console. Est. $15 to $25 a month. Also unlocks the Neon consumption API that KPTR's cost provider needs.
B. Console database on another provider's free tier. $0, but a new vendor and pause or limit risks on a monitoring system.
C. Stay on Free. Not viable beyond a trial: compute allowance is exhausted mid-month.

Recommendation: A.

## Decision and cost estimate (2026-11-24)

Bill chose A. Launch rates read from the Neon plan dialog in the Vercel integration: storage $0.35 per GB-month, compute $0.106 per CU-hour, sizes up to 16 CU. The dialog states the plan applies to every product in the installation, not just the console.

Console estimate at 8 nodes and 6 apps:

| Item | Basis | Per month |
|---|---|---|
| Compute | 0.25 CU always on (never idles: 60 s heartbeats, 1-minute cron) = 182.5 CU-h x $0.106 | $19.35 |
| Compute burst allowance | 10% of the time at 0.5 CU | about $2 |
| Storage | 0.2 to 0.45 GB data, up to about 1 GB with restore history, x $0.35 | $0.07 to $0.35 |
| Total | | about $19.5 expected, $22 with burst |

Controls: set the console project's autoscaling maximum to 0.5 CU (worst case about $39 a month). Minimum 0.25 CU is from Lead Engineer knowledge; confirm in the Neon project settings.

Unmeasured: the cost the upgrade adds to the other apps' databases, because the plan covers the whole installation. Check last month's compute hours per project in Neon and multiply by $0.106. Any monthly minimum charge is not shown in the dialog.

Isolation option: create the console's database under a separate Neon organisation or Vercel installation so its billing is separate. Costs nothing technically (the connection string is an environment variable). Not decided.
