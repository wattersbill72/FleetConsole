# US-030 Fleet overview: requirements

## What was built

- `GET /api/overview` (`server/overview.ts`): one organisation-scoped response with everything the home screen needs, from two queries plus the clock: nodes grouped by farm (name, status, age of last heartbeat, CPU, memory %, worst disk %, agent version, platform), a summary, and the five newest open alerts with the true open count. Removed nodes are not listed. Empty farms are listed.
- **Status is computed at read time** from the database clock with the evaluator's rule (three missed intervals of the node's own interval; intermittent nodes show `expected-offline`). The screen is therefore correct when the evaluator has not run or is not running: with the whole home site offline, every node shows `stale` with its true last-seen time. A test proves the shown status and the stored status never disagree once the evaluator has run.
- **Order**: stale, degraded, removing, pending, expected-offline, healthy; farms ordered by their most urgent node, empty farms last.
- **Home screen** (`src/Overview.tsx`): headline ("All clear: 3 of 3 machines healthy" or "2 machines need attention" or "N open alerts"), open-alert count and the newest five linking to the alert, then each farm with its machines. Refreshes every 30 seconds while the tab is visible, immediately when it becomes visible again, with a "Refresh now" button and "Updated 12 s ago". The "last heard" ages tick every second between refreshes, computed from the server's clock so a wrong clock on the viewing device cannot skew them. If a refresh fails, the screen says so and shows how old the data on screen is; it never shows stale data as if it were fresh.
- **Not colour alone**: every status is an icon plus a word; non-healthy rows have a heavier edge in a different line style per status (solid, double, dashed, dotted), stale and degraded names are underlined, and the headline carries a symbol and a thick border.
- Unavailable metrics show `—`, never 0. Metrics of a stale or expected-offline node are shown dimmed and italic with a "last known value" tooltip.
- The overview is now the landing page; Farms moved to `#farms`, and a farm is selected by `#farms/<id>` so the overview and emails can link to it.

## Decision: polling must not keep a session alive

US-001 says sessions expire after inactivity. A screen that polls every 30 seconds would be "active" forever. `withAuth` now takes `{ passive: true }`: a passive request is authenticated normally but does not refresh the activity stamp. The overview endpoint is passive. Consequence: a screen left open expires 8 hours after the operator last did anything, then shows the sign-in form. That is the story's rule; for a wall display it means signing in again once a day. A kiosk mode would be a separate decision.

## Acceptance

| Criterion | Status | Proof |
|---|---|---|
| Every node grouped by farm with name, status, time since last heartbeat, CPU, memory, worst disk, agent version | Met | API tests; UI renders these columns |
| Hosted apps on the same screen once Epic 5 ships | Not applicable yet | the response and screen get an apps section with US-041 |
| Not-healthy sorted first and distinct without colour alone | Met by construction | sort tested; styling by icon, word, border style, underline (not viewed in a browser) |
| Open alerts summarised at the top with a count | Met | tests: count, newest five, "and N more" link |
| Refreshes itself and shows when it last refreshed | Built | polling, visibility handling and the failure state are code-reviewed only; no browser run |
| With the home site fully offline, loads and shows every node stale with correct last-seen times | Met | test: five nodes silent 10 minutes, no evaluator run, all `stale`, ages correct; unchanged after the evaluator runs |
| Usable on a phone | **Not demonstrated.** Built mobile first (cards under 760 px, columns above), but not seen on any screen | needs a browser run |
| NFR: usable within two seconds | API side met | 60 nodes answer in well under 500 ms in test; page load time not measured |

## Not verified, and a request

The UI has never been run in a browser in any slice, so "usable on a phone" and the visual distinctness cannot be demonstrated, and CLAUDE.md requires every criterion to be demonstrable. CLAUDE.md says not to run a dev server here (written for a project where no browser existed). This environment has headless Chromium and Playwright. I have not overridden the rule. If you allow it, I would serve the built app against the test database and take phone-width and desktop screenshots of every screen, as a standing check.
