import { PollAbortedError, PollTimeoutError } from "../src/poll.js";
import type {
	AgentStartOptions,
	AgentStartedResult,
	AgentStatus,
	AgentStatusWaitOptions,
	HerdrAdapter,
	PaneInfoResult,
	PaneReadResult,
} from "../src/types.js";

export interface FakePaneState {
	paneId: string;
	terminalId: string;
	workspaceId: string;
	tabId: string;
	agentStatus: AgentStatus;
	transcript: string;
	closed?: boolean;
	onRun?: (text: string) => void;
}

interface StatusWaiter {
	target: AgentStatus;
	resolve: (status: AgentStatus) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
	onAbort: () => void;
}

export class FakeHerdrAdapter implements HerdrAdapter {
	public calls: Array<{ method: string; args: unknown[] }> = [];
	private panes = new Map<string, FakePaneState>();
	private statusWaiters = new Map<string, StatusWaiter[]>();
	private counter = 0;

	addPane(state: FakePaneState): void {
		this.panes.set(state.paneId, state);
	}

	setStatus(paneId: string, status: AgentStatus): void {
		const pane = this.panes.get(paneId);
		if (!pane) return;
		pane.agentStatus = status;
		this.resolveStatusWaiters(paneId, status);
	}

	setTranscript(paneId: string, transcript: string): void {
		const pane = this.panes.get(paneId);
		if (pane) pane.transcript = transcript;
	}

	getPane(paneId: string): FakePaneState | undefined {
		return this.panes.get(paneId);
	}

	private resolveStatusWaiters(paneId: string, status: AgentStatus): void {
		const waiters = this.statusWaiters.get(paneId);
		if (!waiters?.length) return;

		const remaining: StatusWaiter[] = [];
		for (const waiter of waiters) {
			if (status === waiter.target || status === "blocked") {
				waiter.resolve(status === "blocked" ? "blocked" : waiter.target);
				clearTimeout(waiter.timer);
				waiter.onAbort();
			} else {
				remaining.push(waiter);
			}
		}

		if (remaining.length > 0) this.statusWaiters.set(paneId, remaining);
		else this.statusWaiters.delete(paneId);
	}

	async agentStart(options: AgentStartOptions): Promise<AgentStartedResult> {
		this.calls.push({ method: "agentStart", args: [options] });
		this.counter += 1;
		const paneId = `w1:p${this.counter}`;
		const pane: FakePaneState = {
			paneId,
			terminalId: `term_${this.counter}`,
			workspaceId: options.workspaceId ?? "w1",
			tabId: options.tabId ?? "w1:t1",
			agentStatus: "unknown",
			transcript: "agent ready",
		};
		this.panes.set(paneId, pane);
		return {
			type: "agent_started",
			agent: {
				pane_id: pane.paneId,
				terminal_id: pane.terminalId,
				workspace_id: pane.workspaceId,
				tab_id: pane.tabId,
				agent_status: pane.agentStatus,
			},
			argv: options.argv,
		};
	}

	async paneGet(paneId: string): Promise<PaneInfoResult | undefined> {
		this.calls.push({ method: "paneGet", args: [paneId] });
		const pane = this.panes.get(paneId);
		if (!pane || pane.closed) return undefined;
		return {
			type: "pane_info",
			pane: {
				pane_id: pane.paneId,
				terminal_id: pane.terminalId,
				workspace_id: pane.workspaceId,
				tab_id: pane.tabId,
				agent_status: pane.agentStatus,
			},
		};
	}

	async paneRead(paneId: string, lines: number): Promise<PaneReadResult | undefined> {
		this.calls.push({ method: "paneRead", args: [paneId, lines] });
		const pane = this.panes.get(paneId);
		if (!pane || pane.closed) return undefined;
		const text = pane.transcript.split("\n").slice(-lines).join("\n");
		return {
			type: "pane_read",
			read: { text, truncated: pane.transcript.length > text.length },
		};
	}

	async paneRun(paneId: string, text: string): Promise<void> {
		this.calls.push({ method: "paneRun", args: [paneId, text] });
		const pane = this.panes.get(paneId);
		if (!pane || pane.closed) throw new Error(`pane not found: ${paneId}`);
		if (pane.onRun) {
			pane.onRun(text);
			return;
		}
		if (pane.agentStatus === "idle") {
			pane.agentStatus = "working";
			this.resolveStatusWaiters(paneId, "working");
		}
	}

	async waitAgentStatus(
		paneId: string,
		status: AgentStatus,
		options?: AgentStatusWaitOptions,
	): Promise<AgentStatus> {
		this.calls.push({ method: "waitAgentStatus", args: [paneId, status, options] });
		const pane = this.panes.get(paneId);
		if (!pane || pane.closed) throw new Error(`pane not found: ${paneId}`);
		if (pane.agentStatus === status) return status;
		if (pane.agentStatus === "blocked") return "blocked";

		return new Promise<AgentStatus>((resolve, reject) => {
			const timeoutMs = options?.timeoutMs ?? 120_000;
			const timer = setTimeout(() => {
				cleanup();
				reject(new PollTimeoutError("Timed out waiting for agent status change"));
			}, timeoutMs);
			const onAbort = () => {
				cleanup();
				reject(new PollAbortedError());
			};
			const cleanup = () => {
				clearTimeout(timer);
				options?.signal?.removeEventListener("abort", onAbort);
				const waiters = this.statusWaiters.get(paneId);
				if (!waiters) return;
				const next = waiters.filter((waiter) => waiter.resolve !== resolve);
				if (next.length > 0) this.statusWaiters.set(paneId, next);
				else this.statusWaiters.delete(paneId);
			};

			if (options?.signal?.aborted) {
				cleanup();
				reject(new PollAbortedError());
				return;
			}
			options?.signal?.addEventListener("abort", onAbort, { once: true });

			const waiters = this.statusWaiters.get(paneId) ?? [];
			waiters.push({ target: status, resolve, reject, timer, onAbort });
			this.statusWaiters.set(paneId, waiters);
		});
	}

	async paneClose(paneId: string): Promise<void> {
		this.calls.push({ method: "paneClose", args: [paneId] });
		const pane = this.panes.get(paneId);
		if (!pane) throw new Error(`pane not found: ${paneId}`);
		pane.closed = true;
	}
}
