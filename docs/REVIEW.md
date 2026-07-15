# Review: pi-herdr-agents

**Reviewer:** Claude (Opus 4.8)
**Date:** 2026-07-15
**Commit reviewed:** `a19b3f8` ("change") on top of `16f45bf`
**Toolchain at review:** `npm run typecheck` clean, `npm run lint` clean, `npm test` 89 passing.

This is a working document, not a spec. It captures what the review found so it can
be picked up later. Items are grouped by status and tagged with priority.

---

## Verdict

Engineering quality is high: clean module boundaries, a genuinely strong safety
model, careful completion semantics, good unit coverage against a fake adapter.
This is a well-built **specialized** tool — its niche is visible, cross-runtime,
interactively-recoverable, detached delegation. For that niche it is the right
design.

Its one unavoidable structural constraint is that result retrieval and status
detection both ride on **terminal-text scraping** of a foreign CLI's TUI. That is
inherent to launching arbitrary CLIs in panes (no structured event stream crosses
the process boundary), and it is the ceiling on result fidelity. Code polish cannot
remove it; it can only be managed. Everything in "Open items" below is either about
managing that constraint or about the state machine layered on top of it.

### When this is the right tool (keep this boundary loud)

Wins specifically when you want one of: (a) a **different CLI/model** than the
caller; (b) a human **watching work live**; (c) **interactive recovery** from a
login/trust screen; (d) **detached** peers that outlive the parent session. Outside
that set — structured I/O, token accounting, tight coupling, quick disposable
delegation — Pi's native in-process `Agent` (or a workflow harness) is simpler and
more reliable. The README's "complementary, not a replacement" framing is correct.

---

## Addressed since the first review ✅

These were raised in earlier reviews and are now done and tested.

- **`herdr_list_agents`** — fleet listing tool. Exposes submission/write/pane
  metadata, sorted newest-first, wired into parent guidance ("use
  herdr_list_agents if an id is lost"). Was the #1 recommendation.
- **Write-overlap guard** (`reserveWriteLease`) — the biggest correctness win.
  Moves "never launch overlapping writers" from prompt-only advice to
  code-enforced serialization per canonical cwd. Uses `realpathSync` so symlinked
  paths collide correctly. Read-only roles (`writeAccess: "none"`) run
  unrestricted; writers serialize. Custom roles validate `writeAccess`.
- **`mutate`/`upsert` diff before persisting** (`isDeepStrictEqual`) — eliminates
  snapshot-log churn at the source. Proven by the "does not persist unchanged
  result polls" test. (This is the behavior the event-bus handoff wrongly
  *assumed* already existed — now it actually does.)
- **Prompt text no longer persisted** — `upsert`/`mutate` strip `prompt`; legacy
  prompts discarded on load. Closes the secrets-in-snapshot risk proactively.
- **`unavailable` vs `lost` distinction** — a transient Herdr transport failure no
  longer marks a peer permanently `lost`; it is `unavailable` and recoverable. Real
  robustness upgrade.
- **Start-failure reconciliation** — `agentGet` by unique display name with
  name/cwd/tab/workspace identity guards, recovering the "agent start timed out
  *after* the pane was created" case without risking grabbing the wrong pane.
- **Submission-state machine + task-marker echo** — see next section; clever and
  mostly right, with one caveat now under active validation.

---

## Under validation 🔬

### Marker-echo assumption (`waitForSubmissionEcho`)

The submission-state machine (`pending`→`submitted`→`acknowledged`) waits for
`[herdr-task-marker:<id>]` to appear in pane output before trusting a
`working`/`done` transition as task acknowledgement. This correctly kills the false
**positive** (attributing CLI-init status noise to the task).

It opens a false **negative**: if a CLI does not echo submitted input verbatim
(boxed/reflowed input widget, truncation, bracket stripping), the marker never
appears, and `launchAgent` times out at `startup_timeout_ms` even though the task
was accepted and is running.

**Tooling now exists for this** (delivered with this review):
- `scripts/probe-marker-echo.ts` — runnable diagnostic; spawns real panes, submits
  bare/wrapped/long prompts, reports PASS/FAIL/BLOCKED/ERROR + echo latency.
- `test/marker-echo-contract.test.ts` — drift guard tying the probe's marker
  format to `buildRoleAssignment`.
- `docs/marker-echo-checklist.md` — fill-in matrix + fallback plan.

**First live finding (pi profile only):** `bare` echoed in ~5.1s and `long` in
~0.5s (both during `working`), but the **production-shaped `wrapped` prompt echoed
only at ~57.7s, at `status=idle`** — i.e. after the run finished, not during it.
Within the 120s default timeout, so not breaking today, but the margin is thinner
than the mechanism assumes; a shorter `startup_timeout_ms` could turn an accepted
task into a false timeout. **cursor / codex / claude / agy are unverified** and are
the profiles most likely to use non-echoing input widgets.

**Action:** run `node scripts/probe-marker-echo.ts --profile <p>` for each CLI in
use; record in the checklist. If any FAIL, implement the soft-acknowledge fallback
(see Open item P1-a).

---

## Open items

### P1 — correctness, do these next

**P1-a. Soft-acknowledge fallback for non-echoing profiles.**
In `confirmPostSubmitStartup`, if the marker has not appeared but the pane has
transitioned to `working`, treat it as acknowledged with a recorded caveat rather
than blocking on the echo until timeout. Marker stays authoritative when present;
its absence degrades to the status signal instead of failing the launch. Natural to
implement alongside P1-b (same status-vs-marker reconciliation code).

**P1-b. Completion false-idle debounce.**
`waitForCompletionStatus` completes on the *first* idle/done after `working`. A
mid-run idle flicker (peer waiting on a subprocess, long redraw) can return a
premature transcript in foreground mode. The marker gates *entry* only; it does not
help here. Fix: require idle/done to persist across N consecutive polls before
declaring foreground completion. Mirror the existing fast-completion test when
adding coverage. **This is the single most important remaining correctness caveat.**

### P2 — robustness / clarity

**P2-a. Errored writer silently holds its write lease.**
`reserveWriteLease` skips stopped/lost/completed records, but an `error`-status
writer with `writeAccess: "workspace"` is none of those, so it keeps blocking new
writers in that cwd until explicitly stopped. Defensible as fail-safe, but a caller
who does not stop it hits confusing "conflicts with active agent" errors. Fix:
surface the blocking agent in the conflict message and/or `herdr_list_agents`
output, or reconsider whether `error` should release the lease.

**P2-b. No tracked-record cap.**
`store.records` grows unbounded over a long session, and every persist
re-serializes the whole list. davis7's `subagents` prunes settled entries at
`MAX_TRACKED=64`. Not urgent, but a slow leak. Fix: prune oldest settled
(non-`waitInterest`, non-running) records past a cap.

**P2-c. Write-lease scope is one orchestrator session — document it.**
The lease serializes within a single in-memory store. Two separate parent panes
each running this extension will not serialize against each other. Almost certainly
the intended model, but the guarantee is "within one orchestrator," not absolute.
State this explicitly in `agents.md` / PRD so nobody assumes cross-session mutual
exclusion.

### P3 — larger / strategic

**P3-a. Structured output convention.**
Still terminal scraping; fixed `transcript_lines` (default 120) truncates long runs
to the tail, and there is no final-answer delimiter. Bridge without a Herdr API
change: have role prompts instruct peers to emit a fenced `<result>…</result>`
block, and extract *that* rather than the raw tail. Turns "read the last 120 lines"
into "extract the answer block." This is the highest-value move for closing the gap
vs. structured-event backends, short of a real Herdr event API.

**P3-b. Event bus (`HANDOFF-event-bus.md`) — do NOT build as specified.**
Separate review recorded. Summary: right instinct (push delivery), wrong priority,
and unsafe as written. It does not fix scraping or false-idle (the actual
weaknesses); `pane.output_matched.read.text` is the same rendered text, just pushed.
Two load-bearing assumptions in the doc are now moot or wrong for other reasons
(mutate-diffing now exists; caching pushed text on the record would violate the
no-secrets-in-snapshots invariant). It also bypasses the `pi.exec("herdr", …)` CLI
boundary for a raw `protocol: 16` socket — protocol-version coupling in a silent
background listener. If auto-delivery is wanted, prefer a persistent re-arm loop
over the existing `herdr wait agent-status` adapter + `pi.sendMessage({deliverAs:
"followUp"})` — stays on the CLI boundary, no socket lifecycle. Only reach for the
raw socket if subprocess overhead is *measured* as a real cost.

---

## Comparison note: vs. davis7/subagents

For **general** subagent-flow management, davis7's `subagents` is the better
*engine*: structured `SubagentEvent` streams (real tool calls, thinking, final
text, token usage) normalized across pi/Claude/Codex backends, auto result-delivery,
hard concurrency caps, and record pruning — all things herdr's scraping model
structurally cannot match. Its cost is a heavy Effect-v4 commitment that taxes every
future change if the maintainers are not Effect-fluent.

herdr-agents wins where `subagents` structurally cannot: runtime breadth (any argv,
incl. Cursor/OpenCode/custom), human-in-the-loop visibility, interactive recovery,
and detached persistence (peers outlive the parent; `subagents` children die on
`session_shutdown`). They are two halves of a complete story, not competitors — the
same relationship herdr's README describes vs. the native `Agent` tool.

---

## Quick reference: suggested order of work

1. **P1-a + P1-b together** (soft-acknowledge + completion debounce) — same code
   area, both correctness.
2. Run `scripts/probe-marker-echo.ts` per profile; fill `docs/marker-echo-checklist.md`.
3. **P2-a** (errored-writer lease message) — small, removes a confusing footgun.
4. **P3-a** (structured `<result>` convention) — highest strategic value.
5. **P2-b / P2-c** (record cap; document lease scope) — housekeeping.
6. Leave **P3-b** (event bus) parked unless auto-delivery becomes a felt need, and
   then do the CLI-based re-arm loop, not the raw socket.
