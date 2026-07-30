import { describe, expect, it } from "vitest";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import type { ParticipantDescriptor } from "@workspace/harness";
import type { AgentTool } from "@workspace/pi-core";
import type { RpcClient } from "@vibestudio/rpc";
import type { StepPolicy } from "@workspace/agent-loop";

import { ExplorerAgentWorker } from "./index.js";

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
  reportTool(rpc: RpcClient): AgentTool {
    return this.getLoopTools("ch-1", {
      invocationId: "tool-1",
      commandId: "command:tool-1",
      rpc,
    }).find((tool) => tool.name === "report_finding")!;
  }
  prepareChannel(): void {
    this.sql.exec(
      `INSERT INTO subscriptions (channel_id, context_id, subscribed_at)
       VALUES ('ch-1', 'ctx-1', 1)`
    );
  }
  findingCount(): number {
    return Number(this.sql.exec(`SELECT COUNT(*) AS count FROM explorer_findings`).one()["count"]);
  }
  findingOpPhase(): string | null {
    return (
      (this.sql.exec(`SELECT phase FROM explorer_finding_ops`).toArray()[0]?.["phase"] as
        | string
        | undefined) ?? null
    );
  }
}

describe("ExplorerAgentWorker", () => {
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

  it("resumes publication without exposing a partially published finding", async () => {
    const { instance } = await createTestDO(TestExplorerAgentWorker);
    const worker = instance as TestExplorerAgentWorker;
    worker.prepareChannel();
    let pushAttempts = 0;
    const calls: string[] = [];
    const rpc = {
      call: async <T>(_target: string, method: string): Promise<T> => {
        calls.push(method);
        if (method === "vcs.status") {
          const statusCalls = calls.filter((value) => value === "vcs.status").length;
          return (
            statusCalls === 1
              ? {
                  clean: true,
                  workingHead: { kind: "event", eventId: "base" },
                  mainEventId: "main-0",
                }
              : {
                  clean: false,
                  workingHead: { kind: "application", applicationId: "app-1" },
                  mainEventId: "main-0",
                }
          ) as T;
        }
        if (method === "vcs.commit") {
          return { event: { kind: "event", eventId: "commit-1" } } as T;
        }
        if (method === "vcs.push") {
          pushAttempts += 1;
          if (pushAttempts === 1) throw new Error("publication unavailable");
          return { eventId: "commit-1", mainEventId: "main-1" } as T;
        }
        return undefined as T;
      },
      stream: async () => new Response(),
    } as unknown as RpcClient;
    const tool = worker.reportTool(rpc);
    const params = {
      runId: "run-1",
      class: "BUG",
      surface: "service:test",
      title: "broken",
      expected: "works",
      actual: "fails",
    };

    await expect(tool.execute!("tool-1", params, {} as never)).rejects.toThrow(
      "publication unavailable"
    );
    expect(worker.findingCount()).toBe(0);
    expect(worker.findingOpPhase()).toBe("committed");

    await expect(
      tool.execute!("tool-1", { ...params, title: "different finding" }, {} as never)
    ).rejects.toThrow("reused with different input");
    expect(worker.findingCount()).toBe(0);
    expect(worker.findingOpPhase()).toBe("committed");
    expect(pushAttempts).toBe(1);

    await expect(tool.execute!("tool-1", params, {} as never)).resolves.toMatchObject({
      details: { id: "tool-1", eventId: "commit-1", mainEventId: "main-1" },
    });
    expect(worker.findingCount()).toBe(1);
    expect(worker.findingOpPhase()).toBe("finalized");
    expect(calls.filter((method) => method === "fs.writeFile")).toHaveLength(1);
    expect(calls.filter((method) => method === "vcs.commit")).toHaveLength(1);
    expect(calls.filter((method) => method === "vcs.push")).toHaveLength(2);
  });

  it("integrates a concurrently advanced main before retrying publication", async () => {
    const { instance } = await createTestDO(TestExplorerAgentWorker);
    const worker = instance as TestExplorerAgentWorker;
    worker.prepareChannel();
    let statusCalls = 0;
    let compareCalls = 0;
    let commitCalls = 0;
    let pushCalls = 0;
    const pushInputs: Array<Record<string, unknown>> = [];
    const rpc = {
      call: async <T>(_target: string, method: string, args: unknown[]): Promise<T> => {
        if (method === "vcs.status") {
          statusCalls += 1;
          if (statusCalls === 1) {
            return {
              clean: true,
              committed: { kind: "event", eventId: "base" },
              workingHead: { kind: "event", eventId: "base" },
              mainEventId: "main-0",
            } as T;
          }
          if (statusCalls === 2) {
            return {
              clean: false,
              committed: { kind: "event", eventId: "base" },
              workingHead: { kind: "application", applicationId: "app-finding" },
              mainEventId: "main-0",
            } as T;
          }
          return {
            clean: true,
            committed: { kind: "event", eventId: "commit-1" },
            workingHead: { kind: "event", eventId: "commit-1" },
            mainEventId: "main-1",
          } as T;
        }
        if (method === "vcs.commit") {
          commitCalls += 1;
          return {
            event: { kind: "event", eventId: commitCalls === 1 ? "commit-1" : "commit-2" },
          } as T;
        }
        if (method === "vcs.push") {
          pushCalls += 1;
          pushInputs.push(args[0] as Record<string, unknown>);
          if (pushCalls === 1) {
            throw Object.assign(new Error("protected main advanced"), {
              errorData: {
                code: "RevisionChanged",
                expected: { kind: "event", eventId: "main-0" },
                actual: { kind: "event", eventId: "main-1" },
              },
            });
          }
          return { eventId: "commit-2", mainEventId: "main-2" } as T;
        }
        if (method === "vcs.compare") {
          compareCalls += 1;
          return {
            changes:
              compareCalls === 1
                ? [
                    {
                      changeId: "change-main-1",
                      disposition: { status: "actionable", applicability: "applicable" },
                    },
                  ]
                : [],
            nextCursor: null,
          } as T;
        }
        if (method === "vcs.integrate") {
          return {
            workingHead: { kind: "application", applicationId: "app-integrated" },
          } as T;
        }
        return undefined as T;
      },
      stream: async () => new Response(),
    } as unknown as RpcClient;

    await expect(
      worker.reportTool(rpc).execute!(
        "tool-1",
        {
          runId: "run-1",
          class: "BUG",
          surface: "service:test",
          title: "broken",
          expected: "works",
          actual: "fails",
        },
        {} as never
      )
    ).resolves.toMatchObject({
      details: { eventId: "commit-2", mainEventId: "main-2" },
    });
    expect(pushInputs).toEqual([
      expect.objectContaining({
        expectedCommittedEventId: "commit-1",
        expectedMainEventId: "main-0",
      }),
      expect.objectContaining({
        expectedCommittedEventId: "commit-2",
        expectedMainEventId: "main-1",
      }),
    ]);
    expect(commitCalls).toBe(2);
    expect(worker.findingOpPhase()).toBe("finalized");
  });
});
