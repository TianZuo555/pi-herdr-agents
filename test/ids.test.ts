import { describe, expect, it } from "vitest";
import { generateAgentId, generateTaskMarker, makeHerdrAgentName } from "../src/ids.js";

describe("agent identifiers", () => {
	it("keeps cross-process randomness in the Herdr reconciliation name", () => {
		const first = makeHerdrAgentName("reviewer-codex", "herdr-agent-a1b2c3d4-1");
		const afterReload = makeHerdrAgentName("reviewer-codex", "herdr-agent-deadbeef-1");
		expect(first).not.toBe(afterReload);
		expect(first).toContain("a1b2c3d4-1");
		expect(afterReload).toContain("deadbeef-1");
	});

	it("generates a fresh task marker for every submission attempt", () => {
		const agentId = generateAgentId();
		expect(generateTaskMarker(agentId)).not.toBe(generateTaskMarker(agentId));
	});
});
