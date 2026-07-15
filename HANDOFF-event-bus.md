# Handoff: In-process Herdr event bus (replace polling with event-driven results)

**Status:** Proposed, not started. Pre-implementation unknowns must be resolved first (see "Verify before coding").
**Owner:** next session / agent picking this up.
**Related:** `AGENTS.md` (layout & persistence notes), `PRD.md`, `src/lifecycle.ts`, `src/store.ts`, `src/index.ts`.

---

## TL;DR

Today `herdr_get_agent_result(mode:"wait")` is a **pull** model: it blocks on `herdr wait agent-status` / polls `pane get`, then reads the rendered transcript with `pane read`. Herdr's socket protocol already exposes a real **push** model — `events.subscribe` streams `pane.agent_status_changed` and `pane.output_matched` (which carries the full read text). The CLI does **not** expose a long-lived stream (`herdr wait …` is one-shot; `herdr api` only has `snapshot`/`schema`), so to use it we must speak the socket protocol directly.

**Decision:** add an in-process `HerdrEventBus` that lives for the session in the extension's module scope (next to `AgentStore`), subscribes to the two pane events, and feeds them straight into `AgentStore.mutate` so `getAgentResult` returns instantly with the pushed status/output instead of polling.

---

## Background / why

Investigation this session (see "Evidence") answered three questions:

1. **Can a peer *send* its result back (push)?** No first-class primitive. `pane run`/`agent send` type text into a pane (becomes a new prompt, not a result); `pane report-agent --message` publishes public status. No directed agent→agent message bus.
2. **Is `get_agent_result` just "wait for render"?** Yes — pull model: wait for status flip → read pane.
3. **Can we listen instead of poll?** Yes, at the protocol level (`events.subscribe`). No, via the CLI.

So the only way to get push delivery is a direct socket subscription. The question this handoff answers: **where does that listener live?**

---

## The decision: listener lives in-process, in the extension module scope

`src/index.ts`'s default export is invoked **once at session load** and runs for the whole session; `AgentStore` is already a session-scoped singleton in that closure, cleared on `session_shutdown`. A persistent socket connection is another such singleton — **no separate daemon**.

| | Today (per-wait) | Proposed (event bus) |
|---|---|---|
| Owner | `herdr wait …` subprocess via `pi.exec` | one `net.connect` socket in module scope |
| Lifetime | one wait → dies on first match | session load → `session_shutdown` |
| Shares memory with `AgentStore` | no | **yes** — events mutate records directly |
| Runs in | a child process each call | the parent pi process |

Payoff: an event flips `record.agentStatus = "done"` and stashes the pushed `PaneReadResult.text` the instant it arrives; `getAgentResult` returns without polling.

---

## Implementation plan

### 1. New file `src/event-bus.ts`

A lazily-opened, single-connection subscriber.

- `openHerdrEventBus(socketPath): HerdrEventBus` — `net.connect` to the socket, send `events.subscribe` with `subscriptions: [ {type:"pane.agent_status_changed"}, {type:"pane.output_matched"} ]`, parse newline-delimited `subscription_event` envelopes.
- Dispatch typed events to a registered handler. Map `pane_id` → `agentId` via the store (records carry `identity.paneId`).
- `close()` — destroy socket, no-op if not open. Idempotent.
- Reconnect/backoff on drop (the session outlives any single connection).
- Pure parser exported separately so it can be unit-tested without a socket (mirror how `computeSlotPlacement` in `src/layout.ts` is kept pure & tested directly).

### 2. Wire into `src/index.ts`

- Construct the bus once in the default export, next to `store`/`adapter`, and give it a handler that calls `store.mutate(agentId, r => { … })`.
- **Gate to parent only:** open **lazily on first `launchAgent` call in this process**, not at module load. Only the orchestrator parent launches peers, so peers (which also load this extension) never open a bus. (Alternative heuristic: the parent is the pane whose system prompt does NOT contain `<herdr-peer-delegation>` — see `before_agent_start` in `index.ts`.)
- Close in the existing `session_shutdown` hook (`store.clear()` is already there).

### 3. Feed events into `AgentStore` (`src/store.ts`)

`AgentStore.mutate(id, update)` already does deep-equality diffing and persists only on real change (it calls `persist()` → `appendEntry`). On a `pane.agent_status_changed` event for a known pane:

```ts
store.mutate(agentId, (r) => {
  r.agentStatus = event.agent_status;            // idle|working|blocked|done|unknown
  if (event.agent_status === "working") r.seenWorking = true;
  // optionally stash event.custom_status / title / display_agent
});
```

On `pane.output_matched`, cache `event.read.text` on the record (new optional field) so `getAgentResult` can return pushed output without a `pane read` round-trip.

### 4. Make `getAgentResult` event-aware (`src/lifecycle.ts`)

Today `waitForCompletionStatus` does `adapter.paneGet` + `waitForAnyAgentStatus` (blocking `herdr wait agent-status`). With the bus, the record is already updated by the time the caller asks — so `getAgentResult(mode:"wait")` can resolve from store state the moment an event lands, instead of spawning a wait subprocess. Keep the polling path as a **fallback** if the bus is closed/unavailable (e.g. socket dropped and reconnecting), so correctness never depends on the bus.

---

## Verify before coding (do not skip)

These are real unknowns; resolve each with a quick probe before writing production code:

1. **Socket wire framing.** Confirm the socket speaks newline-delimited JSON (vs. length-prefixed / JSON-RPC batch). Probe: `herdr api schema` has no transport section — connect to `/Users/tian.zuo/.config/herdr/herdr.sock` and send an `events.subscribe`, inspect raw bytes. The `herdr` binary itself is the reference implementation; consider reading how its `wait` command frames the request (since `herdr wait` already uses subscribe-then-match internally).
2. **Handshake / auth on the socket.** Does the first message need a hello/protocol-version (schema says `protocol: 16`)? Is access restricted to the same uid? Confirm a plain `net.connect` from the extension process is accepted.
3. **Runtime tolerance for a persistent handle.** The extension today does only request/response via `pi.exec`. Confirm an open socket + data listener doesn't block pi's shutdown or starve the event loop. (Expected fine — pi is an interactive, long-lived process.) Ensure `session_shutdown` reliably closes it so it can't block exit.
4. **pane_id ↔ agentId mapping robustness.** Events key on `pane_id`; `AgentRecord.identity.paneId` is the join. Confirm pane IDs are stable for the lifetime we care about (AGENTS.md: a pane moved to another workspace gets a *new* pane id — handle that, or rely on `agent get` re-resolution).
5. **`output_matched` requires a match expression.** Subscribing to "all output" may need a pattern; decide what to match (or whether `agent_status_changed` alone is enough and we keep `pane read` for text).

---

## Alternatives considered (and rejected)

- **Detached helper process** writing events to a file/pipe: isolated, but re-introduces IPC for delivery back to the agent — an event-triggered poll. More lifecycle/cleanup surface, no payoff over in-process. Rejected.
- **`pane run` the result back into the parent pane:** the peer (or a helper) types the result into the parent's prompt. Turns the result into a new user turn; fragile and semantically wrong. Rejected.
- **`report-agent --message`:** publish status+message readable via snapshot. Public, not directed; still pull. Could complement the bus but doesn't replace it.

---

## Evidence (from this session's investigation)

- **Protocol has streaming subscriptions.** `herdr api schema --json`:
  - request method **`events.subscribe`** ← `EventsSubscribeParams { subscriptions: Subscription[] }`
  - one-shot (what the CLI wraps): **`events.wait`** (`EventsWaitParams`), **`pane.wait_for_output`** (`PaneWaitForOutputParams`)
  - push envelope **`subscription_event`** (`SubscriptionEventEnvelope`), kinds:
    - `pane.agent_status_changed` → `{ pane_id, workspace_id, agent_status, agent?, custom_status?, display_agent?, title?, state_labels? }`
    - `pane.output_matched` → `{ pane_id, matched_line, read: PaneReadResult{ text, revision, source, format, … } }`
    - `pane.scroll_changed`
- **CLI exposes no long-lived stream.** `herdr wait output` / `herdr wait agent-status` are one-shot blocking; `herdr api` has only `snapshot` + `schema`.
- **Socket:** `/Users/tian.zuo/.config/herdr/herdr.sock`, `protocol: 16` (`herdr status server`).
- **Extension is session-scoped, in-process.** `src/index.ts` default export invoked once; `session_start`/`session_tree` → `store.restoreFromBranch(...)`; `session_shutdown` → `store.clear()`. `AgentStore` is a closure singleton shared by all tool calls.
- **Current wait path.** `src/lifecycle.ts`: `waitForAnyAgentStatus` → `adapter.waitAgentStatus` (shells `herdr wait agent-status`); `waitForCompletionStatus` → `adapter.paneGet` polling. Adapter built in `src/herdr-adapter.ts` via `createHerdrAdapter((cmd,args,opts) => pi.exec(...))`.
- **Store API.** `src/store.ts`: `AgentStore.mutate(id, update)` deep-equals and persists only on change; `AgentRecord` (`src/types.ts`) carries `identity.paneId`, `agentStatus`, `recordStatus`, `seenWorking`.
- **No prior long-lived background task** in this codebase — the bus would be the first. AGENTS.md notes `getAgentResult(…, mode:"wait")` "polls frequently" and `mutate` "persists only actual state changes."

---

## Definition of done

- `getAgentResult(mode:"wait")` on a background peer resolves from a pushed `pane.agent_status_changed` event, no `herdr wait` subprocess spawned for the common case.
- Peers (which load the same extension) do **not** open a bus.
- Bus drop/reconnect and "bus unavailable" degrade silently to the existing polling path; no correctness regression.
- New code typechecks (`just typecheck`/`tsc --noEmit`), lints (`just lint`/biome), and the pure parser has unit tests.
