import type { HerdrAdapter } from "./herdr-adapter.js";
import { validateLiveRecord } from "./store.js";
import type { AgentStore } from "./store.js";

export interface SlotPlacement {
	/** Slot to anchor on, or null when the anchor is the caller's own pane (slot 1). */
	anchorSlot: number | null;
	direction: "right" | "down";
}

/**
 * Column-fill grid math: every third slot starts a new column anchored on the
 * previous column's top slot; the other two of each triplet stack downward
 * under the previous slot in the same column.
 */
export function computeSlotPlacement(slot: number): SlotPlacement {
	if (!Number.isInteger(slot) || slot < 1) {
		throw new Error(`layout slot must be a positive integer, got ${slot}`);
	}
	const column = Math.ceil(slot / 3);
	const rowInColumn = ((slot - 1) % 3) + 1;
	if (rowInColumn === 1) {
		if (column === 1) return { anchorSlot: null, direction: "right" };
		return { anchorSlot: (column - 2) * 3 + 1, direction: "right" };
	}
	return { anchorSlot: slot - 1, direction: "down" };
}

export interface AnchorResolution {
	targetPaneId: string;
	split: "right" | "down";
}

/**
 * Resolves a slot's computed anchor to a live pane id, falling back to the
 * caller's own pane (with a "right" split) whenever the anchor record is
 * missing, stopped, lost, or its identity no longer matches Herdr.
 */
export async function resolveLayoutAnchor(
	adapter: HerdrAdapter,
	store: AgentStore,
	tabId: string,
	callerPaneId: string,
	slot: number,
	signal?: AbortSignal,
): Promise<AnchorResolution> {
	const placement = computeSlotPlacement(slot);
	if (placement.anchorSlot === null) {
		return { targetPaneId: callerPaneId, split: placement.direction };
	}

	const anchorRecord = store
		.list()
		.find((record) => record.layoutTabId === tabId && record.layoutSlot === placement.anchorSlot);
	if (!anchorRecord || anchorRecord.stopped || anchorRecord.lost) {
		return { targetPaneId: callerPaneId, split: "right" };
	}

	const validated = await validateLiveRecord(adapter, anchorRecord, signal);
	if (validated.lost) {
		return { targetPaneId: callerPaneId, split: "right" };
	}
	return { targetPaneId: anchorRecord.identity.paneId, split: placement.direction };
}
