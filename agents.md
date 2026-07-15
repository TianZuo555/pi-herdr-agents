# agents.md

Architectural decisions and Herdr API quirks worth remembering. Update this file after non-trivial changes; skip if the point is already recorded.

## Column-fill auto-layout (`src/layout.ts`)

`herdr_launch_agent` places peer panes in a deterministic grid by default: slot 1 splits right of the caller's own pane, slots 2-3 stack down under the previous slot in the column, and every 3rd slot starts a new column anchored on the *previous column's top slot* (not its last slot) so columns stay vertically aligned instead of staircasing. `computeSlotPlacement` in `src/layout.ts` is the pure math; keep it pure and unit-test it directly rather than through `launchAgent`.

**Herdr has no "start into this pane" primitive.** `agent.start` (`herdr agent start`) can only split `right`/`down` from the *caller's current pane* — it cannot target an arbitrary existing peer pane. Deterministic placement therefore requires two Herdr calls: `agent.start` (creates the pane wherever Herdr defaults it) immediately followed by `pane.move` (`herdr pane move <pane_id> --tab <tab_id> --split <dir> --target-pane <id>`), which relocates an *existing* pane to split off an explicit target. This is why `launchAgent` always passes a throwaway `split: "right"` to `agentStart` when auto-layout is active — the real position comes from the `paneMove` call right after.

**Slot reservation is race-free without locks** because it exploits the fact that a synchronous JS stretch with no `await` cannot be interleaved by another task. `AgentStore.reserveLayoutSlot(tabId)` only reads current occupancy (max existing `layoutSlot` for that tab among non-stopped/non-lost records); the caller must combine the read with the claiming `store.upsert(...)` in one synchronous stretch (compute slot → build record → upsert, no `await` in between). Reservation happens *after* `agentStart`'s `await` (a real I/O round-trip, where true concurrency exists) but the read-then-claim itself is atomic relative to any other concurrent `launchAgent` call's read-then-claim, because Node never preempts a synchronous function body. Do not split "reserve" and "publish" across an `await` boundary, or two concurrent launches can compute the same next slot.

**Layout state lives on `AgentRecord`** (`layoutSlot?`, `layoutTabId?`) rather than a resettable in-memory counter, so it survives `session_start`/`session_tree` restores — a fresh session continues numbering from the persisted high-water mark instead of colliding with already-placed live peers.

**Anchor-lost fallback always targets the caller's own pane with `split: "right"`**, regardless of what direction the slot's algorithm would have used. This is a deliberate simplification: recomputing a fallback within the grid (e.g., re-anchoring to the caller with the slot's original "down" direction) would produce a pane visually detached from the intended column anyway, so there is no benefit to preserving the original direction once the anchor is gone.

**Auto-layout is skipped** when the caller passes an explicit `split` (deliberate override), targets a different `workspace`, or explicitly targets a tab other than the caller's current tab. The caller pane cannot be a valid slot-1 anchor in another tab. These cases fall through to the raw start placement: no `paneMove` call, and `layoutSlot`/`layoutTabId` stay `undefined`.

**A failed `paneMove` degrades gracefully** rather than aborting the launch — caught locally, recorded into `record.error` as `"Layout placement failed: ..."`, and the launch proceeds into the normal startup/completion flow. A misplaced-but-working peer is preferable to a failed launch.

## Assignment delivery and persistence

Initial task delivery is an explicit state machine on `AgentRecord.submissionState`: `pending` → `submitted` → `acknowledged`. Every submission attempt ends with a fresh random `[herdr-task-marker:...]`. A `working`/`done` transition only counts after that marker appears in `recent-unwrapped` output; otherwise CLI initialization or a stale attempt could be mistaken for task execution. Keep the status waiter armed before `paneRun` so fast tasks are still observed. Once `paneRun` has been attempted, marker failure leaves the record `submitted` rather than rolling back to `pending`; only explicit `force_resubmit` may retry because automatic retry could duplicate work.

The complete role-wrapped task is cached only in `AgentStore.pendingAssignments` for same-session blocker recovery. It is cleared after acknowledgement or stop and is never copied into snapshots. After a restore, steering a pending record wraps the supplied message as a replacement task because the original text is intentionally unavailable.

`AgentStore.mutate` uses deep equality and persists only actual state changes. Do not replace this with unconditional snapshot writes: `getAgentResult(..., mode: "wait")` polls frequently, and unconditional writes multiply full-fleet snapshots. Legacy snapshot `prompt` fields are accepted for compatibility but immediately blanked.

Missing/mismatched panes are confirmed `lost`; adapter/transport failures are `unavailable`. Never convert a transient validation exception into `lost`, because `validateLiveRecord` deliberately retries unavailable records later.

## Workspace writer leases

Roles declare `writeAccess: "none" | "workspace"`. `general` and `executor` are workspace writers; built-in reconnaissance/planning/review/research roles are strictly read-only. Custom roles default to `workspace` unless explicitly declared read-only.

`AgentStore.reserveWriteLease` runs synchronously before the first `agentStart` await, so concurrent write-capable launches for the same canonical cwd cannot both pass. The temporary reservation is replaced by the persisted `AgentRecord` after start. A live writer record continues to hold the lease through blocked, timeout, aborted, error, unavailable, and unknown states; only valid completion, stop, or confirmed loss releases it. Steering a completed writer synchronously reacquires the lease and resets completion before sending the follow-up. Parallel writers must use distinct Git worktree paths.

If `agentStart` throws after pane creation, `launchAgent` reconciles by the cross-process-unique Herdr agent name through `agentGet`, validating any available name/cwd/topology metadata before adoption. `makeHerdrAgentName` must retain the random portion of `agentId`; a process-local counter alone collides after extension reload. Preserve this lookup path whenever the start adapter changes, otherwise failed starts can create untracked or misidentified panes.
