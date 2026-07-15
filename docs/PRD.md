# PRD: pi-herdr-agents

**Status:** Implemented (v0.2.0)
**Owner:** Tian
**Last updated:** 2026-07-15

## Problem

Pi's native `Agent` tool runs subagents in-process: they share the caller's process, are invisible except through tool-call logs, and their only "runtime" is whatever CLI/model Pi itself is using. That's fine for short, disposable delegation, but it breaks down for a specific class of work:

- Delegating to a **different CLI or model** than the one driving the caller (e.g. hand a review to Codex while Pi keeps planning, or hand implementation to Cursor).
- Work the user wants to **watch happen live** — a visible terminal, not a collapsed tool-result blob.
- Work that needs **interactive recovery** — a peer hits a login screen or a trust prompt and a human (or the caller) needs to intervene without losing the task.
- Coordinating **several peers in parallel** without them silently colliding on the same files or overlapping in an unreadable pile of terminal panes.

Herdr already provides the primitive this needs: real OS-level terminal panes with a scriptable CLI (`herdr agent start`, `pane run`, `pane read`, `wait agent-status`, ...). What's missing is the orchestration layer that a Pi session can call as an ordinary tool: pick a behavior, pick a runtime, launch it safely, track it, retrieve its output, and clean it up — without the caller having to hand-roll Herdr CLI calls in every session.

## Goal

Give a Pi session five tools — `herdr_launch_agent`, `herdr_get_agent_result`, `herdr_list_agents`, `herdr_steer_agent`, `herdr_stop_agent` — that manage the full lifecycle of a peer coding-agent process running visibly in a Herdr pane, with:

- **Role-guided behavior** (read-only review vs. scoped implementation vs. research, etc.) decoupled from **CLI runtime choice** (Pi, Cursor, Codex, Claude Code, OpenCode, or a custom profile).
- **Safety guarantees** strong enough that an LLM can call these tools autonomously without a human reviewing every launch: no shell injection, no closing panes it doesn't own, no silently losing track of a peer.
- **Enough visibility** that when something goes wrong (login screen, workspace trust prompt, timeout), the caller gets a clear partial result instead of a hang or a silent failure.

## Non-goals

- Replacing Pi's native `Agent` tool. This is an additional delegation mechanism for a specific use case (visible, cross-runtime, long-running, or interactively-recoverable work), not a universal replacement.
- Structured token accounting or context inheritance for peers. Peers are separate processes; the caller can only observe them through Herdr's pane-read/status API, which is coarser than in-process subagent telemetry.
- Auto-installing or configuring the underlying CLIs (`cursor-agent`, `codex`, `claude`, etc.) — the extension assumes they're already on `PATH` if referenced by a profile.
- General-purpose Herdr pane management (arbitrary workspace/tab manipulation, watching non-agent processes, sending raw keystrokes). That's a different, broader tool; this package is scoped to the agent-lifecycle use case.

## Users

The primary "user" of this extension is an **LLM-driven Pi session** running inside Herdr, not a human directly. A human sets up the Herdr session and may intervene when a peer blocks on a login/trust screen, but day-to-day the calling agent decides when to delegate, to whom, and how to consume results. Design decisions favor safety defaults an LLM can't accidentally bypass (e.g., ownership checks before closing a pane) over configurability a human would tune by hand.

## Core concepts

**Role** — a behavior contract: a trusted prompt prefix (read-only vs. can-implement, scope discipline, output format) plus a default CLI profile. Built-in roles: `general`, `scout`, `planner`, `executor`, `reviewer`, `researcher`.

**Profile** — a CLI runtime: a name mapped to an `argv` array (`pi`, `cursor` → `cursor-agent`, `agy`, `codex`, `claude`, `opencode`, or a custom entry). Roles pick a default profile; callers can override it independently of the role.

**Agent record** — the extension's tracked state for one launched peer: opaque `agent_id`, role, profile, live Herdr pane identity (pane/terminal/workspace/tab IDs), status, `seenWorking` flag, ownership flag, and (since the column-fill layout feature) an optional grid placement slot.

## Requirements

### R1 — Launch a role-guided peer (`herdr_launch_agent`)

- Caller supplies a `role` (required; legacy calls default to `general`), an optional `profile` override, and a standalone `prompt` (peers inherit no conversation context, so the prompt must be self-contained).
- The extension resolves role → default profile → argv, starts the process via `herdr agent start`, waits for the pane to report `idle` and produce a readable frame, then submits a role-wrapped prompt containing a unique task marker via `herdr pane run`. The marker must appear in pane output before a status transition counts as task acknowledgement.
- **Background mode** (default): return as soon as the peer is confirmed `working`.
- **Foreground mode**: block until the peer reaches `idle` or `done` (only valid after it has been observed `working` — see R5), then return the transcript.
- Startup blockers (Cursor workspace-trust prompt, Antigravity sign-in) are detected from the pane's initial screen and returned as an immediate `blocked` partial result **without submitting the task** — the prompt is only sent once the pane is confirmed ready for it.

### R2 — Deterministic pane placement (column-fill auto-layout)

- By default, peers auto-arrange into a grid anchored on the caller's pane: 1st peer splits right of the caller; 2nd and 3rd stack downward under it; every 3rd peer starts a new column anchored on the *previous column's top pane* (not its last pane), keeping columns aligned instead of staircasing.
- An explicit `split` param, a `workspace`-targeted launch, or an explicit tab different from the caller's tab opts out of auto-layout for that call.
- If the anchor pane for a slot is no longer live (closed, lost, identity mismatch), the peer falls back to splitting right of the caller's own pane rather than failing the launch.
- Placement failures degrade gracefully — a misplaced-but-working peer is recorded with an error note, not treated as a launch failure.
- Slot numbers persist on the agent record (not a resettable in-memory counter) so numbering survives session restores, and reservation is race-free under concurrent launches in the same turn (see `agents.md` for the concurrency argument).

### R3 — Retrieve results (`herdr_get_agent_result`)

- `poll` mode returns current status immediately; `wait` mode blocks (with timeout) until the peer reaches a terminal state.
- Completion is reported **only** when the peer has been observed `working` and then reaches `idle` or `done` — this rules out reporting "done" for a peer that never actually started (see R5).

### R4 — Steer and stop live peers

- `herdr_steer_agent` sends a follow-up prompt to a tracked, live peer via `herdr pane run`. Rejects oversized (>100,000 chars) or NUL-byte-containing messages, and refuses to steer a peer that's marked `stopped` or `lost`. When the initial assignment is still pending after a startup blocker, steering resumes the cached original role-wrapped assignment; after restore, the supplied message is role-wrapped as a replacement because prompt text is not persisted. Attempted-but-unacknowledged delivery is never retried implicitly; `force_resubmit` is required and uses a fresh marker. Steering a completed writer reacquires its cwd lease before sending.
- `herdr_stop_agent` closes an **owned** pane only after revalidating that its pane/terminal/workspace/tab identity still matches the tracked record. A missing or mismatched pane is marked `lost`, never force-closed on a stale identity — the tool must never close a pane it doesn't currently, verifiably own.

### R5 — Correct completion semantics

- A record is "complete" only if `seenWorking` is `true` **and** current status is `idle` or `done`. This prevents a peer that starts already `idle` (never actually ran) from being mistaken for one that finished. `seenWorking` is set the moment the peer is observed `working`, or when it goes straight to `done` immediately after prompt submission.

### R6 — Snapshot persistence and restore

- Durable state transitions persist a prompt-redacted fleet snapshot via `pi.appendEntry("herdr-agents:snapshot", ...)`; no-op polling does not append duplicate snapshots.
- On `session_start`/`session_tree`, the extension restores the latest snapshot from the active branch and revalidates every live record against Herdr (pane/terminal/workspace/tab match). Mismatches are marked `lost`; transient adapter failures are marked `unavailable` and remain retryable.

### R7 — Trust and injection safety

- Profiles use argv arrays exclusively — no shell string construction, ever.
- Project-level custom profiles/roles (`.pi/herdr-agents.json`) are ignored unless `ctx.isProjectTrusted()` — an untrusted project cannot smuggle in a malicious CLI argv or role prompt.
- Role prompts and task text are length-bounded and NUL-byte-rejecting.
- Task text is rejected if it contains the reserved wrapper delimiters (`</assignment>`, `<herdr-peer-role`) that the extension uses to fence trusted role instructions from untrusted task content — this closes a prompt-injection path where a task string could forge a fake closing tag and inject fabricated instructions into the peer's context.

### R8 — Writer isolation and fleet recovery

- Roles declare `writeAccess` as `none` or `workspace`. Write-capable roles hold an exclusive lease for their canonical cwd while active; parallel writers require separate Git worktrees.
- `herdr_list_agents` exposes tracked ids and operational state so the caller can recover from lost conversational context.
- If `agent start` fails after creating a pane, the extension attempts to reconcile it by a cross-process-unique Herdr name, validates available cwd/topology metadata, and returns a manageable record.

### R9 — Parent-agent guidance

- Inside a Herdr session (`HERDR_ENV=1`), every caller turn gets a `<herdr-peer-delegation>` system-prompt block explaining roles, profiles, foreground/background semantics, and the rule against launching overlapping write-capable peers on the same files. This guidance is never injected outside Herdr sessions.

## Success metrics

This is a developer-tooling extension with no analytics; "success" is verified structurally, not measured in production telemetry:

- All five tools are covered by unit tests against a `FakeHerdrAdapter` (87 tests as of this writing) exercising the state machine — startup blockers, fast-completion races, timeouts, aborts, ownership checks, layout placement, and concurrent launches — without requiring a live Herdr runtime in CI.
- `npm run typecheck`, `npm run lint`, and `npm test` all pass clean before any change is considered done (enforced by project convention in `CLAUDE.md`, not by CI in this repo).
- No known path exists for an untrusted project or an untrusted task string to escalate into shell execution or fabricated peer instructions (R7).

## Open questions / future work

- **No structured session API for peers.** Transcript retrieval is `pane read --source recent-unwrapped` — text scraping, not a structured event stream. A future Herdr API upgrade could let this extension read peer tool calls/results directly instead of terminal text.
- **No token accounting across peers.** A caller can't currently see how much a peer run "cost" in tokens; that data doesn't cross the process boundary.
- **Layout is grid-only.** The column-fill algorithm is one opinionated layout; there's no way to request a different arrangement (e.g., a horizontal row, or manual per-launch coordinates) short of opting out entirely with `split`.
- **No graphical peer-fleet dashboard.** `herdr_list_agents` exposes the fleet to the caller, but there is no dedicated interactive viewer, dependency graph, or token/cost dashboard.
