import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createHerdrAdapter } from "./herdr-adapter.js";
import { HERDR_PARENT_SYSTEM_PROMPT } from "./roles.js";
import { AgentStore, restoreAndValidateRecords } from "./store.js";
import { createHerdrAgentTools } from "./tools.js";

export default function (pi: ExtensionAPI) {
	const store = new AgentStore();
	store.setAppendEntry((customType: string, data?: unknown) => pi.appendEntry(customType, data));

	const adapter = createHerdrAdapter((command, args, options) => pi.exec(command, args, options));

	const host = {
		store,
		adapter,
		getAgentDir,
	};

	for (const tool of createHerdrAgentTools(host)) {
		pi.registerTool(tool);
	}

	pi.on("before_agent_start", (event) => {
		if (process.env.HERDR_ENV !== "1") return;
		if (event.systemPrompt.includes("<herdr-peer-delegation>")) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${HERDR_PARENT_SYSTEM_PROMPT}`,
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		store.restoreFromBranch(ctx.sessionManager.getBranch());
		await restoreAndValidateRecords(store, adapter, ctx.signal);
	});

	pi.on("session_tree", async (_event, ctx) => {
		store.restoreFromBranch(ctx.sessionManager.getBranch());
		await restoreAndValidateRecords(store, adapter, ctx.signal);
	});

	pi.on("session_shutdown", async () => {
		store.clear();
	});
}

export { AgentStore } from "./store.js";
export { createHerdrAdapter, buildAgentStartArgv } from "./herdr-adapter.js";
export { resolveProfiles, BUILTIN_PROFILES } from "./profiles.js";
export {
	resolveRoles,
	BUILTIN_ROLES,
	buildRoleAssignment,
	HERDR_PARENT_SYSTEM_PROMPT,
} from "./roles.js";
export { launchAgent, getAgentResult, steerAgent, stopAgent } from "./lifecycle.js";
export type * from "./types.js";
