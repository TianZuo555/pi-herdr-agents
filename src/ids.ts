import { randomBytes } from "node:crypto";

let counter = 0;

export function generateAgentId(): string {
	const suffix = randomBytes(4).toString("hex");
	counter += 1;
	return `herdr-agent-${suffix}-${counter}`;
}

export function makeHerdrAgentName(profile: string, agentId: string): string {
	const safeProfile = profile.replace(/[^a-z0-9_-]/gi, "-").slice(0, 16);
	// Keep the random id segment as well as the process-local counter. Names are
	// used to reconcile failed starts and therefore must stay unique across
	// extension reloads, not merely within one Node process.
	const suffix = agentId.replace(/^herdr-agent-/, "") || randomBytes(4).toString("hex");
	return `${safeProfile}-${suffix}`.slice(0, 48);
}

export function generateTaskMarker(agentId: string): string {
	return `${agentId}-${randomBytes(6).toString("hex")}`;
}
