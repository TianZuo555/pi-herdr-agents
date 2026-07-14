import type { HerdrContext } from "./types.js";

export interface HerdrEnvCheck {
	ok: true;
	context: HerdrContext;
}

export interface HerdrEnvError {
	ok: false;
	error: string;
}

export type HerdrEnvResult = HerdrEnvCheck | HerdrEnvError;

function readRequiredEnv(name: string): string | undefined {
	const value = process.env[name];
	if (!value || value.trim().length === 0) return undefined;
	return value.trim();
}

export function requireHerdrContext(): HerdrEnvResult {
	if (process.env.HERDR_ENV !== "1") {
		return {
			ok: false,
			error: "HERDR_ENV=1 is required. Launch peer agents only from inside a Herdr-managed pane.",
		};
	}

	const workspaceId = readRequiredEnv("HERDR_WORKSPACE_ID");
	const tabId = readRequiredEnv("HERDR_TAB_ID");
	const paneId = readRequiredEnv("HERDR_PANE_ID");

	const missing: string[] = [];
	if (!workspaceId) missing.push("HERDR_WORKSPACE_ID");
	if (!tabId) missing.push("HERDR_TAB_ID");
	if (!paneId) missing.push("HERDR_PANE_ID");

	if (missing.length > 0) {
		return {
			ok: false,
			error: `Missing Herdr context environment variable(s): ${missing.join(", ")}`,
		};
	}

	if (!workspaceId || !tabId || !paneId) {
		return { ok: false, error: "Missing Herdr context after validation" };
	}
	return {
		ok: true,
		context: { workspaceId, tabId, paneId },
	};
}
