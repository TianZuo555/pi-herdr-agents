import type { HerdrAdapter } from "./types.js";
import type { AgentRecord, SnapshotV1 } from "./types.js";
import { SNAPSHOT_CUSTOM_TYPE, SNAPSHOT_VERSION, identitiesMatch } from "./types.js";

type AppendEntryHandler = (customType: string, data?: unknown) => void;

function isAgentRecord(value: unknown): value is AgentRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	const identity = record.identity;
	if (!identity || typeof identity !== "object") return false;
	const identityObject = identity as Record<string, unknown>;
	return (
		typeof record.id === "string" &&
		(record.role === undefined || typeof record.role === "string") &&
		typeof record.profile === "string" &&
		typeof record.prompt === "string" &&
		typeof record.cwd === "string" &&
		typeof identityObject.paneId === "string" &&
		typeof identityObject.terminalId === "string" &&
		typeof identityObject.workspaceId === "string" &&
		typeof identityObject.tabId === "string" &&
		typeof record.seenWorking === "boolean" &&
		record.owned === true &&
		typeof record.stopped === "boolean" &&
		typeof record.lost === "boolean"
	);
}

function isSnapshot(value: unknown): value is SnapshotV1 {
	if (!value || typeof value !== "object") return false;
	const snapshot = value as Record<string, unknown>;
	return (
		snapshot.version === SNAPSHOT_VERSION &&
		Array.isArray(snapshot.records) &&
		snapshot.records.every((record) => isAgentRecord(record))
	);
}

export class AgentStore {
	private records = new Map<string, AgentRecord>();
	private appendEntry?: AppendEntryHandler;

	setAppendEntry(handler: AppendEntryHandler): void {
		this.appendEntry = handler;
	}

	loadSnapshot(snapshot: SnapshotV1): void {
		this.records.clear();
		for (const record of snapshot.records) {
			if (isAgentRecord(record)) this.records.set(record.id, structuredClone(record));
		}
	}

	restoreFromBranch(
		entries: Array<{ type: string; customType?: string; data?: unknown }>,
	): SnapshotV1 | undefined {
		let latest: SnapshotV1 | undefined;
		for (const entry of entries) {
			if (entry.type !== "custom" || entry.customType !== SNAPSHOT_CUSTOM_TYPE) continue;
			if (!isSnapshot(entry.data)) continue;
			latest = structuredClone(entry.data);
		}
		if (latest) this.loadSnapshot(latest);
		else this.records.clear();
		return latest;
	}

	get(id: string): AgentRecord | undefined {
		const record = this.records.get(id);
		return record ? structuredClone(record) : undefined;
	}

	list(): AgentRecord[] {
		return [...this.records.values()].map((record) => structuredClone(record));
	}

	upsert(record: AgentRecord): AgentRecord {
		const copy = structuredClone(record);
		this.records.set(copy.id, copy);
		this.persist();
		return structuredClone(copy);
	}

	mutate(id: string, update: (record: AgentRecord) => void): AgentRecord | undefined {
		const existing = this.records.get(id);
		if (!existing) return undefined;
		const copy = structuredClone(existing);
		update(copy);
		this.records.set(id, copy);
		this.persist();
		return structuredClone(copy);
	}

	persist(): void {
		const snapshot: SnapshotV1 = {
			version: SNAPSHOT_VERSION,
			records: this.list(),
		};
		this.appendEntry?.(SNAPSHOT_CUSTOM_TYPE, snapshot);
	}

	clear(): void {
		this.records.clear();
	}

	toSnapshot(): SnapshotV1 {
		return {
			version: SNAPSHOT_VERSION,
			records: this.list(),
		};
	}
}

export async function validateLiveRecord(
	adapter: HerdrAdapter,
	record: AgentRecord,
	signal?: AbortSignal,
): Promise<AgentRecord> {
	if (record.stopped || record.lost) return structuredClone(record);

	const paneInfo = await adapter.paneGet(record.identity.paneId, signal);
	if (!paneInfo) {
		return {
			...structuredClone(record),
			lost: true,
			recordStatus: "lost",
			error: "Pane no longer exists in Herdr",
		};
	}

	if (!identitiesMatch(record.identity, paneInfo.pane)) {
		return {
			...structuredClone(record),
			lost: true,
			recordStatus: "lost",
			error: "Pane identity no longer matches the stored record",
		};
	}

	const liveStatus = paneInfo.pane.agent_status;
	return {
		...structuredClone(record),
		agentStatus: liveStatus,
		seenWorking: record.seenWorking || liveStatus === "working",
	};
}

export async function restoreAndValidateRecords(
	store: AgentStore,
	adapter: HerdrAdapter,
	signal?: AbortSignal,
): Promise<void> {
	const snapshot = store.toSnapshot();
	const validated: AgentRecord[] = [];
	for (const record of snapshot.records) {
		if (record.stopped) {
			validated.push(record);
			continue;
		}
		try {
			const live = await validateLiveRecord(adapter, record, signal);
			validated.push(live);
		} catch (error) {
			validated.push({
				...record,
				lost: true,
				recordStatus: "lost",
				error: `Unable to validate restored pane: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
	}
	store.loadSnapshot({ version: SNAPSHOT_VERSION, records: validated });
	store.persist();
}
