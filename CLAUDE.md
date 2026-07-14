# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Pi extension package (`pi-herdr-agents`) that launches **visible, role-guided peer coding agents** in Herdr panes. Each peer is an independent CLI process (Pi, Cursor, Codex, Claude Code, OpenCode, Antigravity, or a custom profile) in its own terminal pane — not an in-process Pi subagent.

User-facing behavior, tool parameters, and lifecycle semantics are documented in `README.md`. Read that before changing externally visible behavior.

## Toolchain

```sh
npm install
npm run typecheck   # tsc --noEmit
npm run lint        # biome check .
npm test            # vitest run
```

Run all three before claiming work is complete. Biome uses tabs and 100-column line width (`biome.json`).

## Architecture

```
src/index.ts          Extension entry — wires store, adapter, tools, session hooks
src/tools.ts          Pi tool definitions (herdr_launch_agent, get/steer/stop)
src/lifecycle.ts      Launch → wait idle → submit prompt → poll status → result/stop
src/herdr-adapter.ts  Herdr CLI boundary (pi.exec("herdr", …), JSON envelope parsing)
src/store.ts          In-memory AgentRecord map + snapshot restore/persist
src/profiles.ts       Built-in + file-backed CLI argv profiles
src/roles.ts          Built-in + file-backed role prompts + parent system prompt
src/types.ts          Shared types, constants, identity/completion helpers
src/env.ts            HERDR_* caller context validation
src/poll.ts           Generic pollUntil with abort/timeout
src/ids.ts            Opaque agent id + Herdr display name generation
test/fake-adapter.ts  FakeHerdrAdapter for lifecycle/adapter tests
```

**Data flow:** Pi caller invokes a tool → `lifecycle.ts` resolves role/profile → `herdr-adapter.ts` runs `herdr agent start` / `pane run` / `pane read` → `store.ts` tracks records and appends `herdr-agents:snapshot` entries on the active branch.

**Session hooks (`index.ts`):**
- `before_agent_start` — appends `<herdr-peer-delegation>` parent guidance when `HERDR_ENV=1`
- `session_start` / `session_tree` — restore snapshot, revalidate live pane identity
- `session_shutdown` — clear in-memory store

## Testing

Tests are unit-level with `FakeHerdrAdapter` — no live Herdr runtime required. Mirror existing patterns in `test/lifecycle.test.ts` and `test/adapter.test.ts` when adding lifecycle or adapter behavior.

When changing completion semantics, cover `seenWorking` gating: a peer is only "complete" after it has been `working` and then reaches `idle` or `done`.

## Invariants (do not violate)

- **argv arrays only** for profiles — never shell strings or interpolation.
- **No secrets** in snapshots or persisted config.
- **Project config** (`/.pi/herdr-agents.json`) is ignored when the project is untrusted (`ctx.isProjectTrusted()`).
- **Stop closes only owned panes** with verified pane/terminal/workspace/tab identity; mismatches become `lost`, never arbitrary closure.
- **Role prompts** are bounded and reject NUL bytes.
- **Parent guidance** is injected only inside Herdr (`HERDR_ENV=1`); do not broaden to non-Herdr sessions without an explicit design change.
- This extension does **not** replace Pi's native `Agent` tool.

## Conventions

- ESM with `.js` extensions in relative imports (`"./store.js"`).
- `verbatimModuleSyntax` and `erasableSyntaxOnly` are enabled — use `import type` for type-only imports.
- Peer agents do not inherit caller conversation; prompts must be standalone. Role assignment wraps tasks in `<herdr-peer-role>` / `<assignment>` blocks (`roles.ts`).
- Custom profiles/roles merge: built-ins → `~/.pi/agent/herdr-agents.json` → project `.pi/herdr-agents.json` (trusted only).

## Post-edit documentation (agents.md)

After non-trivial code changes, read the touched files and surrounding context, then summarize architectural decisions worth remembering (module boundaries, lifecycle tradeoffs, Herdr API quirks) in `agents.md`. Skip writing if the point is already recorded there.
