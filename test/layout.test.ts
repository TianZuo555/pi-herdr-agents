import { describe, expect, it } from "vitest";
import { computeSlotPlacement, resolveLayoutAnchor } from "../src/layout.js";
import { AgentStore } from "../src/store.js";
import type { AgentRecord } from "../src/types.js";
import { FakeHerdrAdapter } from "./fake-adapter.js";

function sampleRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
	return {
		id: "herdr-agent-deadbeef-1",
		profile: "pi",
		description: "test",
		prompt: "do work",
		cwd: "/tmp",
		herdrName: "pi-1",
		identity: {
			paneId: "w1:p1",
			terminalId: "term_1",
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
		...overrides,
	};
}

describe("computeSlotPlacement", () => {
	it("slot 1 anchors on the caller's own pane, splitting right", () => {
		expect(computeSlotPlacement(1)).toEqual({ anchorSlot: null, direction: "right" });
	});

	it("slots 2 and 3 stack down under the previous slot in the column", () => {
		expect(computeSlotPlacement(2)).toEqual({ anchorSlot: 1, direction: "down" });
		expect(computeSlotPlacement(3)).toEqual({ anchorSlot: 2, direction: "down" });
	});

	it("slot 4 starts a new column anchored on column 1's top slot, splitting right", () => {
		expect(computeSlotPlacement(4)).toEqual({ anchorSlot: 1, direction: "right" });
	});

	it("slots 5 and 6 stack down within column 2", () => {
		expect(computeSlotPlacement(5)).toEqual({ anchorSlot: 4, direction: "down" });
		expect(computeSlotPlacement(6)).toEqual({ anchorSlot: 5, direction: "down" });
	});

	it("slot 7 starts column 3 anchored on column 2's top slot (4), not slot 6", () => {
		expect(computeSlotPlacement(7)).toEqual({ anchorSlot: 4, direction: "right" });
	});

	it("rejects non-positive or non-integer slots", () => {
		expect(() => computeSlotPlacement(0)).toThrow(/positive integer/);
		expect(() => computeSlotPlacement(-1)).toThrow(/positive integer/);
		expect(() => computeSlotPlacement(1.5)).toThrow(/positive integer/);
	});
});

describe("resolveLayoutAnchor", () => {
	it("slot 1 resolves directly to the caller's pane with no adapter call", async () => {
		const store = new AgentStore();
		const adapter = new FakeHerdrAdapter();
		const result = await resolveLayoutAnchor(adapter, store, "w1:t1", "w1:p0", 1);
		expect(result).toEqual({ targetPaneId: "w1:p0", split: "right" });
		expect(adapter.calls).toHaveLength(0);
	});

	it("resolves a live matching anchor record to its pane id and computed direction", async () => {
		const store = new AgentStore();
		const adapter = new FakeHerdrAdapter();
		adapter.addPane({
			paneId: "w1:p1",
			terminalId: "term_1",
			workspaceId: "w1",
			tabId: "w1:t1",
			agentStatus: "working",
			transcript: "",
		});
		store.upsert(
			sampleRecord({
				id: "a1",
				layoutSlot: 1,
				layoutTabId: "w1:t1",
				identity: {
					paneId: "w1:p1",
					terminalId: "term_1",
					workspaceId: "w1",
					tabId: "w1:t1",
				},
			}),
		);
		const result = await resolveLayoutAnchor(adapter, store, "w1:t1", "w1:p0", 2);
		expect(result).toEqual({ targetPaneId: "w1:p1", split: "down" });
	});

	it("falls back to the caller's pane when the anchor record is missing from the store", async () => {
		const store = new AgentStore();
		const adapter = new FakeHerdrAdapter();
		const result = await resolveLayoutAnchor(adapter, store, "w1:t1", "w1:p0", 2);
		expect(result).toEqual({ targetPaneId: "w1:p0", split: "right" });
		expect(adapter.calls).toHaveLength(0);
	});

	it("falls back to the caller's pane when the anchor record is already marked lost", async () => {
		const store = new AgentStore();
		const adapter = new FakeHerdrAdapter();
		store.upsert(sampleRecord({ id: "a1", layoutSlot: 1, layoutTabId: "w1:t1", lost: true }));
		const result = await resolveLayoutAnchor(adapter, store, "w1:t1", "w1:p0", 2);
		expect(result).toEqual({ targetPaneId: "w1:p0", split: "right" });
		expect(adapter.calls).toHaveLength(0);
	});

	it("falls back to the caller's pane when the anchor record is stopped", async () => {
		const store = new AgentStore();
		const adapter = new FakeHerdrAdapter();
		store.upsert(sampleRecord({ id: "a1", layoutSlot: 1, layoutTabId: "w1:t1", stopped: true }));
		const result = await resolveLayoutAnchor(adapter, store, "w1:t1", "w1:p0", 2);
		expect(result).toEqual({ targetPaneId: "w1:p0", split: "right" });
	});

	it("falls back to the caller's pane when the anchor pane no longer exists live", async () => {
		const store = new AgentStore();
		const adapter = new FakeHerdrAdapter();
		store.upsert(sampleRecord({ id: "a1", layoutSlot: 1, layoutTabId: "w1:t1" }));
		const result = await resolveLayoutAnchor(adapter, store, "w1:t1", "w1:p0", 2);
		expect(result).toEqual({ targetPaneId: "w1:p0", split: "right" });
	});

	it("falls back to the caller's pane when the anchor pane's identity no longer matches", async () => {
		const store = new AgentStore();
		const adapter = new FakeHerdrAdapter();
		adapter.addPane({
			paneId: "w1:p1",
			terminalId: "term_OTHER",
			workspaceId: "w1",
			tabId: "w1:t1",
			agentStatus: "working",
			transcript: "",
		});
		store.upsert(sampleRecord({ id: "a1", layoutSlot: 1, layoutTabId: "w1:t1" }));
		const result = await resolveLayoutAnchor(adapter, store, "w1:t1", "w1:p0", 2);
		expect(result).toEqual({ targetPaneId: "w1:p0", split: "right" });
	});

	it("ignores anchor records scoped to a different tab", async () => {
		const store = new AgentStore();
		const adapter = new FakeHerdrAdapter();
		store.upsert(sampleRecord({ id: "a1", layoutSlot: 1, layoutTabId: "w1:t9" }));
		const result = await resolveLayoutAnchor(adapter, store, "w1:t1", "w1:p0", 2);
		expect(result).toEqual({ targetPaneId: "w1:p0", split: "right" });
	});
});
