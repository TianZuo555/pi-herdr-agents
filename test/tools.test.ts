import { describe, expect, it } from "vitest";
import { HERDR_PARENT_SYSTEM_PROMPT } from "../src/roles.js";
import { AgentStore } from "../src/store.js";
import { createHerdrAgentTools } from "../src/tools.js";
import { FakeHerdrAdapter } from "./fake-adapter.js";

describe("tool surface and parent guidance", () => {
	it("keeps the lifecycle and fleet tools", () => {
		const tools = createHerdrAgentTools({
			store: new AgentStore(),
			adapter: new FakeHerdrAdapter(),
			getAgentDir: () => "/tmp/pi-agent",
		});
		expect(tools.map((tool) => tool.name)).toEqual([
			"herdr_launch_agent",
			"herdr_get_agent_result",
			"herdr_list_agents",
			"herdr_steer_agent",
			"herdr_stop_agent",
		]);

		const launchSchema = tools[0]?.parameters as { required?: string[] };
		expect(launchSchema.required).toContain("role");
		expect(launchSchema.required).toContain("prompt");
		const listSchema = tools[2]?.parameters as { properties?: Record<string, unknown> };
		expect(listSchema.properties).toHaveProperty("include_stopped");
		const steerSchema = tools[3]?.parameters as { properties?: Record<string, unknown> };
		expect(steerSchema.properties).toHaveProperty("force_resubmit");
	});

	it("teaches lifecycle, context handoff, and write isolation", () => {
		expect(HERDR_PARENT_SYSTEM_PROMPT).toContain("<herdr-peer-delegation>");
		expect(HERDR_PARENT_SYSTEM_PROMPT).toContain("inherit no conversation context");
		expect(HERDR_PARENT_SYSTEM_PROMPT).toContain("herdr_get_agent_result");
		expect(HERDR_PARENT_SYSTEM_PROMPT).toContain("herdr_stop_agent");
		expect(HERDR_PARENT_SYSTEM_PROMPT).toContain("serialized per working directory");
		expect(HERDR_PARENT_SYSTEM_PROMPT).toContain("herdr_list_agents");
	});
});
