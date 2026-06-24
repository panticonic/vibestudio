import { describe, expect, it } from "vitest";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import type { ParticipantDescriptor } from "@workspace/harness";
import type { AgentTool } from "@workspace/pi-core";
import type { StepPolicy } from "@workspace/agent-loop";

import { ExplorerAgentWorker, unrelatedFindingPublishPaths } from "./index.js";

class TestExplorerAgentWorker extends ExplorerAgentWorker {
  participant(): ParticipantDescriptor {
    return this.getParticipantInfo("ch-1");
  }
  prompt(): string | undefined {
    return this.getAgentPrompt("ch-1");
  }
  policies(): StepPolicy[] {
    return this.getStepPolicies("ch-1");
  }
  tools(): AgentTool[] {
    return this.getLoopTools("ch-1");
  }
  respondPolicy(): string {
    return this.getDefaultRespondPolicy();
  }
}

describe("ExplorerAgentWorker", () => {
  it("detects unpublished changes outside the generated findings file", () => {
    expect(
      unrelatedFindingPublishPaths(
        {
          files: [
            { path: "explorer/findings/run-1.md" },
            { path: "src/app.ts" },
            { path: "src/app.ts" },
            { path: "docs/readme.md" },
          ],
        },
        "explorer/findings/run-1.md"
      )
    ).toEqual(["docs/readme.md", "src/app.ts"]);
  });

  it("is a silent agent with explorer identity + oracle-loop prompt", async () => {
    const { instance } = await createTestDO(TestExplorerAgentWorker);
    const worker = instance as TestExplorerAgentWorker;

    const participant = worker.participant();
    expect(participant.handle).toBe("explorer");
    expect(participant.name).toBe("Explorer");

    const prompt = worker.prompt();
    expect(prompt).toMatch(/explorer/i);
    expect(prompt).toMatch(/expectation/i); // the oracle loop is load-bearing

    // Visible when it responds — silence is via the respond policy, not output suppression.
    expect(worker.policies().some((policy) => policy.name === "silent")).toBe(false);

    // Does NOT respond to every message — else it would run a concurrent turn on each
    // channel message alongside other agents, diverging the shared per-channel log.
    expect(worker.respondPolicy()).toBe("mentioned-or-followup");
  });

  it("runScheduledJob is a no-op with no subscriptions", async () => {
    const { instance } = await createTestDO(TestExplorerAgentWorker);
    const worker = instance as TestExplorerAgentWorker;
    const result = await worker.runScheduledJob({ job: "sweep" });
    expect(result).toEqual({ ok: true, channels: 0 });
  });

  it("exposes report_finding alongside the inherited say tool", async () => {
    const { instance } = await createTestDO(TestExplorerAgentWorker);
    const worker = instance as TestExplorerAgentWorker;
    const names = worker.tools().map((tool) => tool.name);
    expect(names).toContain("report_finding");
    expect(names).toContain("say");
  });
});
