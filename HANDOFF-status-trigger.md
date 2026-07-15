# Minimal approach: status-change as trigger, then get-result

**Status:** Proposed (simpler variant of `HANDOFF-event-bus.md`).
**Relationship to the other handoff:** this is the recommended path; the full
`output_matched`/output-caching version in `HANDOFF-event-bus.md` becomes an
*optional later enhancement*, not the first cut.

---

## TL;DR

Herdr's agent-panel "dot" is just a rendering of the `agent_status` field
(`idle | working | blocked | done | unknown`). The dot flips in real time
because the TUI client receives a `pane.agent_status_changed` event — **there is
no separate "dot channel"; the event *is* the dot.**

The extension **already** does "wait for the dot to flip → get the result":
`waitForAnyAgentStatus` blocks on `herdr wait agent-status --status done`, then
`getAgentResult` reads the transcript. The only thing worth changing is the
*transport* — swap the per-call blocking subprocess for a subscription to that
same status-change event. The result fetch (`pane read`) stays identical.

---

## The key insight

- `agent_status` is one field, surfaced identically in three places:
  `pane get`, `api snapshot`, and the `pane.agent_status_changed` event.
- The UI dot is a render of that field. It updates because the TUI is
  subscribed to `pane.agent_status_changed`.
- Therefore: *"react to the status change, then invoke get-result"* is not a new
  capability — it's a **lighter transport** for behavior that already exists.

---

## Today's path (already "status change → get result")

In `src/lifecycle.ts`:

1. `waitForAnyAgentStatus(...)` → `adapter.waitAgentStatus(...)`
2. → shells **`herdr wait agent-status --status done`** — *blocks until the dot
   would flip to `done`*, then returns.
3. → `getAgentResult` reads the rendered transcript via `pane read`.

So `get_agent_result(mode:"wait")` today is literally "wait for the dot to turn
done, then fetch the output." Heavy only because each wait spawns a blocking
subprocess.

---

## The minimal change

1. Subscribe to **`pane.agent_status_changed`** (the event that flips the dot).
2. When it flips to **`done`** for a peer's `pane_id` → run the **existing**
   get-result path (`pane read`).

| | Today | Minimal (this doc) |
|---|---|---|
| Trigger | blocking `herdr wait agent-status` subprocess per call | one subscription to `pane.agent_status_changed` |
| Result fetch | `pane read` | `pane read` — **unchanged** |
| Scope of change | — | only the wake-up; get-result logic identical |

### Event payload we actually use

`pane.agent_status_changed` → `{ pane_id, workspace_id, agent_status, agent?, custom_status?, display_agent?, title?, state_labels? }`

We only need `pane_id` (to map to `agentId` via `AgentRecord.identity.paneId`)
and `agent_status`. Everything else is ignorable for the first cut.

---

## What this drops vs. the full event bus

Choosing the trigger-only version removes the two riskiest pieces from
`HANDOFF-event-bus.md`:

- ❌ `pane.output_matched` subscription — not needed.
- ❌ Caching pushed output text on the record — not needed; we still `pane read`.
- ❌ `pane_id ↔ agentId` mapping *for output payloads* — only needed for status,
  which already exists in every record (`identity.paneId`).

The socket wire-framing unknown also **shrinks**: we only have to read an
`agent_status` enum off the status event, not parse/verify output text
payloads. A tiny status poll as fallback is trivial and safe.

---

## Still required (carry over from the full handoff)

- **Gate to parent only.** Open the subscriber lazily on the first `launchAgent`
  call in this process, not at module load — peers load the same extension and
  must not each open a subscription. (Alternative heuristic: the parent is the
  pane whose system prompt does not contain `<herdr-peer-delegation>`.)
- **Close on `session_shutdown`** (alongside `store.clear()` in `src/index.ts`).
- **Reconnect/backoff** on socket drop.
- **Fallback to the current polling path** if the subscription is closed or
  unavailable — correctness must never depend on the event stream.

---

## The one nuance to preserve

Trigger on **`done`** for background peers, exactly as today's wait does:

- `done` = finished but **unseen** (peer's tab is in the background).
- `idle` = finished and **seen**.

For a background peer, the relevant completion signal is `done`. Treat either
`done` or `idle` as completed when inspecting status (same rule the current code
already uses).

---

## Verify before coding (smaller set than the full handoff)

1. **Socket wire framing** — confirm newline-delimited JSON so we can parse
   `pane.agent_status_changed` envelopes. (Reference impl: the `herdr` binary's
   own `wait` command already subscribe-then-matches internally.)
2. **Handshake/auth** on `/Users/tian.zuo/.config/herdr/herdr.sock`
   (`protocol: 16`) — confirm a plain `net.connect` from the extension process
   is accepted.
3. **Runtime tolerance** — confirm a persistent socket + data listener doesn't
   block pi's shutdown or starve the event loop; ensure `session_shutdown`
   closes it reliably.
4. **pane_id stability** — `pane get`/events key on `pane_id`; AGENTS.md notes a
   pane *moved to another workspace gets a new pane id*. Confirm the mapping
   stays valid for the lifetime we care about, or re-resolve via `agent get`.

---

## Definition of done

- A background peer completing flips `pane.agent_status_changed` → `done`; the
  extension resolves `get_agent_result(mode:"wait")` from that event **without**
  spawning a `herdr wait agent-status` subprocess for the common case.
- Result text still comes from the unchanged `pane read` path.
- Peers do not open a subscription; bus drop/unavailable degrades silently to
  the existing polling path with no correctness regression.
- Typechecks (`tsc --noEmit`), lints (biome), and the pure event parser has unit
  tests (mirror the pure-and-tested pattern of `computeSlotPlacement` in
  `src/layout.ts`).

---

## Evidence

- **Dot = `agent_status`.** Same field in `pane get`, `api snapshot`, and
  `pane.agent_status_changed`; enum `idle|working|blocked|done|unknown`.
- **Status event.** `herdr api schema --json`: request method `events.subscribe`
  (`EventsSubscribeParams { subscriptions[] }`); push envelope
  `subscription_event`, kind `pane.agent_status_changed` →
  `{ pane_id, workspace_id, agent_status, agent?, custom_status?, display_agent?,
  title?, state_labels? }`. One-shot wrapper (what the CLI exposes):
  `events.wait` / `pane.wait_for_output`.
- **No long-lived stream via CLI.** `herdr wait output` / `herdr wait
  agent-status` are one-shot blocking; `herdr api` has only `snapshot` + `schema`.
- **Current wait path.** `src/lifecycle.ts`: `waitForAnyAgentStatus` →
  `adapter.waitAgentStatus` (shells `herdr wait agent-status`);
  `waitForCompletionStatus` → `adapter.paneGet`. Adapter in
  `src/herdr-adapter.ts` via `createHerdrAdapter((cmd,args,opts) => pi.exec(...))`.
- **Socket.** `/Users/tian.zuo/.config/herdr/herdr.sock`, `protocol: 16`
  (`herdr status server`).
