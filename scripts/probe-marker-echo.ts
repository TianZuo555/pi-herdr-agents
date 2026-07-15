/**
 * Marker-echo probe — validates the assumption behind `waitForSubmissionEcho`
 * in `src/lifecycle.ts`: that each real coding-agent CLI echoes a submitted
 * prompt (including the `[herdr-task-marker:...]` line) verbatim into its Herdr
 * pane `recent-unwrapped` output within the startup timeout.
 *
 * If a CLI does NOT echo the marker, `launchAgent` waits until
 * `startupTimeoutMs` and reports a timeout even though the task was accepted —
 * a false negative. This probe is the only way to catch that, because it
 * depends on real TUI rendering that the `FakeHerdrAdapter` cannot reproduce.
 *
 * Run INSIDE a Herdr pane (HERDR_ENV=1) with the target CLIs on PATH:
 *   node scripts/probe-marker-echo.ts                     # all built-in profiles
 *   node scripts/probe-marker-echo.ts --profile cursor --profile codex
 *   node scripts/probe-marker-echo.ts --case long --keep  # keep panes open
 *
 * Self-contained by design: it shells the real `herdr` binary and imports
 * nothing from `src/`, so it runs under plain `node` type-stripping. The marker
 * format is asserted to match `src/roles.ts` by
 * `test/marker-echo-contract.test.ts`; keep the two in sync.
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";

/** Mirror of the marker fence emitted by `buildRoleAssignment` in src/roles.ts. */
export const MARKER_PREFIX = "herdr-task-marker";

/** Mirror of the marker line format; see test/marker-echo-contract.test.ts. */
export function formatMarker(marker: string): string {
	return `[${MARKER_PREFIX}:${marker}]`;
}

/**
 * Built-in profile → argv, mirroring src/profiles.ts BUILTIN_PROFILES. Kept
 * inline so the harness stays importless; eyeball against that file if profiles
 * change (a stale binary just surfaces as an "error" outcome, not a wrong pass).
 */
const PROFILE_ARGV: Record<string, string[]> = {
	pi: ["pi"],
	cursor: ["cursor-agent"],
	agy: ["agy"],
	codex: ["codex"],
	claude: ["claude"],
	opencode: ["opencode"],
};

interface ProbeCase {
	name: string;
	build: (marker: string) => string;
}

/**
 * Three shapes stress different echo failure modes:
 * - bare: the minimum — does the CLI echo submitted input at all?
 * - wrapped: the exact tag lines production sends before the marker.
 * - long: a very long single logical line, to expose input reflow / scrollback
 *   truncation that could split or drop the trailing marker.
 */
const CASES: ProbeCase[] = [
	{
		name: "bare",
		build: (m) => `Echo probe — please disregard, this is a readiness check.\n${formatMarker(m)}`,
	},
	{
		name: "wrapped",
		build: (m) =>
			[
				'<herdr-peer-role name="scout">',
				"Echo probe. Do not perform any work; this only verifies terminal echo.",
				"</herdr-peer-role>",
				"",
				"<assignment>",
				"No action required.",
				"</assignment>",
				formatMarker(m),
			].join("\n"),
	},
	{
		name: "long",
		build: (m) =>
			`${"Echo probe filler to exercise input wrapping and scrollback truncation. ".repeat(30)}\n${formatMarker(m)}`,
	},
];

type Outcome = "pass" | "fail-no-echo" | "blocked" | "error";

interface ProbeResult {
	profile: string;
	caseName: string;
	paneId?: string;
	outcome: Outcome;
	echoLatencyMs?: number;
	statusAtEcho?: string;
	sawWorking: boolean;
	sawDone: boolean;
	matchedContext?: string;
	detail?: string;
}

class HerdrNotFoundError extends Error {}

interface HerdrExec {
	stdout: string;
	stderr: string;
	code: number;
}

function herdr(args: string[], timeoutMs = 30_000): Promise<HerdrExec> {
	return new Promise((resolvePromise, rejectPromise) => {
		execFile(
			"herdr",
			args,
			{ timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" },
			(error, stdout, stderr) => {
				if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
					rejectPromise(new HerdrNotFoundError("herdr binary not found on PATH"));
					return;
				}
				const rawCode = error ? (error as { code?: number | string }).code : 0;
				const code = typeof rawCode === "number" ? rawCode : error ? 1 : 0;
				resolvePromise({ stdout: stdout ?? "", stderr: stderr ?? "", code });
			},
		);
	});
}

interface Envelope {
	ok: boolean;
	result?: unknown;
	error?: string;
}

/** Tolerant parser mirroring src/herdr-adapter.ts parseHerdrEnvelope, minimally. */
function parseEnvelope(stdout: string): Envelope {
	const trimmed = stdout.trim();
	if (!trimmed) return { ok: false, error: "empty response" };
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		for (const line of trimmed.split("\n").reverse()) {
			try {
				parsed = JSON.parse(line.trim());
				break;
			} catch {
				// Skip diagnostic lines; prefer the last complete JSON record.
			}
		}
	}
	if (
		parsed === null ||
		parsed === undefined ||
		typeof parsed !== "object" ||
		Array.isArray(parsed)
	) {
		return { ok: false, error: `invalid JSON: ${trimmed.slice(0, 120)}` };
	}
	const obj = parsed as Record<string, unknown>;
	if (typeof obj.ok === "boolean") {
		return {
			ok: obj.ok,
			result: obj.result,
			error: typeof obj.error === "string" ? obj.error : undefined,
		};
	}
	if ("error" in obj) return { ok: false, error: String(obj.error) };
	if ("result" in obj) return { ok: true, result: obj.result };
	return { ok: true, result: obj };
}

interface StartedPane {
	paneId: string;
	status: string;
}

async function agentStart(
	name: string,
	argv: string[],
	cwd: string,
	timeoutMs: number,
): Promise<StartedPane> {
	const { stdout, stderr, code } = await herdr(
		["agent", "start", name, "--cwd", cwd, "--no-focus", "--split", "right", "--", ...argv],
		timeoutMs,
	);
	const env = parseEnvelope(stdout || stderr);
	if (!env.ok) throw new Error(`agent start failed (code ${code}): ${env.error ?? stderr}`);
	let result = env.result as Record<string, unknown> | undefined;
	if (
		result &&
		result.type !== "agent_started" &&
		result.agent_started &&
		typeof result.agent_started === "object"
	) {
		result = result.agent_started as Record<string, unknown>;
	}
	const agent = result?.agent as { pane_id?: unknown; agent_status?: unknown } | undefined;
	if (!agent || typeof agent.pane_id !== "string") throw new Error("agent start: missing pane id");
	return {
		paneId: agent.pane_id,
		status: typeof agent.agent_status === "string" ? agent.agent_status : "unknown",
	};
}

async function paneStatus(paneId: string): Promise<string | undefined> {
	const { stdout } = await herdr(["pane", "get", paneId]);
	const env = parseEnvelope(stdout);
	if (!env.ok || !env.result || typeof env.result !== "object") return undefined;
	const pane = (env.result as { pane?: { agent_status?: unknown } }).pane;
	return typeof pane?.agent_status === "string" ? pane.agent_status : undefined;
}

async function paneRead(paneId: string, lines: number): Promise<string> {
	const { stdout } = await herdr([
		"pane",
		"read",
		paneId,
		"--source",
		"recent-unwrapped",
		"--lines",
		String(lines),
	]);
	const env = parseEnvelope(stdout);
	if (env.ok && env.result && typeof env.result === "object") {
		const read = (env.result as { read?: { text?: unknown } }).read;
		if (read && typeof read.text === "string") return read.text;
	}
	return stdout;
}

async function paneRun(paneId: string, text: string): Promise<void> {
	// Whole prompt as one argv element — no shell interpolation, matching the
	// production adapter's paneRun.
	await herdr(["pane", "run", paneId, text]);
}

async function paneClose(paneId: string): Promise<void> {
	await herdr(["pane", "close", paneId]);
}

/** Mirror of detectStartupBlocker in src/lifecycle.ts. */
function detectBlocker(profile: string, screen: string): string | undefined {
	if (profile === "cursor" && /trust this workspace/i.test(screen)) {
		return "Cursor workspace-trust prompt — approve it in the pane, then re-run this probe.";
	}
	if (profile === "agy" && /not signed in|signing in/i.test(screen)) {
		return "Antigravity sign-in required — authenticate in the pane, then re-run this probe.";
	}
	return undefined;
}

function contextAround(frame: string, markerString: string): string {
	const lines = frame.split("\n");
	const i = lines.findIndex((line) => line.includes(markerString));
	if (i < 0) return "";
	return lines
		.slice(Math.max(0, i - 1), i + 2)
		.join(" ⏎ ")
		.slice(0, 300);
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

interface RunOptions {
	cwd: string;
	timeoutMs: number;
	intervalMs: number;
	keep: boolean;
}

async function runProbe(
	profile: string,
	argv: string[],
	probe: ProbeCase,
	opts: RunOptions,
): Promise<ProbeResult> {
	const marker = `probe-${profile}-${probe.name}-${randomBytes(5).toString("hex")}`;
	const markerString = formatMarker(marker);
	const text = probe.build(marker);
	let paneId: string | undefined;

	const finish = (outcome: Outcome, extra: Partial<ProbeResult> = {}): ProbeResult => ({
		profile,
		caseName: probe.name,
		paneId,
		outcome,
		sawWorking: false,
		sawDone: false,
		...extra,
	});

	try {
		const name = `echo-${profile}-${probe.name}-${randomBytes(3).toString("hex")}`.slice(0, 48);
		const started = await agentStart(name, argv, opts.cwd, opts.timeoutMs);
		paneId = started.paneId;

		const startupDeadline = Date.now() + opts.timeoutMs;
		let status = started.status;
		while (status !== "idle" && status !== "blocked" && status !== "done") {
			if (Date.now() > startupDeadline) {
				return finish("error", { detail: `never reached idle (last status: ${status})` });
			}
			await sleep(opts.intervalMs);
			status = (await paneStatus(paneId)) ?? status;
		}

		let ready = "";
		while (ready.trim().length === 0 && Date.now() <= startupDeadline) {
			ready = await paneRead(paneId, 40);
			if (ready.trim().length === 0) await sleep(opts.intervalMs);
		}
		const blocker = detectBlocker(profile, ready);
		if (blocker) return finish("blocked", { detail: blocker });

		const submittedAt = Date.now();
		await paneRun(paneId, text);
		const echoDeadline = submittedAt + opts.timeoutMs;
		let sawWorking = false;
		let sawDone = false;
		while (Date.now() < echoDeadline) {
			const [frame, st] = await Promise.all([paneRead(paneId, 200), paneStatus(paneId)]);
			if (st === "working") sawWorking = true;
			if (st === "done") sawDone = true;
			if (frame.includes(markerString)) {
				return finish("pass", {
					echoLatencyMs: Date.now() - submittedAt,
					statusAtEcho: st,
					sawWorking,
					sawDone,
					matchedContext: contextAround(frame, markerString),
				});
			}
			await sleep(opts.intervalMs);
		}
		return finish("fail-no-echo", {
			detail: `marker not echoed within ${opts.timeoutMs}ms`,
			sawWorking,
			sawDone,
		});
	} catch (error) {
		if (error instanceof HerdrNotFoundError) throw error;
		return finish("error", { detail: error instanceof Error ? error.message : String(error) });
	} finally {
		if (paneId && !opts.keep) {
			try {
				await paneClose(paneId);
			} catch {
				// Best-effort cleanup; a leaked pane is visible and closeable by hand.
			}
		}
	}
}

interface CliArgs {
	profiles: string[];
	cases: string[];
	timeoutMs: number;
	intervalMs: number;
	keep: boolean;
	cwd: string;
}

function parseArgs(argv: string[]): CliArgs {
	const profiles: string[] = [];
	const cases: string[] = [];
	let timeoutMs = 120_000;
	let intervalMs = 500;
	let keep = false;
	let cwd = process.cwd();
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = () => argv[++i];
		if (arg === "--profile") profiles.push(next());
		else if (arg === "--case") cases.push(next());
		else if (arg === "--timeout") timeoutMs = Number(next());
		else if (arg === "--interval") intervalMs = Number(next());
		else if (arg === "--cwd") cwd = next();
		else if (arg === "--keep") keep = true;
		else throw new Error(`Unknown argument: ${arg}`);
	}
	return {
		profiles: profiles.length ? profiles : Object.keys(PROFILE_ARGV),
		cases: cases.length ? cases : CASES.map((c) => c.name),
		timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 120_000,
		intervalMs: Number.isFinite(intervalMs) ? intervalMs : 500,
		keep,
		cwd,
	};
}

function printResult(result: ProbeResult): void {
	const badge = {
		pass: "PASS",
		"fail-no-echo": "FAIL",
		blocked: "BLOCKED",
		error: "ERROR",
	}[result.outcome];
	const bits = [`[${badge}] ${result.profile}/${result.caseName}`];
	if (result.echoLatencyMs !== undefined) bits.push(`echo=${result.echoLatencyMs}ms`);
	if (result.statusAtEcho) bits.push(`status@echo=${result.statusAtEcho}`);
	bits.push(`working=${result.sawWorking} done=${result.sawDone}`);
	if (result.detail) bits.push(`— ${result.detail}`);
	console.log(bits.join(" "));
	if (result.matchedContext) console.log(`      matched: ${result.matchedContext}`);
}

async function main(): Promise<number> {
	const args = parseArgs(process.argv.slice(2));

	if (process.env.HERDR_ENV !== "1") {
		console.error(
			"HERDR_ENV != 1 — run this probe from inside a Herdr pane, where peer agents can be launched.",
		);
		return 2;
	}

	const unknownProfiles = args.profiles.filter((p) => !PROFILE_ARGV[p]);
	if (unknownProfiles.length) {
		console.error(
			`Unknown profile(s): ${unknownProfiles.join(", ")}. Known: ${Object.keys(PROFILE_ARGV).join(", ")}`,
		);
		return 2;
	}
	const selectedCases = CASES.filter((c) => args.cases.includes(c.name));
	if (!selectedCases.length) {
		console.error(`No matching cases. Known: ${CASES.map((c) => c.name).join(", ")}`);
		return 2;
	}

	console.log(
		`Marker-echo probe — profiles=[${args.profiles.join(", ")}] cases=[${selectedCases.map((c) => c.name).join(", ")}] timeout=${args.timeoutMs}ms\n`,
	);

	const results: ProbeResult[] = [];
	try {
		for (const profile of args.profiles) {
			for (const probe of selectedCases) {
				const result = await runProbe(profile, PROFILE_ARGV[profile], probe, {
					cwd: args.cwd,
					timeoutMs: args.timeoutMs,
					intervalMs: args.intervalMs,
					keep: args.keep,
				});
				results.push(result);
				printResult(result);
			}
		}
	} catch (error) {
		if (error instanceof HerdrNotFoundError) {
			console.error(
				"\nherdr binary not found on PATH — this probe must run in a Herdr environment.",
			);
			return 2;
		}
		throw error;
	}

	console.log("\n--- summary (paste into docs/marker-echo-checklist.md) ---");
	console.log(JSON.stringify(results, null, 2));

	const failed = results.filter((r) => r.outcome === "fail-no-echo" || r.outcome === "error");
	const blocked = results.filter((r) => r.outcome === "blocked");
	if (failed.length) {
		console.error(
			`\n${failed.length} probe(s) did not echo the marker. For those profiles, launchAgent will time out on accepted tasks — see the fallback note in docs/marker-echo-checklist.md.`,
		);
		return 1;
	}
	if (blocked.length) {
		console.log(`\n${blocked.length} probe(s) blocked on startup screens; resolve and re-run.`);
	}
	console.log(
		"\nAll runnable probes echoed the marker — waitForSubmissionEcho is safe for these profiles.",
	);
	return 0;
}

if ((import.meta as unknown as { main?: boolean }).main === true) {
	main()
		.then((code) => process.exit(code))
		.catch((error) => {
			console.error(error instanceof Error ? error.stack : String(error));
			process.exit(1);
		});
}
