import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getAgentResult,
	isValidCompletion,
	launchAgent,
	steerAgent,
	stopAgent,
} from "../src/lifecycle.js";
import { BUILTIN_PROFILES } from "../src/profiles.js";
import { BUILTIN_ROLES } from "../src/roles.js";
import { AgentStore } from "../src/store.js";
import { FakeHerdrAdapter } from "./fake-adapter.js";

const originalEnv = { ...process.env };

function withHerdrEnv() {
	process.env.HERDR_ENV = "1";
	process.env.HERDR_WORKSPACE_ID = "w1";
	process.env.HERDR_TAB_ID = "w1:t1";
	process.env.HERDR_PANE_ID = "w1:p0";
}

function makeDeps(adapter: FakeHerdrAdapter, store: AgentStore) {
	return {
		store,
		adapter,
		resolveProfiles: () => ({ ...BUILTIN_PROFILES }),
		resolveRoles: () => ({ ...BUILTIN_ROLES }),
	};
}

async function noSleep() {
	// instant polling for tests
}

describe("lifecycle", () => {
	let cwd: string;
	let store: AgentStore;
	let adapter: FakeHerdrAdapter;

	beforeEach(() => {
		withHerdrEnv();
		cwd = mkdtempSync(join(tmpdir(), "herdr-life-"));
		store = new AgentStore();
		adapter = new FakeHerdrAdapter();
	});

	afterEach(() => {
		process.env = { ...originalEnv };
		vi.restoreAllMocks();
	});

	it("background launch: idle -> prompt -> working", async () => {
		const deps = makeDeps(adapter, store);
		const launchPromise = launchAgent(
			deps,
			{ cwd },
			{ profile: "pi", prompt: "review diff", mode: "background", startupTimeoutMs: 5000 },
			undefined,
			{ sleep: noSleep, pollIntervalMs: 1 },
		);

		await vi.waitFor(() => expect(adapter.calls.some((c) => c.method === "agentStart")).toBe(true));
		const paneId = (await adapter.paneGet("w1:p1"))?.pane.pane_id ?? "w1:p1";
		adapter.setStatus(paneId, "idle");

		await vi.waitFor(() => expect(adapter.calls.some((c) => c.method === "paneRun")).toBe(true));
		adapter.setStatus(paneId, "working");

		const result = await launchPromise;
		expect(result.agentId).toMatch(/^herdr-agent-/);
		expect(result.seenWorking).toBe(true);
		expect(result.partial).toBe(false);
		expect(store.get(result.agentId)?.seenWorking).toBe(true);
	});

	it("uses a role default profile and prepends the role prompt", async () => {
		const deps = makeDeps(adapter, store);
		const launchPromise = launchAgent(
			deps,
			{ cwd },
			{ role: "reviewer", prompt: "Review src/x.ts", mode: "background" },
			undefined,
			{ sleep: noSleep, pollIntervalMs: 1 },
		);

		await vi.waitFor(() => adapter.getPane("w1:p1"));
		adapter.setStatus("w1:p1", "idle");
		await vi.waitFor(() => expect(adapter.calls.some((c) => c.method === "paneRun")).toBe(true));
		adapter.setStatus("w1:p1", "working");
		const result = await launchPromise;

		const start = adapter.calls.find((call) => call.method === "agentStart");
		expect(start?.args[0]).toMatchObject({ argv: ["codex"] });
		const run = adapter.calls.find((call) => call.method === "paneRun");
		expect(run?.args[1]).toContain('<herdr-peer-role name="reviewer">');
		expect(run?.args[1]).toContain("Review src/x.ts");
		expect(result.role).toBe("reviewer");
		expect(result.profile).toBe("codex");
	});

	it("waits for a readable TUI frame before submitting the prompt", async () => {
		const deps = makeDeps(adapter, store);
		const launchPromise = launchAgent(
			deps,
			{ cwd },
			{ profile: "pi", prompt: "ready check", mode: "background", startupTimeoutMs: 5000 },
			undefined,
			{ sleep: noSleep, pollIntervalMs: 1 },
		);

		await vi.waitFor(() => adapter.getPane("w1:p1"));
		adapter.setTranscript("w1:p1", "");
		adapter.setStatus("w1:p1", "idle");
		await vi.waitFor(() => expect(adapter.calls.some((c) => c.method === "paneRead")).toBe(true));
		expect(adapter.calls.some((c) => c.method === "paneRun")).toBe(false);

		adapter.setTranscript("w1:p1", "agent ready");
		await vi.waitFor(() => expect(adapter.calls.some((c) => c.method === "paneRun")).toBe(true));
		adapter.setStatus("w1:p1", "working");
		const result = await launchPromise;
		expect(result.seenWorking).toBe(true);
	});

	it("surfaces a Cursor trust screen without submitting the task", async () => {
		const deps = makeDeps(adapter, store);
		const launchPromise = launchAgent(
			deps,
			{ cwd },
			{ profile: "cursor", prompt: "review", mode: "background", startupTimeoutMs: 5000 },
			undefined,
			{ sleep: noSleep, pollIntervalMs: 1 },
		);

		await vi.waitFor(() => adapter.getPane("w1:p1"));
		adapter.setTranscript("w1:p1", "[a] Trust this workspace");
		adapter.setStatus("w1:p1", "idle");
		const result = await launchPromise;
		expect(result.status).toBe("blocked");
		expect(result.error).toMatch(/workspace trust/);
		expect(adapter.calls.some((c) => c.method === "paneRun")).toBe(false);
	});

	it("foreground launch returns transcript after done", async () => {
		const deps = makeDeps(adapter, store);
		const launchPromise = launchAgent(
			deps,
			{ cwd },
			{
				profile: "pi",
				prompt: "ship it",
				mode: "foreground",
				startupTimeoutMs: 5000,
				completionTimeoutMs: 5000,
			},
			undefined,
			{ sleep: noSleep, pollIntervalMs: 1 },
		);

		await vi.waitFor(() => adapter.getPane("w1:p1"));
		const paneId = "w1:p1";
		adapter.setStatus(paneId, "idle");
		await vi.waitFor(() => adapter.calls.some((c) => c.method === "paneRun"));
		await vi.waitFor(() => expect(store.list()[0]?.seenWorking).toBe(true));
		adapter.setStatus(paneId, "done");
		adapter.setTranscript(paneId, "SUMMARY: shipped");

		const result = await launchPromise;
		expect(result.transcript).toContain("SUMMARY: shipped");
		expect(result.status).toBe("done");
	});

	it("foreground launch handles fast completion that skips sampled working", async () => {
		const deps = makeDeps(adapter, store);
		const launchPromise = launchAgent(
			deps,
			{ cwd },
			{
				profile: "pi",
				prompt: "Respond with exactly HERDR_PEER_OK and do nothing else.",
				mode: "foreground",
				startupTimeoutMs: 5000,
				completionTimeoutMs: 5000,
			},
			undefined,
			{ sleep: noSleep, pollIntervalMs: 1 },
		);

		await vi.waitFor(() => adapter.getPane("w1:p1"));
		const paneId = "w1:p1";
		adapter.setStatus(paneId, "idle");
		const pane = adapter.getPane(paneId);
		if (!pane) throw new Error("expected pane");
		pane.onRun = () => {
			pane.agentStatus = "working";
			adapter.setStatus(paneId, "working");
			pane.agentStatus = "done";
			pane.transcript = "HERDR_PEER_OK";
			adapter.setStatus(paneId, "done");
		};

		const result = await launchPromise;
		expect(result.seenWorking).toBe(true);
		expect(result.transcript).toContain("HERDR_PEER_OK");
		expect(result.status).toBe("done");
		expect(
			adapter.calls.some((c) => c.method === "waitAgentStatus" && c.args[1] === "working"),
		).toBe(true);
	});

	it("completion guard rejects idle before seenWorking", () => {
		expect(isValidCompletion("idle", false)).toBe(false);
		expect(isValidCompletion("done", false)).toBe(false);
		expect(isValidCompletion("idle", true)).toBe(true);
	});

	it("rejects a file path as cwd before launching", async () => {
		const deps = makeDeps(adapter, store);
		const file = join(cwd, "not-a-directory");
		writeFileSync(file, "x");
		await expect(
			launchAgent(deps, { cwd }, { profile: "pi", prompt: "x", cwd: file }),
		).rejects.toThrow(/not an existing directory/);
		expect(adapter.calls.some((call) => call.method === "agentStart")).toBe(false);
	});

	it("timeout preserves agent id and record", async () => {
		const deps = makeDeps(adapter, store);
		const result = await launchAgent(
			deps,
			{ cwd },
			{ profile: "pi", prompt: "slow", mode: "background", startupTimeoutMs: 10 },
			undefined,
			{ sleep: noSleep, pollIntervalMs: 1, now: () => Date.now() },
		);
		expect(result.partial).toBe(true);
		expect(result.agentId).toBeTruthy();
		expect(store.get(result.agentId)).toBeDefined();
	});

	it("blocked status returns partial result immediately", async () => {
		const deps = makeDeps(adapter, store);
		const launchPromise = launchAgent(
			deps,
			{ cwd },
			{ profile: "pi", prompt: "need input", mode: "background", startupTimeoutMs: 5000 },
			undefined,
			{ sleep: noSleep, pollIntervalMs: 1 },
		);
		await vi.waitFor(() => adapter.getPane("w1:p1"));
		adapter.setStatus("w1:p1", "blocked");
		const result = await launchPromise;
		expect(result.status).toBe("blocked");
		expect(result.partial).toBe(true);
	});

	it("getAgentResult poll and wait behavior", async () => {
		const deps = makeDeps(adapter, store);
		const launchPromise = launchAgent(
			deps,
			{ cwd },
			{ profile: "pi", prompt: "bg task", mode: "background", startupTimeoutMs: 5000 },
			undefined,
			{ sleep: noSleep, pollIntervalMs: 1 },
		);
		await vi.waitFor(() => adapter.getPane("w1:p1"));
		adapter.setStatus("w1:p1", "idle");
		const launched = await launchPromise;
		await vi.waitFor(() => adapter.calls.some((c) => c.method === "paneRun"));
		adapter.setStatus("w1:p1", "working");

		await vi.waitFor(async () => {
			const r = await getAgentResult(deps, { agentId: launched.agentId, mode: "poll" });
			return r.seenWorking;
		});

		adapter.setStatus("w1:p1", "done");
		adapter.setTranscript("w1:p1", "done output");

		const waited = await getAgentResult(
			deps,
			{ agentId: launched.agentId, mode: "wait", timeoutMs: 5000 },
			undefined,
			{ sleep: noSleep, pollIntervalMs: 1 },
		);
		expect(waited.complete).toBe(true);
		expect(waited.transcript).toContain("done output");
	});

	it("steering uses pane run and persists", async () => {
		const deps = makeDeps(adapter, store);
		const launchPromise = launchAgent(
			deps,
			{ cwd },
			{ profile: "pi", prompt: "first", mode: "background", startupTimeoutMs: 5000 },
			undefined,
			{ sleep: noSleep, pollIntervalMs: 1 },
		);
		await vi.waitFor(() => adapter.getPane("w1:p1"));
		adapter.setStatus("w1:p1", "idle");
		const launched = await launchPromise;
		await vi.waitFor(() => adapter.calls.some((c) => c.method === "paneRun"));
		adapter.setStatus("w1:p1", "working");

		await vi.waitFor(() => store.get(launched.agentId)?.seenWorking);

		await steerAgent(deps, { agentId: launched.agentId, message: "also check tests" });
		expect(adapter.calls.filter((c) => c.method === "paneRun").length).toBeGreaterThan(1);
	});

	it("stop validates ownership and closes pane", async () => {
		const deps = makeDeps(adapter, store);
		const launchPromise = launchAgent(
			deps,
			{ cwd },
			{ profile: "pi", prompt: "stop me", mode: "background", startupTimeoutMs: 5000 },
			undefined,
			{ sleep: noSleep, pollIntervalMs: 1 },
		);
		await vi.waitFor(() => adapter.getPane("w1:p1"));
		adapter.setStatus("w1:p1", "idle");
		const launched = await launchPromise;
		await vi.waitFor(() => adapter.calls.some((c) => c.method === "paneRun"));
		adapter.setStatus("w1:p1", "working");
		await vi.waitFor(() => store.get(launched.agentId)?.seenWorking);

		const stopped = await stopAgent(deps, { agentId: launched.agentId });
		expect(stopped.stopped).toBe(true);
		expect(adapter.calls.some((c) => c.method === "paneClose")).toBe(true);
	});

	it("abort preserves agent id on foreground launch", async () => {
		const deps = makeDeps(adapter, store);
		const controller = new AbortController();
		const launchPromise = launchAgent(
			deps,
			{ cwd },
			{ profile: "pi", prompt: "fg", mode: "foreground", startupTimeoutMs: 5000 },
			controller.signal,
			{ sleep: noSleep, pollIntervalMs: 1 },
		);
		await vi.waitFor(() => adapter.getPane("w1:p1"));
		controller.abort();
		const result = await launchPromise;
		expect(result.agentId).toBeTruthy();
		expect(result.status).toBe("aborted");
	});

	it("missing pane on stop marks lost without close", async () => {
		const deps = makeDeps(adapter, store);
		const record = store.upsert({
			id: "herdr-agent-lost-1",
			profile: "pi",
			description: "gone",
			prompt: "x",
			cwd,
			herdrName: "pi-lost",
			identity: {
				paneId: "w1:p99",
				terminalId: "term_99",
				workspaceId: "w1",
				tabId: "w1:t1",
			},
			agentStatus: "working",
			recordStatus: "working",
			seenWorking: true,
			mode: "background",
			launchedAt: Date.now(),
			owned: true,
			stopped: false,
			lost: false,
		});
		const stopped = await stopAgent(deps, { agentId: record.id });
		expect(stopped.lost).toBe(true);
		expect(adapter.calls.some((c) => c.method === "paneClose")).toBe(false);
	});

	it("refuses to close a tracked record that is not extension-owned", async () => {
		const deps = makeDeps(adapter, store);
		const record = store.upsert({
			id: "herdr-agent-unowned-1",
			profile: "pi",
			description: "not ours",
			prompt: "x",
			cwd,
			herdrName: "pi-unowned",
			identity: {
				paneId: "w1:p7",
				terminalId: "term_7",
				workspaceId: "w1",
				tabId: "w1:t1",
			},
			agentStatus: "idle",
			recordStatus: "idle",
			seenWorking: true,
			mode: "background",
			launchedAt: Date.now(),
			owned: false,
			stopped: false,
			lost: false,
		});

		await expect(stopAgent(deps, { agentId: record.id })).rejects.toThrow(/not an owned/);
		expect(adapter.calls.some((c) => c.method === "paneClose")).toBe(false);
	});
});
