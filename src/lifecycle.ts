import { statSync } from "node:fs";
import { resolve } from "node:path";
import { requireHerdrContext } from "./env.js";
import type { HerdrAdapter } from "./herdr-adapter.js";
import { generateAgentId, makeHerdrAgentName } from "./ids.js";
import { PollAbortedError, PollTimeoutError, pollUntil } from "./poll.js";
import { getProfile } from "./profiles.js";
import { buildRoleAssignment } from "./roles.js";
import type { AgentStore } from "./store.js";
import { validateLiveRecord } from "./store.js";
import type {
	AgentIdentity,
	AgentProfile,
	AgentRecord,
	AgentRole,
	AgentResult,
	AgentResultParams,
	AgentStatus,
	HerdrContext,
	LaunchParams,
	LaunchResult,
	PollOptions,
	RecordStatus,
} from "./types.js";
import {
	DEFAULT_COMPLETION_TIMEOUT_MS,
	DEFAULT_POLL_INTERVAL_MS,
	DEFAULT_RESULT_TIMEOUT_MS,
	DEFAULT_STARTUP_TIMEOUT_MS,
	DEFAULT_TRANSCRIPT_LINES,
	isCompletionStatus,
} from "./types.js";

export interface LifecycleDeps {
	store: AgentStore;
	adapter: HerdrAdapter;
	resolveProfiles: () => Record<string, AgentProfile>;
	resolveRoles: () => Record<string, AgentRole>;
}

class PaneMissingError extends Error {
	constructor() {
		super("Agent pane no longer exists in Herdr");
		this.name = "PaneMissingError";
	}
}

function boundedNumber(
	value: number | undefined,
	fallback: number,
	min: number,
	max: number,
): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.floor(value)));
}

function resolveCwd(cwd: string | undefined, fallback: string): string {
	return resolve(cwd || fallback);
}

function mapAgentStatusToRecordStatus(
	status: AgentStatus,
	seenWorking: boolean,
	stopped: boolean,
	lost: boolean,
): RecordStatus {
	if (lost) return "lost";
	if (stopped) return "stopped";
	if (status === "blocked") return "blocked";
	if (status === "working") return "working";
	if (isCompletionStatus(status, seenWorking)) return status;
	if (status === "unknown") return "unknown";
	return seenWorking ? "idle" : "starting";
}

function buildPartialResult(
	record: AgentRecord,
	options: {
		transcript?: string;
		truncated?: boolean;
		error?: string;
		partial?: boolean;
		recordStatus?: RecordStatus;
	},
): LaunchResult {
	return {
		agentId: record.id,
		role: record.role ?? "general",
		profile: record.profile,
		status: options.recordStatus ?? record.recordStatus,
		agentStatus: record.agentStatus,
		seenWorking: record.seenWorking,
		transcript: options.transcript,
		truncated: options.truncated,
		error: options.error ?? record.error,
		partial: options.partial ?? true,
	};
}

async function readTranscript(
	adapter: HerdrAdapter,
	paneId: string,
	lines: number,
	signal?: AbortSignal,
): Promise<{ text: string; truncated: boolean } | undefined> {
	const read = await adapter.paneRead(paneId, lines, signal);
	return read ? { text: read.read.text, truncated: read.read.truncated } : undefined;
}

function identityFromPane(pane: {
	pane_id: string;
	terminal_id: string;
	workspace_id: string;
	tab_id: string;
}): AgentIdentity {
	return {
		paneId: pane.pane_id,
		terminalId: pane.terminal_id,
		workspaceId: pane.workspace_id,
		tabId: pane.tab_id,
	};
}

function updateRecordFromPane(
	record: AgentRecord,
	status: AgentStatus,
	options?: { promptSubmitted?: boolean },
): AgentRecord {
	const seenWorking =
		record.seenWorking ||
		status === "working" ||
		(options?.promptSubmitted === true && status === "done");
	return {
		...record,
		agentStatus: status,
		seenWorking,
		startedWorkingAt:
			!record.startedWorkingAt && (status === "working" || seenWorking)
				? Date.now()
				: record.startedWorkingAt,
		recordStatus: mapAgentStatusToRecordStatus(status, seenWorking, record.stopped, record.lost),
	};
}

function createLinkedAbortController(parent?: AbortSignal): {
	controller: AbortController;
	dispose: () => void;
} {
	const controller = new AbortController();
	const abort = () => controller.abort();
	if (parent?.aborted) controller.abort();
	else parent?.addEventListener("abort", abort, { once: true });
	return {
		controller,
		dispose: () => parent?.removeEventListener("abort", abort),
	};
}

async function waitForAnyAgentStatus(
	adapter: HerdrAdapter,
	paneId: string,
	statuses: AgentStatus[],
	options: PollOptions,
): Promise<AgentStatus> {
	const linked = createLinkedAbortController(options.signal);
	const waits = statuses.map((status) =>
		adapter.waitAgentStatus(paneId, status, {
			signal: linked.controller.signal,
			timeoutMs: options.timeoutMs,
		}),
	);
	try {
		return await Promise.race(waits);
	} finally {
		linked.controller.abort();
		await Promise.allSettled(waits);
		linked.dispose();
	}
}

async function waitForStartupIdle(
	adapter: HerdrAdapter,
	paneId: string,
	options: PollOptions,
): Promise<AgentStatus> {
	return waitForAnyAgentStatus(adapter, paneId, ["idle", "blocked"], options);
}

async function waitForPaneReady(
	adapter: HerdrAdapter,
	paneId: string,
	options: PollOptions,
): Promise<string> {
	return pollUntil(async () => {
		try {
			const read = await adapter.paneRead(paneId, 40, options.signal);
			if (!read) throw new PaneMissingError();
			return read.read.text.trim().length > 0 ? read.read.text : undefined;
		} catch (error) {
			if (error instanceof PaneMissingError || error instanceof PollAbortedError) throw error;
			// A terminal can exist before its first readable frame. Retry until the
			// startup timeout instead of submitting into an uninitialized TUI.
			return undefined;
		}
	}, options);
}

function detectStartupBlocker(profile: string, screen: string): string | undefined {
	if (profile === "cursor" && /trust this workspace/i.test(screen)) {
		return "Cursor requires workspace trust. Focus the peer pane and approve it, then send the task with herdr_steer_agent.";
	}
	if (profile === "agy" && /not signed in|signing in/i.test(screen)) {
		return "Antigravity requires sign-in. Complete authentication in the peer pane, then send the task with herdr_steer_agent.";
	}
	return undefined;
}

async function confirmPostSubmitStartup(
	adapter: HerdrAdapter,
	paneId: string,
	prompt: string,
	options: PollOptions,
): Promise<{ status: AgentStatus; seenWorking: boolean }> {
	// Arm before pane run so Herdr observes a short working transition that a
	// sampled pane-get loop could miss. The local controller always cancels the
	// waiter when an immediate post-submit state already proves the outcome.
	const linked = createLinkedAbortController(options.signal);
	const transitionWait = waitForAnyAgentStatus(adapter, paneId, ["working", "blocked", "done"], {
		...options,
		signal: linked.controller.signal,
	});

	try {
		// Give the Herdr wait process one event-loop turn to subscribe before the
		// prompt can trigger a very fast agent run.
		await new Promise<void>((resolve) => setImmediate(resolve));
		await adapter.paneRun(paneId, prompt, options.signal);

		const info = await adapter.paneGet(paneId, options.signal);
		if (!info) throw new PaneMissingError();
		let status = info.pane.agent_status;

		if (status === "blocked") return { status, seenWorking: false };
		if (status === "done" || status === "working") return { status, seenWorking: true };

		try {
			status = await transitionWait;
			return {
				status,
				seenWorking: status === "working" || status === "done",
			};
		} catch (error) {
			if (error instanceof PollTimeoutError) {
				const retry = await adapter.paneGet(paneId, options.signal);
				if (!retry) throw new PaneMissingError();
				status = retry.pane.agent_status;
				if (status === "done") return { status, seenWorking: true };
				if (status === "blocked") return { status, seenWorking: false };
			}
			throw error;
		}
	} finally {
		linked.controller.abort();
		await Promise.allSettled([transitionWait]);
		linked.dispose();
	}
}

async function waitForCompletionStatus(
	adapter: HerdrAdapter,
	paneId: string,
	seenWorking: boolean,
	options: PollOptions,
): Promise<AgentStatus> {
	const info = await adapter.paneGet(paneId, options.signal);
	if (!info) throw new PaneMissingError();
	const current = info.pane.agent_status;
	if (current === "blocked") return current;
	if (isCompletionStatus(current, seenWorking)) return current;

	return waitForAnyAgentStatus(adapter, paneId, ["idle", "done", "blocked"], options);
}

async function markLaunchFailure(
	deps: LifecycleDeps,
	agentId: string,
	record: AgentRecord,
	error: unknown,
	signal?: AbortSignal,
): Promise<LaunchResult> {
	let live: Awaited<ReturnType<HerdrAdapter["paneGet"]>>;
	try {
		live = await deps.adapter.paneGet(record.identity.paneId, signal);
	} catch {
		live = undefined;
	}

	let recordStatus: RecordStatus;
	let errorMessage: string;
	if (error instanceof PaneMissingError) {
		recordStatus = "lost";
		errorMessage = error.message;
	} else if (error instanceof PollAbortedError) {
		recordStatus = "aborted";
		errorMessage = "Launch wait aborted";
	} else if (error instanceof PollTimeoutError) {
		recordStatus = "timeout";
		errorMessage = "Timed out waiting for agent state transition";
	} else {
		recordStatus = "error";
		errorMessage = error instanceof Error ? error.message : String(error);
	}
	const liveStatus = live?.pane.agent_status ?? record.agentStatus;
	if (liveStatus === "blocked") recordStatus = "blocked";
	if (!live)
		recordStatus =
			error instanceof PollTimeoutError || error instanceof PollAbortedError
				? recordStatus
				: "lost";

	const updated =
		deps.store.mutate(agentId, (current) => {
			current.agentStatus = liveStatus;
			current.recordStatus = recordStatus;
			current.error = errorMessage;
			if (liveStatus === "working") current.seenWorking = true;
			if (!live && recordStatus === "lost") current.lost = true;
		}) ?? record;
	return buildPartialResult(updated, { error: errorMessage });
}

export async function launchAgent(
	deps: LifecycleDeps,
	ctx: { cwd: string },
	params: LaunchParams,
	signal?: AbortSignal,
	pollOptions: PollOptions = {},
): Promise<LaunchResult> {
	const env = requireHerdrContext();
	if (!env.ok) throw new Error(env.error);

	const roles = deps.resolveRoles();
	const roleName = params.role ?? "general";
	const role = roles[roleName];
	if (!role) {
		throw new Error(`Unknown role "${roleName}". Available: ${Object.keys(roles).join(", ")}`);
	}
	const profiles = deps.resolveProfiles();
	const profileName = params.profile ?? role.profile;
	const profile = getProfile(profiles, profileName);
	if (!profile) {
		throw new Error(
			`Unknown profile "${profileName}" selected by role "${roleName}". Available: ${Object.keys(profiles).join(", ")}`,
		);
	}
	if (!params.prompt || params.prompt.trim().length === 0) throw new Error("prompt is required");
	if (params.prompt.length > 100_000) throw new Error("prompt exceeds 100000 characters");
	if (params.prompt.includes("\0")) throw new Error("prompt must not contain NUL bytes");
	if (params.description && params.description.length > 200) {
		throw new Error("description exceeds 200 characters");
	}
	if (params.workspace && params.tab) throw new Error("Cannot specify both workspace and tab");
	const roleAssignment = buildRoleAssignment(roleName, role, params.prompt);
	if (roleAssignment.length > 120_000) throw new Error("role assignment exceeds 120000 characters");

	const cwd = resolveCwd(params.cwd, ctx.cwd);
	let cwdIsDirectory = false;
	try {
		cwdIsDirectory = statSync(cwd).isDirectory();
	} catch {
		// Report the same curated validation error for missing and inaccessible paths.
	}
	if (!cwdIsDirectory) throw new Error(`cwd is not an existing directory: ${cwd}`);

	const mode = params.mode ?? "background";
	const startupTimeoutMs = boundedNumber(
		params.startupTimeoutMs,
		DEFAULT_STARTUP_TIMEOUT_MS,
		1,
		1_800_000,
	);
	const completionTimeoutMs = boundedNumber(
		params.completionTimeoutMs,
		DEFAULT_COMPLETION_TIMEOUT_MS,
		1,
		1_800_000,
	);
	const pollIntervalMs = boundedNumber(params.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, 0, 60_000);
	const transcriptLines = boundedNumber(params.transcriptLines, DEFAULT_TRANSCRIPT_LINES, 1, 2000);

	const agentId = generateAgentId();
	const herdrName = makeHerdrAgentName(`${roleName}-${profileName}`, agentId);
	const herdrCtx = env.context;
	const startResult = await deps.adapter.agentStart(
		{
			name: herdrName,
			argv: [...profile.argv],
			cwd,
			workspaceId: params.workspace,
			tabId: params.tab ?? (params.workspace ? undefined : herdrCtx.tabId),
			split: params.split ?? "right",
			focus: params.focus ?? false,
		},
		signal,
	);

	// This is intentionally the first persistence point after Herdr returns an
	// opaque pane identity. Every later failure can therefore be recovered.
	const identity = identityFromPane(startResult.agent);
	let record = deps.store.upsert({
		id: agentId,
		role: roleName,
		profile: profileName,
		description: params.description?.trim() || `[${roleName}] ${params.prompt.trim().slice(0, 110)}`,
		prompt: params.prompt,
		cwd,
		herdrName,
		identity,
		agentStatus: startResult.agent.agent_status,
		recordStatus: "launching",
		seenWorking: false,
		mode,
		launchedAt: Date.now(),
		owned: true,
		stopped: false,
		lost: false,
	});

	const pollBase: PollOptions = {
		...pollOptions,
		signal,
		pollIntervalMs,
		timeoutMs: startupTimeoutMs,
	};

	try {
		let status = await waitForStartupIdle(deps.adapter, identity.paneId, pollBase);
		record =
			deps.store.mutate(agentId, (current) => {
				Object.assign(current, updateRecordFromPane(current, status));
				if (status !== "blocked") current.recordStatus = "starting";
			}) ?? record;
		if (status === "blocked") {
			record =
				deps.store.mutate(agentId, (current) => {
					current.recordStatus = "blocked";
					current.error = "Agent is blocked before task submission";
				}) ?? record;
			return buildPartialResult(record, {
				error: "Agent is blocked and needs input before the task can be submitted",
			});
		}

		// Herdr integrations can report idle during session initialization before
		// the TUI accepts input. Require one readable frame as a readiness barrier.
		const startupScreen = await waitForPaneReady(deps.adapter, identity.paneId, pollBase);
		const startupBlocker = detectStartupBlocker(profileName, startupScreen);
		if (startupBlocker) {
			record =
				deps.store.mutate(agentId, (current) => {
					current.recordStatus = "blocked";
					current.error = startupBlocker;
				}) ?? record;
			return buildPartialResult(record, { error: startupBlocker });
		}

		// pane run receives the entire prompt as one argv element; no shell
		// interpolation or command-string construction occurs here.
		const startup = await confirmPostSubmitStartup(
			deps.adapter,
			identity.paneId,
			roleAssignment,
			pollBase,
		);
		status = startup.status;
		record =
			deps.store.mutate(agentId, (current) => {
				Object.assign(current, updateRecordFromPane(current, status, { promptSubmitted: true }));
				if (startup.seenWorking) current.seenWorking = true;
			}) ?? record;
		if (status === "blocked") {
			record =
				deps.store.mutate(agentId, (current) => {
					current.recordStatus = "blocked";
					current.error = "Agent became blocked after task submission";
				}) ?? record;
			return buildPartialResult(record, { error: record.error });
		}

		if (mode === "background") {
			return {
				agentId,
				role: roleName,
				profile: profileName,
				status: record.recordStatus,
				agentStatus: record.agentStatus,
				seenWorking: record.seenWorking,
				partial: false,
			};
		}

		if (isCompletionStatus(status, record.seenWorking)) {
			const transcript = await readTranscript(
				deps.adapter,
				identity.paneId,
				transcriptLines,
				signal,
			);
			record =
				deps.store.mutate(agentId, (current) => {
					current.agentStatus = status;
					current.recordStatus = status;
					current.completedAt = Date.now();
				}) ?? record;
			return {
				agentId,
				role: roleName,
				profile: profileName,
				status: record.recordStatus,
				agentStatus: record.agentStatus,
				seenWorking: record.seenWorking,
				transcript: transcript?.text,
				truncated: transcript?.truncated,
				partial: false,
			};
		}

		status = await waitForCompletionStatus(deps.adapter, identity.paneId, record.seenWorking, {
			...pollBase,
			timeoutMs: completionTimeoutMs,
		});
		if (!isCompletionStatus(status, record.seenWorking)) {
			throw new Error("Completion rejected: agent never reached working state");
		}
		const transcript = await readTranscript(deps.adapter, identity.paneId, transcriptLines, signal);
		record =
			deps.store.mutate(agentId, (current) => {
				current.agentStatus = status;
				current.recordStatus = status;
				current.completedAt = Date.now();
			}) ?? record;
		return {
			agentId,
			role: roleName,
			profile: profileName,
			status: record.recordStatus,
			agentStatus: record.agentStatus,
			seenWorking: record.seenWorking,
			transcript: transcript?.text,
			truncated: transcript?.truncated,
			partial: false,
		};
	} catch (error) {
		return markLaunchFailure(deps, agentId, record, error, signal);
	}
}

async function refreshRecord(
	deps: LifecycleDeps,
	agentId: string,
	signal?: AbortSignal,
): Promise<AgentRecord> {
	const latest = deps.store.get(agentId);
	if (!latest) throw new Error(`Unknown agent id "${agentId}"`);
	const validated = await validateLiveRecord(deps.adapter, latest, signal);
	if (validated.lost) return deps.store.upsert(validated);
	return (
		deps.store.mutate(agentId, (record) => {
			Object.assign(record, updateRecordFromPane(record, validated.agentStatus));
		}) ?? validated
	);
}

export async function getAgentResult(
	deps: LifecycleDeps,
	params: AgentResultParams,
	signal?: AbortSignal,
	pollOptions: PollOptions = {},
): Promise<AgentResult> {
	const mode = params.mode ?? "poll";
	const timeoutMs = boundedNumber(params.timeoutMs, DEFAULT_RESULT_TIMEOUT_MS, 0, 1_800_000);
	const pollIntervalMs = boundedNumber(params.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, 0, 60_000);
	const transcriptLines = boundedNumber(params.transcriptLines, DEFAULT_TRANSCRIPT_LINES, 1, 2000);
	if (!deps.store.get(params.agentId)) throw new Error(`Unknown agent id "${params.agentId}"`);

	const buildResult = async (
		record: AgentRecord,
		error?: string,
		includeTranscript = true,
	): Promise<AgentResult> => {
		const complete = isCompletionStatus(record.agentStatus, record.seenWorking);
		const read =
			includeTranscript && !record.lost && !record.stopped
				? await readTranscript(deps.adapter, record.identity.paneId, transcriptLines, signal)
				: undefined;
		return {
			agentId: record.id,
			role: record.role ?? "general",
			profile: record.profile,
			status: record.recordStatus,
			agentStatus: record.agentStatus,
			seenWorking: record.seenWorking,
			transcript: read?.text,
			truncated: read?.truncated,
			error: error ?? record.error,
			complete,
		};
	};

	if (mode === "poll") return buildResult(await refreshRecord(deps, params.agentId, signal));
	try {
		await pollUntil(
			async () => {
				const record = await refreshRecord(deps, params.agentId, signal);
				if (
					record.agentStatus === "blocked" ||
					isCompletionStatus(record.agentStatus, record.seenWorking)
				) {
					return record;
				}
				return undefined;
			},
			{ ...pollOptions, signal, pollIntervalMs, timeoutMs },
		);
		return buildResult(await refreshRecord(deps, params.agentId, signal));
	} catch (error) {
		const stored = deps.store.get(params.agentId);
		if (!stored) throw new Error(`Unknown agent id "${params.agentId}"`);
		if (error instanceof PollAbortedError) {
			// Do not issue another Herdr command with an already-aborted signal.
			return buildResult(stored, "Result wait aborted", false);
		}

		let record = stored;
		try {
			record = await refreshRecord(deps, params.agentId, signal);
		} catch {
			// Preserve the last known record when Herdr is temporarily unavailable.
		}
		if (error instanceof PollTimeoutError) {
			return buildResult(record, "Timed out waiting for agent completion");
		}
		return buildResult(record, error instanceof Error ? error.message : String(error));
	}
}

export async function steerAgent(
	deps: LifecycleDeps,
	params: { agentId: string; message: string },
	signal?: AbortSignal,
): Promise<AgentRecord> {
	if (!params.message || !params.message.trim()) throw new Error("message is required");
	const record = deps.store.get(params.agentId);
	if (!record) throw new Error(`Unknown agent id "${params.agentId}"`);
	if (record.stopped) throw new Error(`Agent "${params.agentId}" is stopped`);
	if (record.lost) throw new Error(`Agent "${params.agentId}" is lost`);
	const validated = await validateLiveRecord(deps.adapter, record, signal);
	if (validated.lost) {
		deps.store.upsert(validated);
		throw new Error(`Agent "${params.agentId}" pane is no longer available`);
	}
	await deps.adapter.paneRun(validated.identity.paneId, params.message, signal);
	return (
		deps.store.mutate(params.agentId, (current) => {
			Object.assign(current, updateRecordFromPane(current, validated.agentStatus));
		}) ?? validated
	);
}

export async function stopAgent(
	deps: LifecycleDeps,
	params: { agentId: string },
	signal?: AbortSignal,
): Promise<AgentRecord> {
	const record = deps.store.get(params.agentId);
	if (!record) throw new Error(`Unknown agent id "${params.agentId}"`);
	if (!record.owned) throw new Error(`Agent "${params.agentId}" is not an owned Herdr pane`);
	if (record.stopped) return record;
	const validated = await validateLiveRecord(deps.adapter, record, signal);
	if (validated.lost) {
		return deps.store.upsert({ ...validated, lost: true, recordStatus: "lost" });
	}
	// validateLiveRecord compares pane, terminal, workspace, and tab before this
	// irreversible operation. Never close based on a stale or partial identity.
	await deps.adapter.paneClose(validated.identity.paneId, signal);
	return (
		deps.store.mutate(params.agentId, (current) => {
			current.stopped = true;
			current.recordStatus = "stopped";
			current.completedAt = Date.now();
		}) ?? validated
	);
}

export function isValidCompletion(agentStatus: AgentStatus, seenWorking: boolean): boolean {
	return isCompletionStatus(agentStatus, seenWorking);
}

export type { HerdrContext };
