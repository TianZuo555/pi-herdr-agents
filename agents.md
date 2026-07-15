# agents.md

Architectural decisions and Herdr API quirks worth remembering. Update this file after non-trivial changes; skip if the point is already recorded.

## Column-fill auto-layout (`src/layout.ts`)

`herdr_launch_agent` places peer panes in a deterministic grid by default: slot 1 splits right of the caller's own pane, slots 2-3 stack down under the previous slot in the column, and every 3rd slot starts a new column anchored on the *previous column's top slot* (not its last slot) so columns stay vertically aligned instead of staircasing. `computeSlotPlacement` in `src/layout.ts` is the pure math; keep it pure and unit-test it directly rather than through `launchAgent`.

**Herdr has no "start into this pane" primitive.** `agent.start` (`herdr agent start`) can only split `right`/`down` from the *caller's current pane* — it cannot target an arbitrary existing peer pane. Deterministic placement therefore requires two Herdr calls: `agent.start` (creates the pane wherever Herdr defaults it) immediately followed by `pane.move` (`herdr pane move <pane_id> --tab <tab_id> --split <dir> --target-pane <id>`), which relocates an *existing* pane to split off an explicit target. This is why `launchAgent` always passes a throwaway `split: "right"` to `agentStart` when auto-layout is active — the real position comes from the `paneMove` call right after.

**Slot reservation is race-free without locks** because it exploits the fact that a synchronous JS stretch with no `await` cannot be interleaved by another task. `AgentStore.reserveLayoutSlot(tabId)` only reads current occupancy (max existing `layoutSlot` for that tab among non-stopped/non-lost records); the caller must combine the read with the claiming `store.upsert(...)` in one synchronous stretch (compute slot → build record → upsert, no `await` in between). Reservation happens *after* `agentStart`'s `await` (a real I/O round-trip, where true concurrency exists) but the read-then-claim itself is atomic relative to any other concurrent `launchAgent` call's read-then-claim, because Node never preempts a synchronous function body. Do not split "reserve" and "publish" across an `await` boundary, or two concurrent launches can compute the same next slot.

**Layout state lives on `AgentRecord`** (`layoutSlot?`, `layoutTabId?`) rather than a resettable in-memory counter, so it survives `session_start`/`session_tree` restores — a fresh session continues numbering from the persisted high-water mark instead of colliding with already-placed live peers.

**Anchor-lost fallback always targets the caller's own pane with `split: "right"`**, regardless of what direction the slot's algorithm would have used. This is a deliberate simplification: recomputing a fallback within the grid (e.g., re-anchoring to the caller with the slot's original "down" direction) would produce a pane visually detached from the intended column anyway, so there is no benefit to preserving the original direction once the anchor is gone.

**Auto-layout is skipped** when the caller passes an explicit `split` (deliberate override) or targets a different `workspace` (the destination tab isn't known ahead of `agentStart` resolving, so there's no grid to join). Both cases fall through to the pre-layout behavior: `agentStart` gets `params.split ?? "right"` directly, no `paneMove` call, `layoutSlot`/`layoutTabId` stay `undefined`.

**A failed `paneMove` degrades gracefully** rather than aborting the launch — caught locally, recorded into `record.error` as `"Layout placement failed: ..."`, and the launch proceeds into the normal startup/completion flow. A misplaced-but-working peer is preferable to a failed launch.
