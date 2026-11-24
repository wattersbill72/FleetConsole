# US-060 Staleness detection and node-down alert: requirements

## What was built

- **Evaluator** (`server/evaluate.ts`): one pass over nodes in `healthy`, `degraded` or `stale` that have a heartbeat on record. A node is overdue when the database clock says `now - last_heartbeat_at >= 3 x its heartbeat interval`. The interval and intermittent flag come from the configuration the node is actually running (applied version, else desired). Runs in one transaction under an advisory lock, with the node rows locked `FOR UPDATE`, so overlapping runs do nothing and a node reporting at that instant cannot be marked stale.
- **Cron**: `GET /api/cron/evaluate`, every minute (`vercel.json`, Vercel Pro verified). It requires `Authorization: Bearer $CRON_SECRET` (Vercel sends that automatically when the variable is set); with no secret configured it refuses to run (503) rather than run open.
- **Alerts** (`server/alerts.ts`, migration 0004): one open alert per (rule, subject), enforced by a partial unique index, so repeated or concurrent evaluation cannot duplicate. Each alert records `opened_at`, `silent_since` (last time the subject was heard from), `closed_at`, `duration_s` (opened to closed), `outage_s` (silent to closed) and why it closed. `alert_events` records every open and close in order; it is the history, and the feed US-062 will send notifications from.
- **Recovery**: a live Snapshot from a stale node closes its node alert, and its farm alert, inside the ingest transaction, so the recorded duration is the real one, not rounded to the next evaluator run. A replayed Snapshot does not end an outage (it proves reachability, not health).
- `GET /api/alerts[?state=open]`: the caller's organisation's alerts, open first. The UI and searchable history belong to US-030 and US-062.

## Decisions

- **Farm outage rule**: a farm alert replaces the per-node alerts when the farm has at least two nodes expected to report (intermittent nodes excluded), every one of them is stale, and their last heartbeats were within 300 s of each other. A one-node farm gets a node alert. Silences that began far apart are separate outages and alert per node.
- **When the farm comes back in part**: the farm alert closes when any node reports; the nodes still silent then get their own alerts on the next run.
- **Intermittent nodes** move to `expected-offline` and never alert; a live Snapshot makes them `healthy` again.
- **Not evaluated**: `pending` (never reported), `decommissioning`, `removed`, `expected-offline`.
- **Alerts for nodes that leave the fleet** (removed, decommissioning) are closed by the evaluator.

## Acceptance

| Criterion | Status | Proof |
|---|---|---|
| Three missed intervals: `stale` and an alert opens | Met | tests at 170 s (no) and 181 s (yes); per-node interval honoured at 30 s, 60 s, 120 s |
| Detection runs in the console and works when every node is silent at once | Met | test with all nodes silent and no heartbeat arriving; evaluator uses the database clock only |
| Dead node flagged within four minutes at default settings | **Met with a caveat, below** | boundary test at 179 s and 181 s; cron is every minute |
| When the node reports again the alert closes and its duration is recorded | Met | real ingest path; `duration_s` and `outage_s` asserted; a later outage is a new alert, history kept |
| Intermittent node: `expected-offline`, no alert | Met | tests |
| Whole-farm outage: one farm alert instead of one per node | Met | tests, including the mixed, single-node and partial-recovery cases |

**Caveat on four minutes.** A node is stale from 180 s after its last heartbeat and the evaluator runs every 60 s, so detection is between 180 s and 240 s after the last heartbeat. That sits on the four-minute line: any lateness of a cron run beyond zero pushes the worst case a few seconds past it. This cannot be measured here; it needs a few weeks of real cron behaviour. If it matters, two cheap fixes: evaluate also on every ingest request (the fleet's own heartbeats then drive extra evaluations whenever at least one node is alive), or flag at 2.5 intervals. I have not done either; the first changes cost and the second changes what "three missed intervals" means. Tell me if you want one.

## Observations for Bill

1. **A node that enrols and never reports** stays `pending` forever and raises nothing. The story only covers nodes that stop; I did not invent a rule. A "pending for more than N minutes" alert is a small addition if you want it (it catches a broken install).
2. Until US-062, alerts open and close silently: you can see them through `/api/alerts` and `alert_events`, but nothing is sent.
3. Cron invocations are about 43,000 a month; they fit inside Pro's included usage.

## To enable

Set `CRON_SECRET` in Vercel (any long random string, for example `openssl rand -hex 32`) and redeploy so the cron picks it up.
