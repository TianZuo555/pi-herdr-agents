# pi-herdr-agents

Pi extension package that launches **visible, role-guided peer coding agents** in Herdr panes. Each agent is an independent CLI process (Pi, Cursor, Codex, Claude Code, OpenCode, Antigravity, or a custom profile) running in its own terminal pane, giving a Pi session a way to delegate to a different runtime, watch work happen live, and recover interactively when a peer blocks on a login or trust screen — complementary to Pi's native in-process `Agent` tool, not a replacement for it.

See [`docs/PRD.md`](docs/PRD.md) for the problem statement, requirements, and open questions behind this design.

## Architecture

```
Pi session (caller pane)
  └─ herdr_launch_agent
        └─ herdr agent start … -- <profile argv>
              └─ new Herdr pane (peer agent TUI)
                    └─ herdr pane run <prompt>
```

- **Roles** define behavior instructions and a default profile.
- **Profiles** map a short name to a safe `argv` array (never shell strings).
- **Parent guidance** is appended through `before_agent_start`, teaching the caller when and how to delegate safely.
- **HerdrAdapter** wraps `pi.exec("herdr", argv, …)` and parses Herdr output.
- **AgentStore** keeps in-memory records and appends a prompt-redacted snapshot only when durable state actually changes.
- **Lifecycle** orchestrates: wait for idle → submit a marked assignment → confirm the marker was accepted → confirm `working` → (foreground) wait for `idle`/`done` → read transcript.
- **Write leases** serialize write-capable roles per canonical working directory; separate Git worktrees remain independently writable.

On `session_start` / `session_tree`, the extension restores the latest snapshot from the active branch and revalidates live panes (pane + terminal + workspace + tab IDs). Missing or mismatched panes are marked **lost**; transient Herdr failures are marked **unavailable** and retried later.

## Supported agents (built-in profiles)

| Profile | Command |
|---------|---------|
| `pi` | `pi` |
| `cursor` | `cursor-agent` |
| `agy` | `agy` |
| `codex` | `codex` |
| `claude` | `claude` |
| `opencode` | `opencode` |

Custom profiles and roles merge from:

1. Built-in defaults
2. Global `~/.pi/agent/herdr-agents.json` (or `$PI_CODING_AGENT_DIR/herdr-agents.json`)
3. Project `.pi/herdr-agents.json` — **only when the project is trusted**

```json
{
  "profiles": {
    "my-fork": {
      "argv": ["pi", "--some-flag"],
      "description": "Pi with a custom flag"
    }
  },
  "roles": {
    "triage": {
      "profile": "my-fork",
      "description": "Read-only incident triage",
      "prompt": "Work read-only. Identify the failure boundary and return evidence with exact paths.",
      "writeAccess": "none"
    }
  }
}
```

## Installation

**From npm (when published):**

```bash
pi install npm:pi-herdr-agents
pi update --all
```

**Local development:**

```bash
pi install /path/to/pi-herdr-agents
# or add to settings.json "extensions": ["/path/to/pi-herdr-agents/src/index.ts"]
```

Requires running **inside Herdr** (`HERDR_ENV=1`) with `HERDR_WORKSPACE_ID`, `HERDR_TAB_ID`, and `HERDR_PANE_ID` set.

## Built-in roles

| Role | Default profile | Write access | Behavior |
|------|-----------------|--------------|----------|
| `general` | `pi` | Workspace-exclusive | Broad self-contained technical work |
| `scout` | `pi` | None | Read-only codebase reconnaissance |
| `planner` | `cursor` | None | Read-only executor-ready planning |
| `executor` | `cursor` | Workspace-exclusive | Scoped implementation and verification |
| `reviewer` | `codex` | None | Read-only correctness/security review |
| `researcher` | `agy` | None | Read-only evidence-backed research |

The role is prepended to the peer assignment. A `profile` override changes the CLI runtime without changing the role or its write access. Custom roles default conservatively to `writeAccess: "workspace"`; declare `"none"` for read-only roles.

## Parent-agent guidance

On every caller turn, the extension appends a marked system-prompt section explaining the roles, foreground/background modes, lifecycle tools, context handoff requirements, cleanup, and workspace write leases. Tool prompt snippets and guidelines provide the same guidance when Pi builds its normal tool instructions.

## Tools

### `herdr_launch_agent`

Launch a peer agent in a new pane. By default, panes auto-arrange into a column-fill grid in the caller's tab: the 1st peer splits right of the caller, the 2nd and 3rd stack downward under it, the 4th starts a new column anchored on the 1st peer's pane (splitting right), and so on — every 3rd peer opens a new column, keeping columns vertically aligned.

```
[Caller][P1]  [P4]
        [P2]  [P5]
        [P3]  [P6]
```

Passing an explicit `split`, targeting a different `workspace`, or explicitly targeting another tab opts out of auto-layout for that call and falls back to the raw placement below. If the pane a new peer would anchor on is no longer live (closed, lost, or identity mismatch), the peer falls back to splitting right of the caller's own pane rather than failing the launch.

| Parameter | Description |
|-----------|-------------|
| `role` | Required behavior role; legacy calls default to `general` |
| `profile` | Optional CLI profile override; omit to use the role default |
| `prompt` | Complete standalone task text (wrapped with the role prompt and sent after the CLI is ready) |
| `description` | Optional short label stored on the record |
| `mode` | `background` (default) or `foreground` |
| `cwd` | Working directory (default: Pi project cwd) |
| `workspace` / `tab` | Launch topology (mutually exclusive); setting `workspace` or a tab other than the caller's opts out of auto-layout |
| `split` | `right` or `down`; setting this opts out of auto-layout for this call |
| `focus` | Focus new pane (default `false`) |
| `startup_timeout_ms` | State transition timeout |
| `completion_timeout_ms` | Foreground completion timeout |
| `transcript_lines` | Lines for `recent-unwrapped` read |

**Example (background):**

```json
{
  "role": "reviewer",
  "prompt": "Review the current diff and list only actionable findings with exact file and line references.",
  "mode": "background",
  "description": "independent regression review"
}
```

Returns an extension `agent_id` after the peer reaches `working`.

### `herdr_get_agent_result`

| Parameter | Description |
|-----------|-------------|
| `agent_id` | ID from launch |
| `mode` | `poll` (default) or `wait` |
| `timeout_ms` | Wait timeout |
| `transcript_lines` | Transcript size |

Completion is reported only when `seen_working` is true **and** status is `idle` or `done`.

### `herdr_list_agents`

Lists tracked peers with their role, profile, lifecycle status, assignment-delivery state, write access, pane, cwd, and latest error. Use it to recover a forgotten `agent_id`.

### `herdr_steer_agent`

Send a follow-up via `herdr pane run`. Requires a live, tracked record with matching pane identity. If a startup blocker prevented the initial assignment from being sent, steering after the blocker is cleared resubmits the cached, role-wrapped original assignment. After a session restore, where prompt text is intentionally unavailable, the steer message becomes a role-wrapped replacement assignment. If delivery was attempted but its marker was never observed, steering refuses to retry automatically; inspect the pane first, then set `force_resubmit: true` only when the risk of duplicate work is acceptable. Completed write-capable peers reacquire their workspace lease before a follow-up starts.

### `herdr_stop_agent`

Close an **owned** pane after identity revalidation. Missing or mismatched panes become `lost` — no arbitrary closure.

## Lifecycle semantics

1. Require Herdr caller context (`HERDR_ENV=1`, tab/pane/workspace env).
2. Resolve the role and its default profile (or an explicit profile override).
3. `herdr agent start <name> … -- <argv…>` → store opaque IDs from JSON.
4. Wait for `idle` and a readable TUI frame.
5. Wrap the standalone task with trusted role instructions and a unique non-secret marker, then submit it via `herdr pane run`.
6. Confirm the marker appears in the peer transcript, then wait until `working` (`seen_working = true`). This prevents unrelated CLI initialization transitions from masquerading as task acceptance.
7. **Background:** return `agent_id`.
8. **Foreground:** wait until `idle` or `done` (only after `seen_working`), then return transcript.
9. Startup trust/login screens (including Cursor workspace trust and Antigravity sign-in) return a `blocked` partial result without submitting the task. Clear the prompt in the visible pane, then call `herdr_steer_agent`; the original role-wrapped assignment is resumed automatically in the same session.
10. `blocked` → immediate partial result; pane preserved.
11. Timeout / abort → partial result with `agent_id`; pane **not** auto-closed. If `submission=\"submitted\"`, delivery is uncertain and automatic retry is intentionally disabled.

## Safety model

- argv arrays only — no shell interpolation.
- Initial task prompt text is kept only in memory for same-session blocker recovery and is not copied into fleet snapshots. Snapshots still contain operational metadata such as cwd, descriptions, and errors.
- Write-capable roles hold an exclusive lease for their canonical cwd until completion, stop, or confirmed pane loss.
- Project profiles and role prompts are ignored when `ctx.isProjectTrusted()` is false.
- Role prompts are bounded and reject NUL bytes.
- Failed starts are reconciled by a cross-process-unique Herdr name and validated against available name/cwd/topology metadata before the pane is adopted.
- Stop closes only extension-tracked panes with verified identity.
- Does **not** override Pi's native `Agent` tool.

## Skills vs native subagents vs Herdr peer agents

| Mechanism | What it is |
|-----------|------------|
| **Skills** | Reusable instruction bundles Pi (or other CLIs) load from skill paths. Launching `pi` in Herdr uses **that CLI's** normal skills — not automatic translation of Pi custom subagent definitions. |
| **Native Pi subagents** | In-process `AgentSession` children managed by extensions like `pi-subagents`; share Pi session machinery, token accounting, and custom agent YAML. |
| **Herdr peer agents** | Separate OS processes in visible panes; observed via Herdr CLI and transcript scraping. |

## Limitations

- Transcript via `pane read --source recent-unwrapped` (scraping, not structured API).
- No native token accounting or context inheritance from the caller.
- No graphical fleet dashboard; `herdr_list_agents` provides a text inventory.
- Requires Herdr runtime and agent detection for status fields.

## Development

```bash
npm install
npm run typecheck
npm run lint
npm test
```

## License

MIT
