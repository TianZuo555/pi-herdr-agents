import { randomBytes } from "node:crypto";

let counter = 0;

export function generateAgentId(): string {
	const suffix = randomBytes(4).toString("hex");
	counter += 1;
	return `herdr-agent-${suffix}-${counter}`;
}

export function makeHerdrAgentName(profile: string, agentId: string): string {
	const safeProfile = profile.replace(/[^a-z0-9_-]/gi, "-").slice(0, 16);
	const suffix = agentId.split("-").pop() ?? "0";
	return `${safeProfile}-${suffix}`.slice(0, 48);
}
