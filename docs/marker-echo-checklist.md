# Marker-echo validation checklist

`src/lifecycle.ts` gates every launch on `waitForSubmissionEcho`: after
`herdr pane run <assignment>`, it waits for the line
`[herdr-task-marker:<id>]` to appear in the pane's `recent-unwrapped` output
before it trusts a `working`/`done` transition as acknowledgement of the task.

This closes a false-**positive** (attributing CLI-init status noise to the
task) but opens a false-**negative**: if a CLI does **not** echo submitted input
verbatim — because it renders the prompt in a boxed/reflowed widget, truncates
long input, or strips bracketed tokens — the marker never appears, and
`launchAgent` times out at `startupTimeoutMs` even though the task was accepted
and is running.

The `FakeHerdrAdapter` echoes on demand, so unit tests cannot catch this. It
depends on real TUI rendering and must be validated per profile with a live
Herdr runtime.

## How to run

From **inside a Herdr pane** (`HERDR_ENV=1`), with the target CLIs on `PATH`:

```sh
node scripts/probe-marker-echo.ts                          # all built-in profiles
node scripts/probe-marker-echo.ts --profile cursor         # one profile
node scripts/probe-marker-echo.ts --profile codex --case wrapped --keep
```

Flags: `--profile` / `--case` (repeatable), `--timeout <ms>` (default 120000),
`--interval <ms>` (default 500), `--cwd <path>`, `--keep` (leave panes open for
inspection instead of auto-closing). Each probe spawns a real agent and can take
tens of seconds; expect a full sweep to run for several minutes. Panes are
closed on completion unless `--keep`; an interrupted run may leak a pane named
`echo-<profile>-<case>-<hex>` — close it with `herdr pane close <pane_id>`.

Outcomes: **PASS** (marker echoed), **FAIL** (no echo within the timeout — the
risk case), **BLOCKED** (startup trust/login screen; resolve and re-run),
**ERROR** (start/transport failure — e.g. the CLI is not installed).

## Results

Record the date, Herdr version (`herdr --version`), and CLI versions, then paste
the probe's JSON summary. Re-run when any CLI is upgraded — echo behaviour is a
property of the CLI's renderer, not of this extension.

| Profile | CLI | Case | Outcome | Echo latency | Status @ echo | Notes |
|---------|-----|------|---------|--------------|---------------|-------|
| pi | `pi` | bare | PASS | ~5.1s | working | echoed during the run |
| pi | `pi` | wrapped | PASS | ~57.7s | idle | ⚠️ only echoed at end-of-run, not during `working` — see note |
| pi | `pi` | long | PASS | ~0.5s | working | long single line echoed intact |
| cursor | `cursor-agent` | bare | _todo_ | | | |
| cursor | `cursor-agent` | wrapped | _todo_ | | | |
| cursor | `cursor-agent` | long | _todo_ | | | |
| codex | `codex` | bare | _todo_ | | | |
| codex | `codex` | wrapped | _todo_ | | | |
| codex | `codex` | long | _todo_ | | | |
| claude | `claude` | bare | _todo_ | | | |
| claude | `claude` | wrapped | _todo_ | | | |
| claude | `claude` | long | _todo_ | | | |
| agy | `agy` | bare | _todo_ | | | |
| agy | `agy` | wrapped | _todo_ | | | |
| agy | `agy` | long | _todo_ | | | |
| opencode | `opencode` | bare | _todo_ | | | |
| opencode | `opencode` | wrapped | _todo_ | | | |
| opencode | `opencode` | long | _todo_ | | | |

### Observation (2026-07-15, `pi` profile only, partial sweep)

First live run against the `pi` profile: all three cases PASS, but the
production-shaped `wrapped` case echoed the marker only **after** the run
finished (~57s, at `status=idle`), while `bare`/`long` echoed within seconds
during `working`. Interpretation: `pi` renders/echoes the *submitted* prompt
reliably, but a longer wrapped prompt can be slow to surface in
`recent-unwrapped`. This is within the 120s default startup timeout, so it does
not currently break launches — but it narrows the margin, and a shorter
`startup_timeout_ms` could turn an accepted task into a false timeout. cursor /
codex / claude / agy are unverified.

## What to do about FAIL / high-latency profiles

If a profile FAILs (or echoes only after a long delay that risks the timeout):

1. **Confirm** it's an echo property, not a slow model, by re-running with
   `--keep` and reading the pane manually (`herdr pane read <pane_id>
   --source recent-unwrapped --lines 200`).
2. **Soft-acknowledge fallback (recommended fix):** in `confirmPostSubmitStartup`,
   if the marker has not appeared but the pane has transitioned to `working`,
   treat it as acknowledged with a recorded caveat rather than blocking on the
   echo until timeout. The marker stays authoritative when present; its absence
   degrades to the status signal instead of failing the launch.
3. **Per-profile opt-out:** skip `waitForSubmissionEcho` for profiles proven not
   to echo, falling back to the pre-marker status-only path for those.
4. **Raise `startup_timeout_ms`** as a stopgap for slow-but-present echo — but
   this only masks latency, it does not fix a genuine no-echo profile.

Whichever path is chosen, keep this checklist as the source of truth for which
profiles are echo-verified.
