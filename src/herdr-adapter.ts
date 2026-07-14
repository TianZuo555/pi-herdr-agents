import { PollAbortedError, PollTimeoutError } from "./poll.js";
import type {
	AgentStartOptions,
	AgentStartedResult,
	AgentStatus,
	AgentStatusWaitOptions,
	ExecFn,
	HerdrEnvelope,
	PaneInfoResult,
	PaneReadResult,
} from "./types.js";
import { formatHerdrError } from "./types.js";

export type { HerdrAdapter } from "./types.js";

/**
 * Herdr has shipped both the Pi-style {ok,result} envelope and the native
 * {id,result}/{id,error} API envelope. Normalize both at this boundary.
 */
export function parseHerdrEnvelope<T>(stdout: string): HerdrEnvelope<T> {
	const trimmed = stdout.trim();
	if (!trimmed) return { ok: false, error: "Empty Herdr response" };

	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		// Preserve compatibility with wrappers that print diagnostics or multiple
		// JSON records. Prefer the last complete JSON line.
		for (const line of trimmed.split("\n").reverse()) {
			try {
				parsed = JSON.parse(line.trim());
				break;
			} catch {
				// Continue to the next candidate line.
			}
		}
		if (parsed === undefined) {
			const start = trimmed.indexOf("{");
			const end = trimmed.lastIndexOf("}");
			if (start < 0 || end <= start) {
				return { ok: false, error: `Invalid JSON from Herdr: ${trimmed.slice(0, 200)}` };
			}
			try {
				parsed = JSON.parse(trimmed.slice(start, end + 1));
			} catch {
				return { ok: false, error: `Invalid JSON from Herdr: ${trimmed.slice(0, 200)}` };
			}
		}
	}

	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { ok: false, error: "Herdr response must be a JSON object" };
	}
	const object = parsed as Record<string, unknown>;
	if (typeof object.ok === "boolean") return object as unknown as HerdrEnvelope<T>;
	if ("error" in object) {
		return { ok: false, error: object.error as HerdrEnvelope<T>["error"] };
	}
	if ("result" in object) return { ok: true, result: object.result as T };

	// A direct typed result is useful for simple mocks and older wrappers.
	return { ok: true, result: parsed as T };
}

function assertEnvelope<T>(envelope: HerdrEnvelope<T>, context: string): T {
	if (!envelope.ok || envelope.result === undefined) {
		throw new Error(`${context}: ${formatHerdrError(envelope.error)}`);
	}
	return envelope.result;
}

function validatePane(pane: unknown, context: string): void {
	if (pane === null || typeof pane !== "object") {
		throw new Error(`${context}: missing pane object`);
	}
	const p = pane as Record<string, unknown>;
	for (const key of ["pane_id", "terminal_id", "workspace_id", "tab_id", "agent_status"]) {
		if (typeof p[key] !== "string" || p[key].length === 0) {
			throw new Error(`${context}: pane.${key} must be a non-empty string`);
		}
	}
	const status = p.agent_status as AgentStatus;
	if (!["idle", "working", "blocked", "done", "unknown"].includes(status)) {
		throw new Error(`${context}: invalid agent_status "${String(p.agent_status)}"`);
	}
}

export function validateAgentStarted(result: unknown): AgentStartedResult {
	if (result === null || typeof result !== "object") {
		throw new Error("agent start: invalid result object");
	}
	let object = result as Record<string, unknown>;
	if (
		object.type !== "agent_started" &&
		object.agent_started &&
		typeof object.agent_started === "object"
	) {
		object = object.agent_started as Record<string, unknown>;
	}
	if (object.type !== "agent_started") {
		throw new Error(`agent start: expected type agent_started, got ${String(object.type)}`);
	}
	validatePane(object.agent, "agent start");
	if (!Array.isArray(object.argv) || object.argv.some((value) => typeof value !== "string")) {
		throw new Error("agent start: argv must be a string array");
	}
	return object as unknown as AgentStartedResult;
}

export function validatePaneInfo(result: unknown): PaneInfoResult {
	if (result === null || typeof result !== "object") {
		throw new Error("pane get: invalid result object");
	}
	const object = result as Record<string, unknown>;
	if (object.type !== "pane_info" && object.type !== "pane_current") {
		throw new Error(`pane get: expected type pane_info, got ${String(object.type)}`);
	}
	validatePane(object.pane, "pane get");
	return { ...object, type: "pane_info" } as unknown as PaneInfoResult;
}

export function validatePaneRead(result: unknown): PaneReadResult {
	if (result === null || typeof result !== "object") {
		throw new Error("pane read: invalid result object");
	}
	const object = result as Record<string, unknown>;
	if (object.type !== "pane_read" && object.type !== "output_matched") {
		throw new Error(`pane read: expected type pane_read, got ${String(object.type)}`);
	}
	if (object.read === null || typeof object.read !== "object") {
		throw new Error("pane read: missing read object");
	}
	const read = object.read as Record<string, unknown>;
	if (typeof read.text !== "string") throw new Error("pane read: read.text must be a string");
	if (typeof read.truncated !== "boolean") {
		throw new Error("pane read: read.truncated must be a boolean");
	}
	return { ...object, type: "pane_read" } as unknown as PaneReadResult;
}

function validateCliValue(value: string | undefined, label: string): void {
	if (value === undefined) return;
	if (!value || value.length > 4096 || value.includes("\0")) {
		throw new Error(
			`${label} must be a non-empty string of at most 4096 characters without NUL bytes`,
		);
	}
}

const VALID_AGENT_STATUSES = new Set<AgentStatus>([
	"idle",
	"working",
	"blocked",
	"done",
	"unknown",
]);

export function parseAgentStatusWait(stdout: string, stderr = ""): AgentStatus {
	const combined = `${stdout}\n${stderr}`.trim();
	if (combined.includes("timed out waiting for agent status")) {
		throw new PollTimeoutError("Timed out waiting for agent status change");
	}

	const trimmed = stdout.trim();
	if (!trimmed) {
		throw new Error(
			`wait agent-status: empty response${stderr ? `: ${stderr.trim().slice(0, 200)}` : ""}`,
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		throw new Error(`wait agent-status: invalid JSON: ${trimmed.slice(0, 200)}`);
	}

	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("wait agent-status: response must be a JSON object");
	}

	const object = parsed as Record<string, unknown>;
	const data = object.data;
	if (data && typeof data === "object" && !Array.isArray(data)) {
		const status = (data as Record<string, unknown>).agent_status;
		if (typeof status === "string" && VALID_AGENT_STATUSES.has(status as AgentStatus)) {
			return status as AgentStatus;
		}
	}

	const envelope = parseHerdrEnvelope<{ agent_status?: AgentStatus }>(trimmed);
	if (envelope.ok && envelope.result?.agent_status) {
		const status = envelope.result.agent_status;
		if (VALID_AGENT_STATUSES.has(status)) return status;
	}

	throw new Error("wait agent-status: response missing agent_status");
}

export function buildAgentStartArgv(options: AgentStartOptions): string[] {
	if (!options.name || options.name.includes("\0")) {
		throw new Error("agent start name must be a non-empty string without NUL bytes");
	}
	if (!options.cwd || options.cwd.includes("\0")) {
		throw new Error("agent start cwd must be a non-empty string without NUL bytes");
	}
	if (options.argv.length === 0 || options.argv.some((value) => !value || value.includes("\0"))) {
		throw new Error("agent start argv must contain non-empty strings without NUL bytes");
	}
	if (options.workspaceId && options.tabId) {
		throw new Error("Cannot specify both workspace and tab for agent start");
	}
	validateCliValue(options.workspaceId, "workspace id");
	validateCliValue(options.tabId, "tab id");
	if (options.argv.length > 64 || options.argv.some((value) => value.length > 4096)) {
		throw new Error("agent start argv exceeds the supported size limit");
	}

	const argv: string[] = ["agent", "start", options.name, "--cwd", options.cwd];
	if (options.workspaceId) argv.push("--workspace", options.workspaceId);
	if (options.tabId) argv.push("--tab", options.tabId);
	if (options.split) argv.push("--split", options.split);
	if (options.focus === true) argv.push("--focus");
	if (options.focus === false) argv.push("--no-focus");
	argv.push("--", ...options.argv);
	return argv;
}

export function createHerdrAdapter(exec: ExecFn): import("./types.js").HerdrAdapter {
	async function runHerdr(
		argv: string[],
		signal?: AbortSignal,
		context = "herdr",
	): Promise<string> {
		let result: Awaited<ReturnType<ExecFn>>;
		try {
			result = await exec("herdr", argv, { signal, timeout: 30_000 });
		} catch (error) {
			if (signal?.aborted) throw new PollAbortedError();
			throw error;
		}
		if (signal?.aborted || result.killed) throw new PollAbortedError();
		if (result.code !== 0) {
			const envelope = parseHerdrEnvelope<unknown>(result.stdout || result.stderr);
			if (!envelope.ok) throw new Error(`${context}: ${formatHerdrError(envelope.error)}`);
			throw new Error(
				`${context}: herdr exited with code ${result.code}: ${result.stderr || result.stdout}`,
			);
		}
		return result.stdout;
	}

	return {
		async agentStart(options, signal) {
			const stdout = await runHerdr(buildAgentStartArgv(options), signal, "agent start");
			return validateAgentStarted(
				assertEnvelope(parseHerdrEnvelope<unknown>(stdout), "agent start"),
			);
		},

		async paneGet(paneId, signal) {
			try {
				const stdout = await runHerdr(["pane", "get", paneId], signal, "pane get");
				return validatePaneInfo(assertEnvelope(parseHerdrEnvelope<unknown>(stdout), "pane get"));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (message.includes("not found") || message.includes("unknown pane")) return undefined;
				throw error;
			}
		},

		async paneRead(paneId, lines, signal) {
			try {
				const stdout = await runHerdr(
					["pane", "read", paneId, "--source", "recent-unwrapped", "--lines", String(lines)],
					signal,
					"pane read",
				);

				// Unlike most Herdr control commands, the pane-read CLI intentionally
				// renders raw terminal text. Still accept a JSON API envelope for
				// compatibility with wrappers and tests.
				try {
					return validatePaneRead(assertEnvelope(parseHerdrEnvelope<unknown>(stdout), "pane read"));
				} catch {
					const lineCount = stdout.length === 0 ? 0 : stdout.split("\n").length;
					return {
						type: "pane_read",
						read: { text: stdout, truncated: lineCount >= lines },
					};
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (message.includes("not found") || message.includes("unknown pane")) return undefined;
				throw error;
			}
		},

		async paneRun(paneId, text, signal) {
			await runHerdr(["pane", "run", paneId, text], signal, "pane run");
		},

		async waitAgentStatus(paneId, status, options?: AgentStatusWaitOptions) {
			const timeoutMs = options?.timeoutMs ?? 120_000;
			let result: Awaited<ReturnType<ExecFn>>;
			try {
				result = await exec(
					"herdr",
					["wait", "agent-status", paneId, "--status", status, "--timeout", String(timeoutMs)],
					{ signal: options?.signal, timeout: timeoutMs + 30_000 },
				);
			} catch (error) {
				if (options?.signal?.aborted) throw new PollAbortedError();
				throw error;
			}
			if (options?.signal?.aborted || result.killed) {
				throw new PollAbortedError();
			}
			if (result.code === 0) {
				return parseAgentStatusWait(result.stdout, result.stderr);
			}
			const message = `${result.stdout}\n${result.stderr}`.trim();
			if (message.includes("timed out waiting for agent status")) {
				throw new PollTimeoutError("Timed out waiting for agent status change");
			}
			throw new Error(`wait agent-status ${status}: ${message.slice(0, 400)}`);
		},

		async paneClose(paneId, signal) {
			await runHerdr(["pane", "close", paneId], signal, "pane close");
		},
	};
}
