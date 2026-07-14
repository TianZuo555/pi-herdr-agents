import type { PollOptions } from "./types.js";

export class PollAbortedError extends Error {
	constructor(message = "Polling aborted") {
		super(message);
		this.name = "PollAbortedError";
	}
}

export class PollTimeoutError extends Error {
	constructor(message = "Polling timed out") {
		super(message);
		this.name = "PollTimeoutError";
	}
}

export async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0) return;
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);
		const onAbort = () => {
			cleanup();
			reject(new PollAbortedError());
		};
		const cleanup = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};
		if (signal?.aborted) {
			cleanup();
			reject(new PollAbortedError());
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export async function pollUntil<T>(
	predicate: () => Promise<T | undefined>,
	options: PollOptions = {},
): Promise<T> {
	const sleep = options.sleep ?? defaultSleep;
	const now = options.now ?? (() => Date.now());
	const pollIntervalMs = options.pollIntervalMs ?? 500;
	const timeoutMs = options.timeoutMs ?? 120_000;
	const deadline = now() + timeoutMs;

	while (true) {
		if (options.signal?.aborted) {
			throw new PollAbortedError();
		}

		const value = await predicate();
		if (value !== undefined) return value;

		if (now() >= deadline) {
			throw new PollTimeoutError();
		}

		await sleep(pollIntervalMs, options.signal);
		// Even an injected zero-delay sleeper must yield to timers and external
		// Herdr events; otherwise a tight microtask loop can starve the caller.
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}
