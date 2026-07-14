import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseProfilesConfig } from "../src/profiles.js";
import { BUILTIN_ROLES, buildRoleAssignment, resolveRoles } from "../src/roles.js";

describe("roles", () => {
	it("maps built-in roles to intended default profiles", () => {
		expect(BUILTIN_ROLES.scout.profile).toBe("pi");
		expect(BUILTIN_ROLES.planner.profile).toBe("cursor");
		expect(BUILTIN_ROLES.executor.profile).toBe("cursor");
		expect(BUILTIN_ROLES.reviewer.profile).toBe("codex");
		expect(BUILTIN_ROLES.researcher.profile).toBe("agy");
	});

	it("wraps a task with trusted role instructions", () => {
		const assignment = buildRoleAssignment("reviewer", BUILTIN_ROLES.reviewer, "Review src/x.ts");
		expect(assignment).toContain('<herdr-peer-role name="reviewer">');
		expect(assignment).toContain("Work read-only");
		expect(assignment).toContain("<assignment>\nReview src/x.ts\n</assignment>");
	});

	it("merges global and trusted project custom roles", () => {
		const root = mkdtempSync(join(tmpdir(), "herdr-roles-"));
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			join(agentDir, "herdr-agents.json"),
			JSON.stringify({
				roles: {
					triage: { profile: "pi", description: "Global triage", prompt: "Read only." },
				},
			}),
		);
		writeFileSync(
			join(cwd, ".pi", "herdr-agents.json"),
			JSON.stringify({
				roles: {
					triage: {
						profile: "codex",
						description: "Project triage",
						prompt: "Inspect regressions only.",
					},
				},
			}),
		);

		expect(resolveRoles({ agentDir, cwd, projectTrusted: false }).triage.profile).toBe("pi");
		expect(resolveRoles({ agentDir, cwd, projectTrusted: true }).triage.profile).toBe("codex");
	});

	it("rejects malformed custom roles", () => {
		expect(() =>
			parseProfilesConfig(
				{ roles: { bad: { profile: "pi", description: "Bad", prompt: "" } } },
				"test",
			),
		).toThrow(/prompt/);
	});
});
