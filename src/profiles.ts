import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentProfile, AgentRole, ProfilesConfig } from "./types.js";

const PROFILE_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

export const BUILTIN_PROFILES: Record<string, AgentProfile> = {
	pi: {
		argv: ["pi"],
		description: "Pi coding agent interactive TUI",
	},
	cursor: {
		argv: ["cursor-agent"],
		description: "Cursor agent CLI",
	},
	agy: {
		argv: ["agy"],
		description: "Antigravity interactive agent",
	},
	codex: {
		argv: ["codex"],
		description: "OpenAI Codex CLI",
	},
	claude: {
		argv: ["claude"],
		description: "Claude Code CLI",
	},
	opencode: {
		argv: ["opencode"],
		description: "OpenCode CLI",
	},
};

export function validateProfileName(name: string): string | undefined {
	if (!PROFILE_NAME_PATTERN.test(name)) {
		return `Invalid profile name "${name}": use lowercase letters, digits, underscore, or hyphen (max 32 chars, must start with a letter)`;
	}
	return undefined;
}

export function validateArgv(argv: unknown, profileName: string): string | undefined {
	if (!Array.isArray(argv) || argv.length === 0) {
		return `Profile "${profileName}" must have a non-empty argv array`;
	}
	if (argv.length > 64) return `Profile "${profileName}" argv exceeds 64 elements`;
	for (const [index, element] of argv.entries()) {
		if (typeof element !== "string" || element.length === 0) {
			return `Profile "${profileName}" argv[${index}] must be a non-empty string`;
		}
		if (element.length > 4096) {
			return `Profile "${profileName}" argv[${index}] exceeds 4096 characters`;
		}
		if (element.includes("\0")) {
			return `Profile "${profileName}" argv[${index}] contains invalid characters`;
		}
	}
	return undefined;
}

export function parseProfilesConfig(raw: unknown, source: string): ProfilesConfig {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error(`${source}: expected a JSON object`);
	}
	const obj = raw as Record<string, unknown>;
	if (!("profiles" in obj) && !("roles" in obj)) {
		throw new Error(`${source}: expected a "profiles" or "roles" object`);
	}

	const profilesRaw = obj.profiles ?? {};
	if (profilesRaw === null || typeof profilesRaw !== "object" || Array.isArray(profilesRaw)) {
		throw new Error(`${source}: "profiles" must be an object`);
	}
	const rolesRaw = obj.roles ?? {};
	if (rolesRaw === null || typeof rolesRaw !== "object" || Array.isArray(rolesRaw)) {
		throw new Error(`${source}: "roles" must be an object`);
	}

	const profiles: Record<string, AgentProfile> = {};
	for (const [name, value] of Object.entries(profilesRaw)) {
		const nameError = validateProfileName(name);
		if (nameError) throw new Error(`${source}: ${nameError}`);

		if (value === null || typeof value !== "object" || Array.isArray(value)) {
			throw new Error(`${source}: profile "${name}" must be an object`);
		}
		const profileObj = value as Record<string, unknown>;
		const argvError = validateArgv(profileObj.argv, name);
		if (argvError) throw new Error(`${source}: ${argvError}`);

		const description = profileObj.description;
		if (
			description !== undefined &&
			(typeof description !== "string" || description.trim().length === 0)
		) {
			throw new Error(
				`${source}: profile "${name}" description must be a non-empty string when provided`,
			);
		}

		profiles[name] = {
			argv: [...(profileObj.argv as string[])],
			description: description?.trim() || name,
		};
	}

	const roles: Record<string, AgentRole> = {};
	for (const [name, value] of Object.entries(rolesRaw)) {
		const nameError = validateProfileName(name);
		if (nameError) throw new Error(`${source}: ${nameError.replace("profile", "role")}`);
		if (value === null || typeof value !== "object" || Array.isArray(value)) {
			throw new Error(`${source}: role "${name}" must be an object`);
		}
		const roleObj = value as Record<string, unknown>;
		if (typeof roleObj.profile !== "string" || validateProfileName(roleObj.profile)) {
			throw new Error(`${source}: role "${name}" profile must be a valid profile name`);
		}
		if (
			typeof roleObj.description !== "string" ||
			roleObj.description.trim().length === 0 ||
			roleObj.description.length > 500
		) {
			throw new Error(`${source}: role "${name}" description must be 1-500 characters`);
		}
		if (
			typeof roleObj.prompt !== "string" ||
			roleObj.prompt.trim().length === 0 ||
			roleObj.prompt.length > 20_000 ||
			roleObj.prompt.includes("\0")
		) {
			throw new Error(`${source}: role "${name}" prompt must be 1-20000 safe characters`);
		}
		const writeAccess = roleObj.writeAccess ?? "workspace";
		if (writeAccess !== "none" && writeAccess !== "workspace") {
			throw new Error(`${source}: role "${name}" writeAccess must be "none" or "workspace"`);
		}
		roles[name] = {
			profile: roleObj.profile,
			description: roleObj.description.trim(),
			prompt: roleObj.prompt.trim(),
			writeAccess,
		};
	}

	return { profiles, roles };
}

export function loadProfilesFile(path: string): ProfilesConfig | undefined {
	if (!existsSync(path)) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`${path}: invalid JSON (${message})`);
	}
	return parseProfilesConfig(parsed, path);
}

export interface ResolveProfilesOptions {
	agentDir?: string;
	cwd: string;
	projectTrusted: boolean;
}

export function resolveProfiles(options: ResolveProfilesOptions): Record<string, AgentProfile> {
	const merged: Record<string, AgentProfile> = { ...BUILTIN_PROFILES };
	const agentDir =
		options.agentDir || process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");

	const globalPath = join(agentDir, "herdr-agents.json");
	const globalConfig = loadProfilesFile(globalPath);
	if (globalConfig) {
		Object.assign(merged, globalConfig.profiles);
	}

	if (options.projectTrusted) {
		const projectPath = join(options.cwd, ".pi", "herdr-agents.json");
		const projectConfig = loadProfilesFile(projectPath);
		if (projectConfig) {
			Object.assign(merged, projectConfig.profiles);
		}
	}

	return merged;
}

export function getProfile(
	profiles: Record<string, AgentProfile>,
	name: string,
): AgentProfile | undefined {
	return profiles[name];
}

export function listProfileNames(profiles: Record<string, AgentProfile>): string[] {
	return Object.keys(profiles).sort();
}
