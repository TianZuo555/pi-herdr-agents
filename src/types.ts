/** Live agent status reported by Herdr pane records. */
export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

/** Extension-side lifecycle status for a tracked Herdr peer agent. */
export type RecordStatus =
	| "launching"
	| "starting"
	| "working"
	| "blocked"
	| "idle"
	| "done"
	| "unknown"
	| "unavailable"
	| "stopped"
	| "lost"
	| "error"
	| "timeout"
	| "aborted";

export type LaunchMode = "foreground" | "background";
export type WriteAccess = "none" | "workspace";
export type SubmissionState = "pending" | "submitted" | "acknowledged";

export interface AgentIdentity {
	paneId: string;
	terminalId: string;
	workspaceId: string;
	tabId: string;
}

export interface AgentRecord {
	/** Extension-generated opaque agent id returned to the LLM. */
	id: string;
	/** Optional only for compatibility with snapshots created before roles existed. */
	role?: string;
	profile: string;
	description: string;
	/** Legacy snapshot field. New snapshots never persist task prompt text. */
	prompt?: string;
	cwd: string;
	/** Whether this role holds an exclusive write lease for cwd while active. */
	writeAccess?: WriteAccess;
	/** Initial assignment delivery state. Optional for older snapshots. */
	submissionState?: SubmissionState;
	/** Non-secret marker used to confirm that the peer TUI accepted the assignment. */
	taskMarker?: string;
	/** Display name passed to `herdr agent start`. */
	herdrName: string;
	identity: AgentIdentity;
	/** Last observed Herdr agent_status. */
	agentStatus: AgentStatus;
	recordStatus: RecordStatus;
	seenWorking: boolean;
	mode: LaunchMode;
	launchedAt: number;
	startedWorkingAt?: number;
	completedAt?: number;
	error?: string;
	/** True only for panes created by this extension. */
	owned: boolean;
	stopped: boolean;
	lost: boolean;
	/** Column-fill auto-layout slot (1-based), when auto-layout placed this pane. */
	layoutSlot?: number;
	/** Herdr tab id the layoutSlot numbering is scoped to. Present iff layoutSlot is present. */
	layoutTabId?: string;
}

export interface AgentProfile {
	argv: string[];
	description: string;
}

export interface AgentRole {
	/** Profile selected when herdr_launch_agent does not provide an override. */
	profile: string;
	description: string;
	/** Trusted instruction prepended to the assignment sent to the peer. */
	prompt: string;
	/** Workspace writers are serialized per canonical cwd. */
	writeAccess: WriteAccess;
}

export interface ProfilesConfig {
	profiles: Record<string, AgentProfile>;
	roles: Record<string, AgentRole>;
}

export interface HerdrContext {
	workspaceId: string;
	tabId: string;
	paneId: string;
}

export interface LaunchParams {
	role?: string;
	profile?: string;
	prompt: string;
	description?: string;
	mode?: LaunchMode;
	cwd?: string;
	workspace?: string;
	tab?: string;
	split?: "right" | "down";
	focus?: boolean;
	startupTimeoutMs?: number;
	completionTimeoutMs?: number;
	pollIntervalMs?: number;
	transcriptLines?: number;
}

export interface LaunchResult {
	agentId: string;
	role: string;
	profile: string;
	status: RecordStatus;
	agentStatus: AgentStatus;
	seenWorking: boolean;
	transcript?: string;
	truncated?: boolean;
	error?: string;
	partial?: boolean;
}

export interface AgentResultParams {
	agentId: string;
	mode?: "poll" | "wait";
	timeoutMs?: number;
	transcriptLines?: number;
	pollIntervalMs?: number;
}

export interface AgentResult {
	agentId: string;
	role: string;
	profile: string;
	status: RecordStatus;
	agentStatus: AgentStatus;
	seenWorking: boolean;
	transcript?: string;
	truncated?: boolean;
	error?: string;
	complete: boolean;
}

export interface SteerParams {
	agentId: string;
	message: string;
	forceResubmit?: boolean;
}

export interface StopParams {
	agentId: string;
}

export interface SnapshotV1 {
	version: 1;
	records: AgentRecord[];
}

export const SNAPSHOT_CUSTOM_TYPE = "herdr-agents:snapshot";
export const SNAPSHOT_VERSION = 1 as const;

export const DEFAULT_STARTUP_TIMEOUT_MS = 120_000;
export const DEFAULT_COMPLETION_TIMEOUT_MS = 600_000;
export const DEFAULT_POLL_INTERVAL_MS = 500;
export const DEFAULT_TRANSCRIPT_LINES = 120;
export const DEFAULT_RESULT_TIMEOUT_MS = 120_000;

export interface PollOptions {
	signal?: AbortSignal;
	pollIntervalMs?: number;
	timeoutMs?: number;
	now?: () => number;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface HerdrPane {
	pane_id: string;
	terminal_id: string;
	workspace_id: string;
	tab_id: string;
	agent_status: AgentStatus;
	/** Present on agent get/list records. */
	name?: string;
	cwd?: string;
}

export interface HerdrEnvelope<T> {
	ok: boolean;
	result?: T;
	error?: string | { code?: string; message?: string };
}

export interface AgentStartedResult {
	type: "agent_started";
	agent: HerdrPane;
	argv: string[];
}

export interface AgentInfoResult {
	type: "agent_info";
	agent: HerdrPane;
}

export interface PaneInfoResult {
	type: "pane_info";
	pane: HerdrPane;
}

export interface PaneReadResult {
	type: "pane_read";
	read: {
		text: string;
		truncated: boolean;
	};
}

export interface AgentStartOptions {
	name: string;
	argv: string[];
	cwd: string;
	workspaceId?: string;
	tabId?: string;
	split?: "right" | "down";
	focus?: boolean;
	/** Exec timeout for the `herdr agent start` process spawn. Defaults to 30s. */
	timeoutMs?: number;
}

export type ExecFn = (
	command: string,
	args: string[],
	options?: { signal?: AbortSignal; timeout?: number },
) => Promise<{ stdout: string; stderr: string; code: number | null; killed: boolean }>;

export interface AgentStatusWaitOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
}

export interface PaneMoveOptions {
	tabId: string;
	targetPaneId: string;
	split: "right" | "down";
	focus?: boolean;
	ratio?: number;
}

export interface HerdrAdapter {
	agentStart(options: AgentStartOptions, signal?: AbortSignal): Promise<AgentStartedResult>;
	agentGet(target: string, signal?: AbortSignal): Promise<AgentInfoResult | undefined>;
	paneGet(paneId: string, signal?: AbortSignal): Promise<PaneInfoResult | undefined>;
	paneRead(
		paneId: string,
		lines: number,
		signal?: AbortSignal,
	): Promise<PaneReadResult | undefined>;
	paneRun(paneId: string, text: string, signal?: AbortSignal): Promise<void>;
	waitAgentStatus(
		paneId: string,
		status: AgentStatus,
		options?: AgentStatusWaitOptions,
	): Promise<AgentStatus>;
	paneMove(paneId: string, options: PaneMoveOptions, signal?: AbortSignal): Promise<void>;
	paneClose(paneId: string, signal?: AbortSignal): Promise<void>;
}

export function isCompletionStatus(status: AgentStatus, seenWorking: boolean): boolean {
	return seenWorking && (status === "idle" || status === "done");
}

export function identitiesMatch(stored: AgentIdentity, live: HerdrPane): boolean {
	return (
		stored.paneId === live.pane_id &&
		stored.terminalId === live.terminal_id &&
		stored.workspaceId === live.workspace_id &&
		stored.tabId === live.tab_id
	);
}

export function formatHerdrError(error: HerdrEnvelope<unknown>["error"]): string {
	if (!error) return "Unknown Herdr error";
	if (typeof error === "string") return error;
	if (error.code && error.message) return `${error.code}: ${error.message}`;
	return error.message ?? error.code ?? "Unknown Herdr error";
}
