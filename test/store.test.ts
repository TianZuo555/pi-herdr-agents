import { describe, expect, it } from "vitest";
import { AgentStore, restoreAndValidateRecords, validateLiveRecord } from "../src/store.js";
import type { AgentRecord } from "../src/types.js";
import { SNAPSHOT_CUSTOM_TYPE, SNAPSHOT_VERSION } from "../src/types.js";
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

describe("AgentStore", () => {
	it("persists versioned snapshots without task prompt text", () => {
		const entries: Array<{ type: string; customType?: string; data?: unknown }> = [];
		const store = new AgentStore();
		store.setAppendEntry((customType, data) => {
			entries.push({ type: "custom", customType, data });
		});
		store.upsert(sampleRecord());
		expect(entries.at(-1)?.customType).toBe(SNAPSHOT_CUSTOM_TYPE);
		expect((entries.at(-1)?.data as { version: number }).version).toBe(SNAPSHOT_VERSION);
		const snapshot = entries.at(-1)?.data as { records: Array<{ prompt?: string }> };
		expect(snapshot.records[0]?.prompt).toBeUndefined();
		expect(store.get("herdr-agent-deadbeef-1")?.prompt).toBeUndefined();
	});

	it("does not append a snapshot for a no-op mutation", () => {
		let writes = 0;
		const store = new AgentStore();
		store.setAppendEntry(() => {
			writes += 1;
		});
		store.upsert(sampleRecord());
		expect(writes).toBe(1);
		store.mutate("herdr-agent-deadbeef-1", () => {});
		expect(writes).toBe(1);
		store.mutate("herdr-agent-deadbeef-1", (record) => {
			record.recordStatus = "done";
		});
		expect(writes).toBe(2);
	});

	it("migrates legacy launching and read-only records safely", () => {
		const store = new AgentStore();
		store.loadSnapshot({
			version: 1,
			records: [
				sampleRecord({
					role: "scout",
					prompt: "legacy secret",
					writeAccess: undefined,
					submissionState: undefined,
					recordStatus: "launching",
					agentStatus: "idle",
					seenWorking: false,
				}),
			],
		});
		const restored = store.get("herdr-agent-deadbeef-1");
		expect(restored?.prompt).toBeUndefined();
		expect(restored?.writeAccess).toBe("none");
		expect(restored?.submissionState).toBe("pending");
	});

	it("restores latest snapshot from branch", () => {
		const store = new AgentStore();
		const first = sampleRecord({ id: "a1" });
		const second = sampleRecord({ id: "a2" });
		store.restoreFromBranch([
			{
				type: "custom",
				customType: SNAPSHOT_CUSTOM_TYPE,
				data: { version: 1, records: [first] },
			},
			{
				type: "custom",
				customType: SNAPSHOT_CUSTOM_TYPE,
				data: { version: 1, records: [second] },
			},
		]);
		expect(store.get("a2")).toBeDefined();
		expect(store.get("a1")).toBeUndefined();
	});

	it("clears records when the active branch has no snapshot", () => {
		const store = new AgentStore();
		store.upsert(sampleRecord());
		store.restoreFromBranch([]);
		expect(store.list()).toEqual([]);
	});
});

describe("validateLiveRecord", () => {
	it("marks missing pane as lost", async () => {
		const adapter = new FakeHerdrAdapter();
		const record = sampleRecord();
		const validated = await validateLiveRecord(adapter, record);
		expect(validated.lost).toBe(true);
	});

	it("marks identity mismatch as lost", async () => {
		const adapter = new FakeHerdrAdapter();
		adapter.addPane({
			paneId: "w1:p1",
			terminalId: "term_OTHER",
			workspaceId: "w1",
			tabId: "w1:t1",
			agentStatus: "idle",
			transcript: "",
		});
		const validated = await validateLiveRecord(adapter, sampleRecord());
		expect(validated.lost).toBe(true);
	});

	it("updates live status when identity matches", async () => {
		const adapter = new FakeHerdrAdapter();
		adapter.addPane({
			paneId: "w1:p1",
			terminalId: "term_1",
			workspaceId: "w1",
			tabId: "w1:t1",
			agentStatus: "done",
			transcript: "",
		});
		const validated = await validateLiveRecord(adapter, sampleRecord());
		expect(validated.lost).toBe(false);
		expect(validated.agentStatus).toBe("done");
	});

	it("restoreAndValidateRecords marks unavailable panes lost", async () => {
		const store = new AgentStore();
		store.upsert(sampleRecord({ id: "live-1" }));
		const adapter = new FakeHerdrAdapter();
		await restoreAndValidateRecords(store, adapter);
		const record = store.get("live-1");
		expect(record?.lost).toBe(true);
	});

	it("does not persist an unchanged restore validation", async () => {
		const store = new AgentStore();
		store.upsert(sampleRecord());
		let writes = 0;
		store.setAppendEntry(() => {
			writes += 1;
		});
		const adapter = new FakeHerdrAdapter();
		adapter.addPane({
			paneId: "w1:p1",
			terminalId: "term_1",
			workspaceId: "w1",
			tabId: "w1:t1",
			agentStatus: "working",
			transcript: "",
		});
		await restoreAndValidateRecords(store, adapter);
		expect(writes).toBe(0);
	});

	it("does not overwrite records when restore validation is aborted", async () => {
		const store = new AgentStore();
		store.upsert(sampleRecord());
		let writes = 0;
		store.setAppendEntry(() => {
			writes += 1;
		});
		const adapter = new FakeHerdrAdapter();
		adapter.paneGet = async () => {
			throw new Error("cancelled validation");
		};
		const controller = new AbortController();
		controller.abort();
		await expect(restoreAndValidateRecords(store, adapter, controller.signal)).rejects.toThrow(
			/cancelled validation/,
		);
		expect(store.get("herdr-agent-deadbeef-1")?.recordStatus).toBe("working");
		expect(writes).toBe(0);
	});

	it("restore validation keeps adapter failures retryable", async () => {
		const store = new AgentStore();
		store.upsert(sampleRecord({ id: "unavailable-1" }));
		const adapter = new FakeHerdrAdapter();
		adapter.paneGet = async () => {
			throw new Error("Herdr socket unavailable");
		};

		await expect(restoreAndValidateRecords(store, adapter)).resolves.toBeUndefined();
		const record = store.get("unavailable-1");
		expect(record?.lost).toBe(false);
		expect(record?.recordStatus).toBe("unavailable");
		expect(record?.error).toContain("Herdr socket unavailable");

		adapter.addPane({
			paneId: "w1:p1",
			terminalId: "term_1",
			workspaceId: "w1",
			tabId: "w1:t1",
			agentStatus: "done",
			transcript: "",
		});
		adapter.paneGet = FakeHerdrAdapter.prototype.paneGet.bind(adapter);
		await restoreAndValidateRecords(store, adapter);
		expect(store.get("unavailable-1")?.recordStatus).toBe("done");
		expect(store.get("unavailable-1")?.error).toBeUndefined();
	});
});
