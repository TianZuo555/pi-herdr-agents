import { describe, expect, it, vi } from "vitest";
import {
	buildAgentStartArgv,
	buildPaneMoveArgv,
	createHerdrAdapter,
	parseAgentStatusWait,
	parseHerdrEnvelope,
	validateAgentInfo,
	validateAgentStarted,
	validatePaneInfo,
	validatePaneRead,
} from "../src/herdr-adapter.js";

describe("herdr adapter parsing", () => {
	it("parses success and error envelopes", () => {
		expect(parseHerdrEnvelope('{"ok":true,"result":{"type":"pane_info"}}').ok).toBe(true);
		expect(parseHerdrEnvelope('{"ok":false,"error":"boom"}').error).toBe("boom");
		expect(parseHerdrEnvelope('{"id":"1","result":{"type":"ok"}}').result).toEqual({ type: "ok" });
		expect(
			parseHerdrEnvelope('{"id":"1","error":{"code":"pane_not_found","message":"pane not found"}}')
				.ok,
		).toBe(false);
		expect(parseHerdrEnvelope("not json").ok).toBe(false);
	});

	it("validates agent_started result", () => {
		const result = validateAgentStarted({
			type: "agent_started",
			agent: {
				pane_id: "w1:p1",
				terminal_id: "term_1",
				workspace_id: "w1",
				tab_id: "w1:t1",
				agent_status: "idle",
			},
			argv: ["pi"],
		});
		expect(result.agent.pane_id).toBe("w1:p1");
	});

	it("validates pane_info and pane_read", () => {
		const pane = {
			pane_id: "w1:p1",
			terminal_id: "term_1",
			workspace_id: "w1",
			tab_id: "w1:t1",
			agent_status: "working",
		};
		expect(validateAgentInfo({ type: "agent_info", agent: pane }).agent.pane_id).toBe("w1:p1");
		expect(validatePaneInfo({ type: "pane_info", pane }).pane.agent_status).toBe("working");
		expect(
			validatePaneRead({
				type: "pane_read",
				read: { text: "hello", truncated: false },
			}).read.text,
		).toBe("hello");
		expect(
			validatePaneRead({
				type: "pane_read",
				read: { pane_id: "p1", text: "native", truncated: true },
			}).read.text,
		).toBe("native");
	});

	it("gets an agent by unique name for failed-start reconciliation", async () => {
		const exec = vi.fn(async () => ({
			stdout: JSON.stringify({
				result: {
					type: "agent_info",
					agent: {
						pane_id: "w1:p1",
						terminal_id: "term_1",
						workspace_id: "w1",
						tab_id: "w1:t1",
						agent_status: "idle",
					},
				},
			}),
			stderr: "",
			code: 0,
			killed: false,
		}));
		const adapter = createHerdrAdapter(exec);
		const result = await adapter.agentGet("reviewer-codex-1");
		expect(result?.agent.pane_id).toBe("w1:p1");
		expect(exec).toHaveBeenCalledWith(
			"herdr",
			["agent", "get", "reviewer-codex-1"],
			expect.objectContaining({ timeout: 30_000 }),
		);
	});

	it("accepts raw text emitted by the pane-read CLI", async () => {
		const exec = vi.fn(async () => ({
			stdout: "line one\nline two",
			stderr: "",
			code: 0,
			killed: false,
		}));
		const adapter = createHerdrAdapter(exec);
		const read = await adapter.paneRead("w1:p1", 20);
		expect(read?.read.text).toBe("line one\nline two");
		expect(exec).toHaveBeenCalledWith(
			"herdr",
			["pane", "read", "w1:p1", "--source", "recent-unwrapped", "--lines", "20"],
			expect.objectContaining({ timeout: 30_000 }),
		);
	});

	it("forwards a custom startup timeout to the agent start exec call", async () => {
		const exec = vi.fn(async () => ({
			stdout: JSON.stringify({
				ok: true,
				result: {
					type: "agent_started",
					agent: {
						pane_id: "w1:p1",
						terminal_id: "term_1",
						workspace_id: "w1",
						tab_id: "w1:t1",
						agent_status: "unknown",
					},
					argv: ["pi"],
				},
			}),
			stderr: "",
			code: 0,
			killed: false,
		}));
		const adapter = createHerdrAdapter(exec);
		await adapter.agentStart({
			name: "pi-abc",
			argv: ["pi"],
			cwd: "/tmp/work",
			tabId: "w1:t1",
			timeoutMs: 9000,
		});
		expect(exec).toHaveBeenCalledWith(
			"herdr",
			expect.any(Array),
			expect.objectContaining({ timeout: 9000 }),
		);
	});

	it("defaults the agent start exec timeout to 30s when unset", async () => {
		const exec = vi.fn(async () => ({
			stdout: JSON.stringify({
				ok: true,
				result: {
					type: "agent_started",
					agent: {
						pane_id: "w1:p1",
						terminal_id: "term_1",
						workspace_id: "w1",
						tab_id: "w1:t1",
						agent_status: "unknown",
					},
					argv: ["pi"],
				},
			}),
			stderr: "",
			code: 0,
			killed: false,
		}));
		const adapter = createHerdrAdapter(exec);
		await adapter.agentStart({ name: "pi-abc", argv: ["pi"], cwd: "/tmp/work", tabId: "w1:t1" });
		expect(exec).toHaveBeenCalledWith(
			"herdr",
			expect.any(Array),
			expect.objectContaining({ timeout: 30_000 }),
		);
	});

	it("parses agent-status wait events", () => {
		expect(
			parseAgentStatusWait(
				'{"event":"pane.agent_status_changed","data":{"pane_id":"w1:p1","agent_status":"working"}}',
			),
		).toBe("working");
		expect(() => parseAgentStatusWait("timed out waiting for agent status change")).toThrow(
			/Timed out waiting/,
		);
	});

	it("builds safe argv without shell interpolation", () => {
		const argv = buildAgentStartArgv({
			name: "pi-abc",
			argv: ["pi"],
			cwd: "/tmp/work",
			tabId: "w1:t1",
			split: "right",
			focus: false,
		});
		expect(argv).toEqual([
			"agent",
			"start",
			"pi-abc",
			"--cwd",
			"/tmp/work",
			"--tab",
			"w1:t1",
			"--split",
			"right",
			"--no-focus",
			"--",
			"pi",
		]);
	});

	it("rejects workspace and tab together", () => {
		expect(() =>
			buildAgentStartArgv({
				name: "x",
				argv: ["pi"],
				cwd: "/tmp",
				workspaceId: "w1",
				tabId: "w1:t1",
			}),
		).toThrow(/both workspace and tab/);
	});

	it("builds pane move argv in the order the herdr CLI expects", () => {
		const argv = buildPaneMoveArgv("w1:p2", {
			tabId: "w1:t1",
			targetPaneId: "w1:p1",
			split: "right",
		});
		expect(argv).toEqual([
			"pane",
			"move",
			"w1:p2",
			"--tab",
			"w1:t1",
			"--split",
			"right",
			"--target-pane",
			"w1:p1",
		]);
	});

	it("appends ratio and focus flags for pane move", () => {
		const argv = buildPaneMoveArgv("w1:p2", {
			tabId: "w1:t1",
			targetPaneId: "w1:p1",
			split: "down",
			ratio: 0.4,
			focus: false,
		});
		expect(argv).toEqual([
			"pane",
			"move",
			"w1:p2",
			"--tab",
			"w1:t1",
			"--split",
			"down",
			"--target-pane",
			"w1:p1",
			"--ratio",
			"0.4",
			"--no-focus",
		]);
	});

	it("rejects NUL bytes and invalid split values for pane move", () => {
		expect(() =>
			buildPaneMoveArgv("w1:p2\0", { tabId: "w1:t1", targetPaneId: "w1:p1", split: "right" }),
		).toThrow(/pane id/);
		expect(() =>
			buildPaneMoveArgv("w1:p2", { tabId: "", targetPaneId: "w1:p1", split: "right" }),
		).toThrow(/tab id/);
		expect(() =>
			buildPaneMoveArgv("w1:p2", { tabId: "w1:t1", targetPaneId: "", split: "right" }),
		).toThrow(/target pane id/);
		expect(() =>
			buildPaneMoveArgv("w1:p2", {
				tabId: "w1:t1",
				targetPaneId: "w1:p1",
				// biome-ignore lint/suspicious/noExplicitAny: exercising runtime validation of an invalid enum value
				split: "sideways" as any,
			}),
		).toThrow(/split must be/);
	});

	it("pane move resolves on success and surfaces herdr errors on failure", async () => {
		const exec = vi.fn(async () => ({
			stdout: '{"ok":true,"result":{"type":"pane_move","move_result":{"changed":true}}}',
			stderr: "",
			code: 0,
			killed: false,
		}));
		const adapter = createHerdrAdapter(exec);
		await expect(
			adapter.paneMove("w1:p2", { tabId: "w1:t1", targetPaneId: "w1:p1", split: "right" }),
		).resolves.toBeUndefined();
		expect(exec).toHaveBeenCalledWith(
			"herdr",
			["pane", "move", "w1:p2", "--tab", "w1:t1", "--split", "right", "--target-pane", "w1:p1"],
			expect.objectContaining({ timeout: 30_000 }),
		);
	});

	it("pane move rejects with the herdr error message on failure", async () => {
		const exec = vi.fn(async () => ({
			stdout: '{"error":{"code":"target_pane_not_found","message":"target pane w1:p1 not found"}}',
			stderr: "",
			code: 1,
			killed: false,
		}));
		const adapter = createHerdrAdapter(exec);
		await expect(
			adapter.paneMove("w1:p2", { tabId: "w1:t1", targetPaneId: "w1:p1", split: "right" }),
		).rejects.toThrow(/target_pane_not_found/);
	});
});
