import { describe, expect, it } from "vitest";
import { MARKER_PREFIX, formatMarker } from "../scripts/probe-marker-echo.js";
import { buildRoleAssignment } from "../src/roles.js";

/**
 * Drift guard: the standalone probe (scripts/probe-marker-echo.ts) cannot import
 * from src/ because plain `node` type-stripping does not remap .js→.ts specifiers
 * the way vitest does. It therefore re-declares the marker format. This test
 * fails if that copy ever diverges from what buildRoleAssignment actually emits,
 * so a green probe can never be validating the wrong string.
 */
describe("marker-echo probe contract", () => {
	it("probe marker line matches buildRoleAssignment output", () => {
		const marker = "agent-x-deadbeef";
		const assignment = buildRoleAssignment(
			"scout",
			{ profile: "pi", description: "d", prompt: "p", writeAccess: "none" },
			"task",
			marker,
		);
		expect(assignment).toContain(formatMarker(marker));
	});

	it("waitForSubmissionEcho search string matches the probe fence", () => {
		// lifecycle.ts waitForSubmissionEcho searches for exactly this substring.
		const marker = "m123";
		expect(`[herdr-task-marker:${marker}]`).toBe(formatMarker(marker));
		expect(MARKER_PREFIX).toBe("herdr-task-marker");
	});
});
