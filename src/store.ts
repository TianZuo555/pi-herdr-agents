import { isDeepStrictEqual } from "node:util";
import type { HerdrAdapter } from "./types.js";
import type { AgentRecord, SnapshotV1 } from "./types.js";
import {
	SNAPSHOT_CUSTOM_TYPE,
	SNAPSHOT_VERSION,
	identitiesMatch,
	isCompletionStatus,
} from "./types.js";

type AppendEntryHandler = (customType: string, data?: unknown) => void;

const BUILTIN_READ_ONLY_ROLES = new Set(["scout", "planner", "reviewer", "researcher"]);

function inferLegacyWriteAccess(record: AgentRecord): "none" | "workspace" {
	return record.role && BUILTIN_READ_ONLY_ROLES.has(record.role) ? "none" : "workspace";
}

function inferLegacySubmissionState(record: AgentRecord): AgentRecord["submissionState"] {
	if (record.seenWorking || record.agentStatus === "working") return "acknowledged";
	if (["launching", "starting", "blocked"].includes(record.recordStatus)) return "pending";
	return "submitted";
}

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
		(record.prompt === undefined || typeof record.prompt === "string") &&
		typeof record.cwd === "string" &&
		(record.writeAccess === undefined ||
			record.writeAccess === "none" ||
			record.writeAccess === "workspace") &&
		(record.submissionState === undefined ||
			record.submissionState === "pending" ||
			record.submissionState === "submitted" ||
			record.submissionState === "acknowledged") &&
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
	private pendingAssignments = new Map<string, string>();
	private writeReservations = new Map<string, string>();

	setAppendEntry(handler: AppendEntryHandler): void {
		this.appendEntry = handler;
	}

	loadSnapshot(snapshot: SnapshotV1): void {
		this.records.clear();
		this.pendingAssignments.clear();
		this.writeReservations.clear();
		for (const record of snapshot.records) {
			if (!isAgentRecord(record)) continue;
			const copy = structuredClone(record);
			// Prompt text from legacy snapshots is deliberately discarded. The
			// session already contains the original tool call; fleet snapshots only
			// retain operational metadata.
			copy.prompt = undefined;
			copy.writeAccess ??= inferLegacyWriteAccess(copy);
			copy.submissionState ??= inferLegacySubmissionState(copy);
			this.records.set(copy.id, copy);
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
		else this.clear();
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
		copy.prompt = undefined;
		const existing = this.records.get(copy.id);
		this.records.set(copy.id, copy);
		this.writeReservations.delete(copy.id);
		if (!existing || !isDeepStrictEqual(existing, copy)) this.persist();
		return structuredClone(copy);
	}

	mutate(id: string, update: (record: AgentRecord) => void): AgentRecord | undefined {
		const existing = this.records.get(id);
		if (!existing) return undefined;
		const copy = structuredClone(existing);
		update(copy);
		copy.prompt = undefined;
		if (isDeepStrictEqual(existing, copy)) return structuredClone(existing);
		this.records.set(id, copy);
		this.persist();
		return structuredClone(copy);
	}

	/** Atomically reserve a workspace write lease before agentStart awaits. */
	reserveWriteLease(agentId: string, cwd: string): string | undefined {
		for (const [reservedId, reservedCwd] of this.writeReservations) {
			if (reservedId !== agentId && reservedCwd === cwd) return reservedId;
		}
		for (const record of this.records.values()) {
			if (record.id === agentId || record.cwd !== cwd) continue;
			if ((record.writeAccess ?? "workspace") !== "workspace") continue;
			if (record.stopped || record.lost) continue;
			if (isCompletionStatus(record.agentStatus, record.seenWorking)) continue;
			return record.id;
		}
		this.writeReservations.set(agentId, cwd);
		return undefined;
	}

	releaseWriteLease(agentId: string): void {
		this.writeReservations.delete(agentId);
	}

	setPendingAssignment(agentId: string, assignment: string): void {
		this.pendingAssignments.set(agentId, assignment);
	}

	getPendingAssignment(agentId: string): string | undefined {
		return this.pendingAssignments.get(agentId);
	}

	clearPendingAssignment(agentId: string): void {
		this.pendingAssignments.delete(agentId);
	}

	/**
	 * Next free column-fill layout slot for a tab. Callers must claim the
	 * returned value via upsert() with zero `await` in between.
	 */
	reserveLayoutSlot(tabId: string): number {
		let max = 0;
		for (const record of this.records.values()) {
			if (record.layoutTabId !== tabId) continue;
			if (record.stopped || record.lost) continue;
			if (record.layoutSlot !== undefined && record.layoutSlot > max) max = record.layoutSlot;
		}
		return max + 1;
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
		this.pendingAssignments.clear();
		this.writeReservations.clear();
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
	const seenWorking = record.seenWorking || liveStatus === "working";
	const recordStatus =
		liveStatus === "working"
			? "working"
			: liveStatus === "blocked"
				? "blocked"
				: isCompletionStatus(liveStatus, seenWorking)
					? liveStatus
					: liveStatus === "unknown"
						? "unknown"
						: "starting";
	const validated = structuredClone(record);
	validated.agentStatus = liveStatus;
	validated.recordStatus = recordStatus;
	validated.seenWorking = seenWorking;
	if (record.recordStatus === "unavailable") validated.error = undefined;
	return validated;
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
			if (signal?.aborted) throw error;
			validated.push({
				...record,
				lost: false,
				recordStatus: "unavailable",
				error: `Unable to validate restored pane: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
	}
	const next: SnapshotV1 = { version: SNAPSHOT_VERSION, records: validated };
	if (isDeepStrictEqual(snapshot, next)) return;
	store.loadSnapshot(next);
	store.persist();
}
