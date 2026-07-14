import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	BUILTIN_PROFILES,
	loadProfilesFile,
	parseProfilesConfig,
	resolveProfiles,
} from "../src/profiles.js";

describe("profiles", () => {
	it("merges built-in < global < trusted project", () => {
		const root = mkdtempSync(join(tmpdir(), "herdr-profiles-"));
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		writeFileSync(
			join(agentDir, "herdr-agents.json"),
			JSON.stringify({
				profiles: {
					pi: { argv: ["pi-global"], description: "global override" },
					custom: { argv: ["my-agent"], description: "global custom" },
				},
			}),
		);
		const piDir = join(cwd, ".pi");
		mkdirSync(piDir, { recursive: true });
		writeFileSync(
			join(piDir, "herdr-agents.json"),
			JSON.stringify({
				profiles: {
					custom: { argv: ["project-agent"], description: "project custom" },
				},
			}),
		);

		const trusted = resolveProfiles({ agentDir, cwd, projectTrusted: true });
		expect(trusted.pi.argv).toEqual(["pi-global"]);
		expect(trusted.custom.argv).toEqual(["project-agent"]);

		const untrusted = resolveProfiles({ agentDir, cwd, projectTrusted: false });
		expect(untrusted.custom.argv).toEqual(["my-agent"]);
	});

	it("rejects malformed config", () => {
		expect(() =>
			parseProfilesConfig({ profiles: { bad: { argv: [], description: "x" } } }, "test"),
		).toThrow(/non-empty argv/);
		expect(() =>
			parseProfilesConfig({ profiles: { "1bad": { argv: ["x"], description: "x" } } }, "test"),
		).toThrow(/Invalid profile name/);
	});

	it("includes all built-in profiles", () => {
		for (const name of ["pi", "cursor", "agy", "codex", "claude", "opencode"]) {
			expect(BUILTIN_PROFILES[name]).toBeDefined();
			expect(BUILTIN_PROFILES[name].argv.length).toBeGreaterThan(0);
		}
		expect(BUILTIN_PROFILES.agy.argv).toEqual(["agy"]);
	});

	it("loadProfilesFile returns undefined for missing file", () => {
		expect(loadProfilesFile("/nonexistent/herdr-agents.json")).toBeUndefined();
	});
});
