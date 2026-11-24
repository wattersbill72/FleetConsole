# DEC-004: Stale detection scheduler (OPEN, blocked on plan confirmation)

US-060 requires a dead node flagged within four minutes, so evaluation must run at least every minute and must run when every node is silent.

Vercel Hobby cron runs at most daily; Pro runs per-minute. Bill believes the account is Pro; not yet verified.

If Pro confirmed: Vercel Cron every minute calls an internal evaluate endpoint. If Hobby: raise before build (plan upgrade or external pinger). Decision is final only once the plan is verified; record it in CLAUDE.md Operational facts.
