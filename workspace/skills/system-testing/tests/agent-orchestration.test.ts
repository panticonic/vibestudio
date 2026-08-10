import { describe, expect, it } from "vitest";

import { agentGoalPromptFindings } from "../prompt-contract.js";
import { agentOrchestrationTests } from "./agent-orchestration.js";

describe("agent orchestration scenarios", () => {
  it("state user goals without embedding the subagent API or runtime configuration", () => {
    for (const test of agentOrchestrationTests) {
      expect(agentGoalPromptFindings(test.prompt), test.name).toEqual([]);
      expect(test.validation, test.name).toBeUndefined();
    }
  });

  it("keeps model selection out of scenario prose", () => {
    for (const test of agentOrchestrationTests) {
      expect(test.prompt, test.name).not.toMatch(/gpt-|claude-\d|thinkingLevel|launchConfig/u);
    }
  });

  it("keeps the delegated design synthesis independent of workspace fixtures", () => {
    const synthesis = agentOrchestrationTests.find(
      ({ name }) => name === "subagent-design-synthesis"
    );
    expect(synthesis?.authorityPolicy).toBeUndefined();
    expect(synthesis?.workspaceRepoFixture).toBeUndefined();
    expect(synthesis?.prompt).toContain("There is no existing codebase");
    expect(synthesis?.prompt).toContain(
      "Delegate two independent reviews concurrently to subagents"
    );
    expect(synthesis?.prompt).toContain("at most five bullets");
    expect(synthesis?.prompt).toContain("both replies are in the conversation");
    expect(synthesis?.prompt).toContain("one synthesis under 500 words");
    expect(synthesis?.prompt).not.toContain("finish supervising");
  });

  it("keeps delegation quality in trajectory review rather than stale task-card validation", () => {
    const synthesis = agentOrchestrationTests.find(
      ({ name }) => name === "subagent-design-synthesis"
    );
    expect(synthesis?.validation).toBeUndefined();
    expect(synthesis?.validate).toBeDefined();
  });
});
