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
		// The caller's own pane, so auto-layout's slot-1 paneMove has a real
		// target instead of failing FakeHerdrAdapter's target-pane-exists check.
		adapter.addPane({
			paneId: "w1:p0",
			terminalId: "term_caller",
			workspaceId: "w1",
			tabId: "w1:t1",
			agentStatus: "idle",
			transcript: "",
		});
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

	it("rejects an oversized or NUL-containing steer message", async () => {
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

		await expect(
			steerAgent(deps, { agentId: launched.agentId, message: "x".repeat(100_001) }),
		).rejects.toThrow(/exceeds 100000 characters/);
		await expect(
			steerAgent(deps, { agentId: launched.agentId, message: "bad\0byte" }),
		).rejects.toThrow(/NUL bytes/);
	});

	it("passes the startup timeout through to agent start", async () => {
		const deps = makeDeps(adapter, store);
		const launchPromise = launchAgent(
			deps,
			{ cwd },
			{ profile: "pi", prompt: "timeout wiring", mode: "background", startupTimeoutMs: 9000 },
			undefined,
			{ sleep: noSleep, pollIntervalMs: 1 },
		);
		await vi.waitFor(() => adapter.getPane("w1:p1"));
		adapter.setStatus("w1:p1", "idle");
		await vi.waitFor(() => expect(adapter.calls.some((c) => c.method === "paneRun")).toBe(true));
		adapter.setStatus("w1:p1", "working");
		await launchPromise;

		const start = adapter.calls.find((call) => call.method === "agentStart");
		expect(start?.args[0]).toMatchObject({ timeoutMs: 9000 });
	});

	async function driveBackgroundLaunch(
		deps: ReturnType<typeof makeDeps>,
		prompt: string,
	): Promise<{ agentId: string; paneId: string }> {
		const startCountBefore = adapter.calls.filter((c) => c.method === "agentStart").length;
		const launchPromise = launchAgent(
			deps,
			{ cwd },
			{ profile: "pi", prompt, mode: "background", startupTimeoutMs: 5000 },
			undefined,
			{ sleep: noSleep, pollIntervalMs: 1 },
		);
		// FakeHerdrAdapter assigns pane ids "w1:pN" in agentStart call order.
		const paneId = `w1:p${startCountBefore + 1}`;
		await vi.waitFor(() => expect(adapter.getPane(paneId)).toBeDefined());
		adapter.setStatus(paneId, "idle");
		await vi.waitFor(() =>
			expect(adapter.calls.some((c) => c.method === "paneRun" && c.args[0] === paneId)).toBe(true),
		);
		adapter.setStatus(paneId, "working");
		const result = await launchPromise;
		return { agentId: result.agentId, paneId };
	}

	it("places sequential launches in a column-fill grid", async () => {
		const deps = makeDeps(adapter, store);

		const a1 = await driveBackgroundLaunch(deps, "peer 1");
		const a2 = await driveBackgroundLaunch(deps, "peer 2");
		const a3 = await driveBackgroundLaunch(deps, "peer 3");
		const a4 = await driveBackgroundLaunch(deps, "peer 4");

		expect(store.get(a1.agentId)?.layoutSlot).toBe(1);
		expect(store.get(a2.agentId)?.layoutSlot).toBe(2);
		expect(store.get(a3.agentId)?.layoutSlot).toBe(3);
		expect(store.get(a4.agentId)?.layoutSlot).toBe(4);

		expect(adapter.moves).toEqual([
			{ paneId: a1.paneId, tabId: "w1:t1", targetPaneId: "w1:p0", split: "right" },
			{ paneId: a2.paneId, tabId: "w1:t1", targetPaneId: a1.paneId, split: "down" },
			{ paneId: a3.paneId, tabId: "w1:t1", targetPaneId: a2.paneId, split: "down" },
			{ paneId: a4.paneId, tabId: "w1:t1", targetPaneId: a1.paneId, split: "right" },
		]);
	});

	it("bypasses auto-layout when split is explicit", async () => {
		const deps = makeDeps(adapter, store);
		const launchPromise = launchAgent(
			deps,
			{ cwd },
			{ profile: "pi", prompt: "explicit split", mode: "background", split: "down" },
			undefined,
			{ sleep: noSleep, pollIntervalMs: 1 },
		);
		await vi.waitFor(() => adapter.getPane("w1:p1"));
		adapter.setStatus("w1:p1", "idle");
		await vi.waitFor(() => expect(adapter.calls.some((c) => c.method === "paneRun")).toBe(true));
		adapter.setStatus("w1:p1", "working");
		const result = await launchPromise;

		expect(store.get(result.agentId)?.layoutSlot).toBeUndefined();
		expect(adapter.calls.some((c) => c.method === "paneMove")).toBe(false);
		const start = adapter.calls.find((c) => c.method === "agentStart");
		expect(start?.args[0]).toMatchObject({ split: "down" });
	});

	it("bypasses auto-layout for workspace-targeted launches", async () => {
		const deps = makeDeps(adapter, store);
		const launchPromise = launchAgent(
			deps,
			{ cwd },
			{ profile: "pi", prompt: "cross workspace", mode: "background", workspace: "w2" },
			undefined,
			{ sleep: noSleep, pollIntervalMs: 1 },
		);
		await vi.waitFor(() => adapter.getPane("w1:p1"));
		adapter.setStatus("w1:p1", "idle");
		await vi.waitFor(() => expect(adapter.calls.some((c) => c.method === "paneRun")).toBe(true));
		adapter.setStatus("w1:p1", "working");
		const result = await launchPromise;

		expect(store.get(result.agentId)?.layoutSlot).toBeUndefined();
		expect(adapter.calls.some((c) => c.method === "paneMove")).toBe(false);
	});

	it("falls back to the caller's pane when the layout anchor is lost", async () => {
		const deps = makeDeps(adapter, store);
		store.upsert({
			id: "herdr-agent-anchor-lost-1",
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
			layoutSlot: 1,
			layoutTabId: "w1:t1",
		});

		const launchPromise = launchAgent(
			deps,
			{ cwd },
			{ profile: "pi", prompt: "peer 2", mode: "background", startupTimeoutMs: 5000 },
			undefined,
			{ sleep: noSleep, pollIntervalMs: 1 },
		);
		await vi.waitFor(() => adapter.getPane("w1:p1"));
		adapter.setStatus("w1:p1", "idle");
		await vi.waitFor(() => expect(adapter.calls.some((c) => c.method === "paneRun")).toBe(true));
		adapter.setStatus("w1:p1", "working");
		const result = await launchPromise;

		expect(store.get(result.agentId)?.layoutSlot).toBe(2);
		expect(adapter.moves).toEqual([
			{ paneId: "w1:p1", tabId: "w1:t1", targetPaneId: "w1:p0", split: "right" },
		]);
	});

	it("degrades gracefully when paneMove fails, keeping the launch alive", async () => {
		const deps = makeDeps(adapter, store);
		adapter.paneMove = async () => {
			throw new Error("boom");
		};

		const launchPromise = launchAgent(
			deps,
			{ cwd },
			{ profile: "pi", prompt: "degrade", mode: "background", startupTimeoutMs: 5000 },
			undefined,
			{ sleep: noSleep, pollIntervalMs: 1 },
		);
		await vi.waitFor(() => adapter.getPane("w1:p1"));
		adapter.setStatus("w1:p1", "idle");
		await vi.waitFor(() => expect(adapter.calls.some((c) => c.method === "paneRun")).toBe(true));
		adapter.setStatus("w1:p1", "working");
		const result = await launchPromise;

		expect(result.partial).toBe(false);
		expect(result.seenWorking).toBe(true);
		const record = store.get(result.agentId);
		expect(record?.layoutSlot).toBe(1);
		expect(record?.error).toContain("Layout placement failed");
	});

	it("assigns distinct layout slots to concurrent launches", async () => {
		const deps = makeDeps(adapter, store);
		const resultsPromise = Promise.all([
			launchAgent(
				deps,
				{ cwd },
				{ profile: "pi", prompt: "concurrent a", mode: "background", startupTimeoutMs: 5000 },
				undefined,
				{ sleep: noSleep, pollIntervalMs: 1 },
			),
			launchAgent(
				deps,
				{ cwd },
				{ profile: "pi", prompt: "concurrent b", mode: "background", startupTimeoutMs: 5000 },
				undefined,
				{ sleep: noSleep, pollIntervalMs: 1 },
			),
			launchAgent(
				deps,
				{ cwd },
				{ profile: "pi", prompt: "concurrent c", mode: "background", startupTimeoutMs: 5000 },
				undefined,
				{ sleep: noSleep, pollIntervalMs: 1 },
			),
		]);

		await vi.waitFor(() =>
			expect(adapter.calls.filter((c) => c.method === "agentStart").length).toBe(3),
		);
		for (const paneId of ["w1:p1", "w1:p2", "w1:p3"]) {
			adapter.setStatus(paneId, "idle");
		}
		await vi.waitFor(() =>
			expect(adapter.calls.filter((c) => c.method === "paneRun").length).toBe(3),
		);
		for (const paneId of ["w1:p1", "w1:p2", "w1:p3"]) {
			adapter.setStatus(paneId, "working");
		}
		const results = await resultsPromise;

		const slots = results.map((r) => store.get(r.agentId)?.layoutSlot);
		expect(new Set(slots)).toEqual(new Set([1, 2, 3]));
		expect(slots.every((slot) => slot !== undefined)).toBe(true);
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
