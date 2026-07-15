import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import type { HerdrAdapter } from "./herdr-adapter.js";
import { createHerdrAdapter } from "./herdr-adapter.js";
import {
	type LifecycleDeps,
	getAgentResult,
	launchAgent,
	steerAgent,
	stopAgent,
} from "./lifecycle.js";
import { listProfileNames, resolveProfiles } from "./profiles.js";
import { listRoleNames, resolveRoles } from "./roles.js";
import type { AgentStore } from "./store.js";
import type { LaunchResult } from "./types.js";

const LaunchParamsSchema = Type.Object({
	role: Type.String({
		description:
			"Behavior role (general, scout, planner, executor, reviewer, researcher, or configured custom role)",
	}),
	profile: Type.Optional(
		Type.String({
			description:
				"Optional CLI profile override (normally omit to use the role default: pi, cursor, codex, claude, opencode, agy, or custom)",
		}),
	),
	prompt: Type.String({
		minLength: 1,
		maxLength: 100_000,
		description: "Task prompt submitted to the peer agent after its interactive CLI becomes idle",
	}),
	description: Type.Optional(
		Type.String({
			minLength: 1,
			maxLength: 200,
			description: "Short human-readable label stored with the agent record",
		}),
	),
	mode: Type.Optional(
		StringEnum(["foreground", "background"] as const, {
			description:
				"foreground waits for completion and returns transcript; background returns after the agent starts working",
		}),
	),
	cwd: Type.Optional(
		Type.String({
			description: "Working directory for the peer agent (defaults to current project cwd)",
		}),
	),
	workspace: Type.Optional(
		Type.String({
			description: "Herdr workspace id for launch topology (mutually exclusive with tab)",
		}),
	),
	tab: Type.Optional(
		Type.String({
			description:
				"Herdr tab id for launch topology (defaults to caller HERDR_TAB_ID; mutually exclusive with workspace)",
		}),
	),
	split: Type.Optional(
		StringEnum(["right", "down"] as const, {
			description: "Split direction for the new pane (default right)",
		}),
	),
	focus: Type.Optional(
		Type.Boolean({
			description: "Whether to focus the new pane (default false, keeps caller focus)",
		}),
	),
	startup_timeout_ms: Type.Optional(
		Type.Integer({
			minimum: 1000,
			maximum: 1_800_000,
			description: "Startup/state transition timeout in milliseconds",
		}),
	),
	completion_timeout_ms: Type.Optional(
		Type.Integer({
			minimum: 1000,
			maximum: 1_800_000,
			description: "Foreground completion timeout in milliseconds",
		}),
	),
	poll_interval_ms: Type.Optional(
		Type.Integer({
			minimum: 50,
			maximum: 60_000,
			description: "Polling interval for Herdr status checks",
		}),
	),
	transcript_lines: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 2000,
			description: "Recent-unwrapped transcript lines to return",
		}),
	),
});

type LaunchToolParams = Static<typeof LaunchParamsSchema>;

const ResultParamsSchema = Type.Object({
	agent_id: Type.String({ description: "Extension agent id returned by herdr_launch_agent" }),
	mode: Type.Optional(
		StringEnum(["poll", "wait"] as const, {
			description: "poll returns current status immediately; wait blocks until completion",
		}),
	),
	timeout_ms: Type.Optional(Type.Integer({ minimum: 1000, maximum: 1_800_000 })),
	transcript_lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
	poll_interval_ms: Type.Optional(Type.Integer({ minimum: 50, maximum: 60_000 })),
});

const SteerParamsSchema = Type.Object({
	agent_id: Type.String({ description: "Tracked extension agent id" }),
	message: Type.String({
		minLength: 1,
		maxLength: 100_000,
		description: "Follow-up prompt sent via herdr pane run",
	}),
});

const StopParamsSchema = Type.Object({
	agent_id: Type.String({ description: "Tracked extension agent id to close" }),
});

export interface ToolHost {
	store: AgentStore;
	adapter: HerdrAdapter;
	getAgentDir: () => string;
}

function formatLaunchResult(result: LaunchResult): string {
	const lines = [
		`Agent ${result.agentId}`,
		`role=${result.role} profile=${result.profile}`,
		`status=${result.status} agent_status=${result.agentStatus} seen_working=${result.seenWorking}`,
	];
	if (result.error) lines.push(`error: ${result.error}`);
	if (result.transcript) {
		lines.push(result.truncated ? "--- transcript (truncated) ---" : "--- transcript ---");
		lines.push(result.transcript);
	}
	if (result.partial) lines.push("(partial result — agent pane preserved in Herdr)");
	return lines.join("\n");
}

function makeDeps(host: ToolHost, ctx: ExtensionContext): LifecycleDeps {
	return {
		store: host.store,
		adapter: host.adapter,
		resolveProfiles: () =>
			resolveProfiles({
				agentDir: host.getAgentDir(),
				cwd: ctx.cwd,
				projectTrusted: ctx.isProjectTrusted(),
			}),
		resolveRoles: () =>
			resolveRoles({
				agentDir: host.getAgentDir(),
				cwd: ctx.cwd,
				projectTrusted: ctx.isProjectTrusted(),
			}),
	};
}

export function createHerdrAgentTools(host: ToolHost): ToolDefinition[] {
	const profileHint =
		"Profiles: pi, cursor, agy, codex, claude, opencode, plus custom entries from herdr-agents.json";
	const roleHint =
		"Roles: general, scout, planner, executor, reviewer, researcher, plus trusted custom entries from herdr-agents.json";

	return [
		defineTool({
			name: "herdr_launch_agent",
			label: "Herdr Launch Agent",
			description: `Launch a visible role-guided peer coding agent in a new Herdr pane. Roles select behavior and a default CLI profile; profile can override that runtime. Peers are independent processes with no inherited conversation context. Use background for parallel work and foreground when this turn needs the transcript. ${roleHint}. ${profileHint}`,
			promptSnippet: "Launch a visible role-guided peer agent in a Herdr pane",
			promptGuidelines: [
				"Use herdr_launch_agent only for self-contained delegation that benefits from parallelism, specialization, or independent verification; give it complete context and avoid overlapping write tasks.",
			],
			parameters: LaunchParamsSchema,
			prepareArguments(args): LaunchToolParams {
				if (!args || typeof args !== "object" || Array.isArray(args)) {
					return args as LaunchToolParams;
				}
				const input = args as Partial<LaunchToolParams>;
				return (
					input.role === undefined ? { ...input, role: "general" } : input
				) as LaunchToolParams;
			},
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				const deps = makeDeps(host, ctx);
				const roles = deps.resolveRoles();
				const role = roles[params.role];
				if (!role) {
					return {
						content: [
							{
								type: "text",
								text: `Unknown role "${params.role}". Available: ${listRoleNames(roles).join(", ")}`,
							},
						],
						details: { error: "unknown_role" },
					};
				}
				const profiles = deps.resolveProfiles();
				const profileName = params.profile ?? role.profile;
				if (!profiles[profileName]) {
					return {
						content: [
							{
								type: "text",
								text: `Unknown profile "${profileName}" selected for role "${params.role}". Available: ${listProfileNames(profiles).join(", ")}`,
							},
						],
						details: { error: "unknown_profile" },
					};
				}

				const result = await launchAgent(
					deps,
					ctx,
					{
						role: params.role,
						profile: params.profile,
						prompt: params.prompt,
						description: params.description,
						mode: params.mode,
						cwd: params.cwd,
						workspace: params.workspace,
						tab: params.tab,
						split: params.split,
						focus: params.focus,
						startupTimeoutMs: params.startup_timeout_ms,
						completionTimeoutMs: params.completion_timeout_ms,
						pollIntervalMs: params.poll_interval_ms,
						transcriptLines: params.transcript_lines,
					},
					signal,
				);

				return {
					content: [{ type: "text", text: formatLaunchResult(result) }],
					details: result,
				};
			},
		}),
		defineTool({
			name: "herdr_get_agent_result",
			label: "Herdr Get Agent Result",
			description:
				"Poll or wait for a previously launched Herdr peer agent by extension agent id. Completion is reported only after the agent has been seen working, then reaches idle or done.",
			promptSnippet: "Poll or wait for a launched Herdr peer agent result",
			promptGuidelines: [
				"Use herdr_get_agent_result with saved agent IDs to collect background peer work; review the transcript critically before using it.",
			],
			parameters: ResultParamsSchema,
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				const deps = makeDeps(host, ctx);
				const result = await getAgentResult(
					deps,
					{
						agentId: params.agent_id,
						mode: params.mode,
						timeoutMs: params.timeout_ms,
						transcriptLines: params.transcript_lines,
						pollIntervalMs: params.poll_interval_ms,
					},
					signal,
				);

				const lines = [
					`Agent ${result.agentId}`,
					`role=${result.role} profile=${result.profile}`,
					`status=${result.status} agent_status=${result.agentStatus} complete=${result.complete}`,
					`seen_working=${result.seenWorking}`,
				];
				if (result.error) lines.push(`error: ${result.error}`);
				if (result.transcript) {
					lines.push(result.truncated ? "--- transcript (truncated) ---" : "--- transcript ---");
					lines.push(result.transcript);
				}

				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: result,
				};
			},
		}),
		defineTool({
			name: "herdr_steer_agent",
			label: "Herdr Steer Agent",
			description:
				"Send a follow-up prompt to a tracked Herdr peer agent via pane run. Only works for live agents launched by this extension.",
			promptSnippet: "Redirect or clarify a live Herdr peer agent",
			parameters: SteerParamsSchema,
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				const deps = makeDeps(host, ctx);
				const record = await steerAgent(
					deps,
					{ agentId: params.agent_id, message: params.message },
					signal,
				);
				return {
					content: [
						{
							type: "text",
							text: `Steered agent ${record.id} (status=${record.recordStatus}, agent_status=${record.agentStatus})`,
						},
					],
					details: record,
				};
			},
		}),
		defineTool({
			name: "herdr_stop_agent",
			label: "Herdr Stop Agent",
			description:
				"Close a Herdr pane owned by this extension after revalidating pane/terminal/workspace/tab identity. Will not close arbitrary panes.",
			promptSnippet: "Safely close an owned Herdr peer pane",
			promptGuidelines: [
				"Use herdr_stop_agent when a peer is no longer needed unless the user explicitly wants its pane preserved.",
			],
			parameters: StopParamsSchema,
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				const deps = makeDeps(host, ctx);
				const record = await stopAgent(deps, { agentId: params.agent_id }, signal);
				return {
					content: [
						{
							type: "text",
							text: `Stopped agent ${record.id} (status=${record.recordStatus})`,
						},
					],
					details: record,
				};
			},
		}),
	];
}

export function createDefaultAdapter(
	exec: (
		command: string,
		args: string[],
		options?: { signal?: AbortSignal; timeout?: number },
	) => Promise<{ stdout: string; stderr: string; code: number | null; killed: boolean }>,
): HerdrAdapter {
	return createHerdrAdapter(exec);
}
