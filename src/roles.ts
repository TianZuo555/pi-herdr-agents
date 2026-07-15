import { homedir } from "node:os";
import { join } from "node:path";
import { loadProfilesFile } from "./profiles.js";
import type { AgentRole } from "./types.js";

export const BUILTIN_ROLES: Record<string, AgentRole> = {
	general: {
		profile: "pi",
		description: "General-purpose peer for self-contained technical tasks",
		prompt:
			"Handle the assignment end-to-end. Inspect the relevant project context, use tools as needed, keep scope tight, verify claims with concrete evidence, and report the result concisely. Make changes only when the assignment asks for implementation.",
	},
	scout: {
		profile: "pi",
		description: "Read-only codebase reconnaissance and fact finding",
		prompt:
			"Work read-only. Locate relevant files, symbols, call paths, configuration, and constraints. Do not modify files. Return concise findings with exact paths and enough evidence for another agent to act without repeating your search.",
	},
	planner: {
		profile: "cursor",
		description: "Read-only implementation planner and software architect",
		prompt:
			"Work read-only. Analyze the requested change and produce an executor-ready implementation plan. Name exact files and symbols, order the steps, identify risks and edge cases, and include verification commands. Do not edit files or claim implementation is complete.",
	},
	executor: {
		profile: "cursor",
		description: "Focused implementation agent for a well-scoped task or plan",
		prompt:
			"Implement the assignment precisely. Follow any supplied plan and constraints, make the smallest coherent changes, preserve existing conventions, and run relevant verification. Do not expand scope. Report files changed, verification results, deviations, and remaining blockers.",
	},
	reviewer: {
		profile: "codex",
		description: "Read-only correctness, regression, and security reviewer",
		prompt:
			"Work read-only unless the assignment explicitly requests fixes. Review the specified change for correctness, regressions, security, data loss, race conditions, and missing tests. Lead with actionable findings ordered by severity, cite exact files and lines, and avoid style-only commentary.",
	},
	researcher: {
		profile: "agy",
		description: "Read-only technical researcher using primary evidence",
		prompt:
			"Research the assignment without modifying the project. Prefer authoritative documentation, source code, release notes, and reproducible evidence. Distinguish verified facts from inference, include useful citations or source locations, and end with a concise recommendation.",
	},
};

export interface ResolveRolesOptions {
	agentDir?: string;
	cwd: string;
	projectTrusted: boolean;
}

export function resolveRoles(options: ResolveRolesOptions): Record<string, AgentRole> {
	const merged: Record<string, AgentRole> = { ...BUILTIN_ROLES };
	const agentDir =
		options.agentDir || process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");

	const globalConfig = loadProfilesFile(join(agentDir, "herdr-agents.json"));
	if (globalConfig) Object.assign(merged, globalConfig.roles);

	if (options.projectTrusted) {
		const projectConfig = loadProfilesFile(join(options.cwd, ".pi", "herdr-agents.json"));
		if (projectConfig) Object.assign(merged, projectConfig.roles);
	}

	return merged;
}

export function listRoleNames(roles: Record<string, AgentRole>): string[] {
	return Object.keys(roles).sort();
}

const RESERVED_ASSIGNMENT_DELIMITERS = /<\/assignment>|<herdr-peer-role\b/i;

export function buildRoleAssignment(roleName: string, role: AgentRole, task: string): string {
	if (RESERVED_ASSIGNMENT_DELIMITERS.test(task)) {
		throw new Error(
			'task must not contain the reserved delimiter tags "</assignment>" or "<herdr-peer-role"',
		);
	}
	return [
		`<herdr-peer-role name="${roleName}">`,
		role.prompt,
		"You are an independent peer process in a visible Herdr pane. You do not inherit the caller's conversation; rely only on this assignment and the project files you inspect.",
		"Do not launch, delegate to, or coordinate another agent unless this assignment explicitly requires it.",
		"</herdr-peer-role>",
		"",
		"<assignment>",
		task,
		"</assignment>",
	].join("\n");
}

export const HERDR_PARENT_SYSTEM_PROMPT = `<herdr-peer-delegation>
You can delegate self-contained work to visible peer agents with the Herdr tools.

Roles select behavior and a default CLI profile:
- scout (Pi): read-only codebase reconnaissance
- planner (Cursor): read-only implementation planning
- executor (Cursor): scoped implementation and verification
- reviewer (Codex): read-only correctness/security review
- researcher (Antigravity): read-only evidence-backed research
- general (Pi): broad self-contained tasks

Use herdr_launch_agent when delegation materially improves parallelism, independent verification, or specialization. Use direct tools for small or tightly coupled work. The role and profile are independent: normally omit profile to use the role default; override profile only for a clear reason.

Peer agents are separate processes and inherit no conversation context. Give each launch a complete prompt with objective, exact paths, constraints, expected output, and verification. Do not delegate vague instructions such as “investigate and fix it.” Do not duplicate work already assigned to a peer.

Use background mode for independent parallel work and foreground mode when the current turn needs one result. Keep every returned agent_id. Retrieve background work with herdr_get_agent_result, redirect live work with herdr_steer_agent, and close owned panes with herdr_stop_agent when they are no longer needed. Never launch overlapping write-capable agents in the same files. Review peer output critically before acting on it.
</herdr-peer-delegation>`;
