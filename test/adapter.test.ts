import { describe, expect, it, vi } from "vitest";
import {
	buildAgentStartArgv,
	createHerdrAdapter,
	parseAgentStatusWait,
	parseHerdrEnvelope,
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
});
