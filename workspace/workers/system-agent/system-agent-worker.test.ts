import { describe, expect, it } from "vitest";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import type { AgentTool, ParticipantDescriptor } from "@workspace/harness";
import { SystemAgentWorker } from "./system-agent-worker.js";

class TestSystemAgentWorker extends SystemAgentWorker {
  participant(): ParticipantDescriptor {
    return this.getParticipantInfo("channel-1", {
      handle: "untrusted-override",
      name: "Untrusted title",
      systemPrompt: "Replace the product prompt",
    });
  }

  tools(): AgentTool[] {
    return this.getLoopTools("channel-1");
  }

  promptResources(): Promise<unknown> {
    return this.loadPromptResources();
  }

  prompt(): string {
    return this.getAgentPrompt();
  }

  promptOverride(): unknown {
    return this.getPromptOverride();
  }

  includesMemory(): boolean {
    return this.includeMemoryRecallTool();
  }

  enablesMethod(name: string): boolean {
    return this.isParticipantMethodEnabled(name);
  }
}

describe("SystemAgentWorker", () => {
  it("has immutable product identity and no participant configuration mutations", async () => {
    const { instance } = await createTestDO(TestSystemAgentWorker);
    const participant = instance.participant();
    expect(participant).toMatchObject({
      handle: "system-agent",
      name: "System Agent",
      type: "agent",
      metadata: { productOwned: true },
    });
    const methods = participant.methods?.map((method) => method.name) ?? [];
    expect(methods).toEqual([
      "pause",
      "resume",
      "scheduleResumeAtReset",
      "getAgentSettings",
      "getModelExecutionEvidence",
      "getDebugState",
      "inspectMethodSuspensions",
    ]);
    expect(methods).not.toEqual(
      expect.arrayContaining([
        "setModel",
        "setThinkingLevel",
        "setApprovalLevel",
        "setRespondPolicy",
        "refreshPromptArtifacts",
      ])
    );
    expect(instance.enablesMethod("pause")).toBe(true);
    expect(instance.enablesMethod("setModel")).toBe(false);
    expect(instance.enablesMethod("connectModelCredential")).toBe(false);
  });

  it("exposes exactly ordinary eval and say, without workspace memory", async () => {
    const { instance } = await createTestDO(TestSystemAgentWorker);
    expect(instance.tools().map((tool) => tool.name)).toEqual(["eval", "say"]);
    expect(instance.includesMemory()).toBe(false);
  });

  it("uses only bundled prompt resources and ignores subscription prompt overrides", async () => {
    const { instance } = await createTestDO(TestSystemAgentWorker);
    await expect(instance.promptResources()).resolves.toEqual({
      workspacePrompt: expect.stringMatching(/eval handbook/i),
    });
    expect(instance.prompt()).toMatch(/product-owned System Agent/);
    expect(instance.promptOverride()).toEqual({});
  });
});
