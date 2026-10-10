import { schemaRpcCaller } from "@vibestudio/rpc/internal";
import { createMissionsClient } from "@vibestudio/service-schemas/clients/missionsClient";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { canonicalJson } from "@vibestudio/shared/canonicalJson";
import {
  missionCompletionResponse,
  missionNextRunAt,
  missionPrincipal,
  missionRevisionDigest,
  missionExecutionImageDigest,
  validateMissionCharter,
  type MissionCharter,
} from "./mission.js";

const hex = "a".repeat(64);
const charter = (): MissionCharter => ({
  summary: "Back up the project",
  execution: {
    kind: "agent",
    image: {
      source: "workers/system-agent",
      ref: `state:${"b".repeat(64)}`,
      effectiveVersion: hex,
      className: "SystemAgent",
      objectKey: "backup",
    },
    action: { kind: "prompt", text: "Back up the project" },
    conversation: { mode: "fresh" },
    operations: [
      { service: "notification", method: "post", use: "action" },
      { service: "logs", method: "query", use: "conditional" },
    ],
  },
  trigger: { kind: "schedule", everyMs: 86_400_000, anchorAt: 1_000 },
});

const authorityPlan = () => ({
  schemaVersion: 2 as const,
  digest: hex,
  artifactRef: `authority-plan:${hex}` as const,
  compilerVersion: "test",
  catalogDigest: hex,
});
const resolvedMissions = () => ({
  kind: "durable-object",
  targetId: "missions",
  source: "workers/missions",
  name: "missions",
  className: "MissionsDO",
  objectKey: "workspace",
  action: "automate",
  presentation: { domain: "automation", verb: "act" },
  authority: { principals: ["code"], binding: "declared" },
  origin: "workspace",
  protocols: ["missions.v1"],
});
const missionRecord = () => ({
  schemaVersion: 3,
  missionId: "mission-1",
  name: "Backup",
  revision: 1,
  charter: charter(),
  authorityPlan: authorityPlan(),
  owner: { userId: "author" },
  state: "active",
  revisionDigest: hex,
  authority: { requestIds: [], grantIds: [], denialIds: [] },
  createdAt: 1000,
  updatedAt: 1000,
  activatedAt: 1000,
  runCount: 0,
});

describe("author-side missions client", () => {
  it("preserves exact namespaced tool identity and rejects invalid tool arguments", () => {
    const value = charter();
    if (value.execution.kind !== "agent") throw new Error("Expected agent");
    value.execution.action = {
      kind: "tool",
      tool: "vibestudio.refresh-now",
      args: { briefing: false },
    };
    expect(() => validateMissionCharter(value)).not.toThrow();
    const originalDigest = missionRevisionDigest(value, hex);
    value.execution.action.args = { briefing: true };
    expect(missionRevisionDigest(value, hex)).not.toBe(originalDigest);
    value.execution.action.tool = " ";
    expect(() => validateMissionCharter(value)).toThrow("selected tool name");
    value.execution.action.tool = "x".repeat(129);
    expect(() => validateMissionCharter(value)).toThrow("selected tool name");
    value.execution.action.tool = "vibestudio.refresh-now";
    value.execution.action.args = [] as unknown as Record<string, unknown>;
    expect(() => validateMissionCharter(value)).toThrow("object arguments");
  });
  it("passes observation cancellation as invocation metadata and keeps the version in wire arguments", async () => {
    const controller = new AbortController();
    const call = vi.fn(async (_target: string, method: string) =>
      method === "workers.resolveService" ? resolvedMissions() : { version: "new" }
    );
    await expect(
      createMissionsClient(
        schemaRpcCaller({
          call,
          stream: async () => {
            throw new Error("Unexpected stream");
          },
        })
      ).observeChanges({
        afterVersion: "old",
        signal: controller.signal,
      })
    ).resolves.toEqual({ version: "new" });
    expect(call).toHaveBeenLastCalledWith("missions", "observeChanges", [{ afterVersion: "old" }], {
      signal: controller.signal,
    });
  });
  it("compiles the author's plan before dispatch and gives each operation its own idempotency key", async () => {
    const call = vi.fn(async (_target: string, method: string) => {
      if (method === "authority.compileAuthorityPlan") return authorityPlan();
      if (method === "workers.resolveService") return resolvedMissions();
      return missionRecord();
    });
    await createMissionsClient(
      schemaRpcCaller({
        call,
        stream: async () => {
          throw new Error("Unexpected stream");
        },
      })
    ).launch({ name: "Backup", charter: charter() }, { idempotencyKey: "request-1" });
    expect(call.mock.calls.map((args) => args[1])).toEqual([
      "authority.compileAuthorityPlan",
      "workers.resolveService",
      "launch",
    ]);
    expect(call).toHaveBeenNthCalledWith(
      1,
      "main",
      "authority.compileAuthorityPlan",
      [{ execution: charter().execution }],
      { idempotencyKey: "request-1:authority-plan" }
    );
    expect(call).toHaveBeenNthCalledWith(
      3,
      "missions",
      "launch",
      [expect.objectContaining({ authorityPlan: authorityPlan() })],
      { idempotencyKey: "request-1" }
    );
  });

  it("does not dispatch a launch when plan compilation fails", async () => {
    const original = new Error("author cannot access context");
    const call = vi.fn(async () => {
      throw original;
    });
    await expect(
      createMissionsClient(
        schemaRpcCaller({
          call,
          stream: async () => {
            throw new Error("Unexpected stream");
          },
        })
      ).launch({ name: "Backup", charter: charter() })
    ).rejects.toBe(original);
    expect(call).toHaveBeenCalledOnce();
  });

  it("keeps a current non-seeded plan for a name-only edit and recompiles a seeded default", async () => {
    let seeded = false;
    const call = vi.fn(async (_target: string, method: string) => {
      if (method === "workers.resolveService") return resolvedMissions();
      if (method === "get") return { ...missionRecord(), seeded };
      if (method === "authority.compileAuthorityPlan") return authorityPlan();
      return missionRecord();
    });
    const client = createMissionsClient(
      schemaRpcCaller({
        call,
        stream: async () => {
          throw new Error("Unexpected stream");
        },
      })
    );
    await client.edit("mission-1", { name: "Renamed" });
    expect(call.mock.calls.map((args) => args[1])).toEqual([
      "workers.resolveService",
      "get",
      "edit",
    ]);
    call.mockClear();
    seeded = true;
    await client.edit("mission-1", { name: "Customized" });
    expect(call.mock.calls.map((args) => args[1])).toEqual([
      "get",
      "authority.compileAuthorityPlan",
      "edit",
    ]);
  });
});

describe("automation revision", () => {
  it("requires notifications to have text and a continuing conversation", () => {
    const value = charter();
    if (value.execution.kind !== "agent") throw new Error("Expected agent");
    value.execution.action = { kind: "notify", text: "Review the rollout" };
    expect(() => validateMissionCharter(value)).toThrow("conversation that created them");
    value.execution.conversation = {
      mode: "continue",
      channelId: "channel",
      contextId: "context",
      executorId: "executor",
    };
    expect(() => validateMissionCharter(value)).not.toThrow();
    value.execution.action.text = "  ";
    expect(() => validateMissionCharter(value)).toThrow("requires text");
  });

  it("rejects notify metadata outside the delivery contract", () => {
    const value = charter();
    if (value.execution.kind !== "agent") throw new Error("Expected agent");
    value.execution.conversation = {
      mode: "continue",
      channelId: "channel",
      contextId: "context",
      executorId: "executor",
    };
    const notifyAction = {
      kind: "notify",
      text: "Review the rollout",
      title: "  ",
      alert: "interrupt",
    } as const;
    value.execution.action = notifyAction;
    expect(() => validateMissionCharter(value)).toThrow("title must be non-empty text");

    const invalidAlertAction = {
      ...notifyAction,
      title: "Reminder",
      alert: "urgent",
    } as const;
    value.execution.action = invalidAlertAction as never;
    expect(() => validateMissionCharter(value)).toThrow('alert must be "inbox" or "interrupt"');
  });

  it("keeps mission digests byte-for-byte compatible with the Node SHA-256 contract", () => {
    const referenceDigest = (prefix: string, value: unknown) =>
      createHash("sha256")
        .update(prefix, "utf8")
        .update(canonicalJson(value), "utf8")
        .digest("hex");
    const value = charter();
    const image = value.execution.image;

    expect(missionRevisionDigest(value, hex)).toBe(
      referenceDigest("automation-revision-v2\0", {
        charter: value,
        authorityPlanDigest: hex,
      })
    );
    expect(missionExecutionImageDigest(image)).toBe(
      referenceDigest("mission-execution-image-v1\0", {
        source: image.source,
        ref: image.ref,
        effectiveVersion: image.effectiveVersion,
        className: image.className,
      })
    );
  });

  it("requires one immutable execution image", () => {
    const value = charter();
    value.execution.image.ref = "state:bad";
    expect(() => validateMissionCharter(value)).toThrow("exact immutable execution image");
  });

  it("closes over executable behavior and compiled authority plan", () => {
    const first = missionRevisionDigest(charter(), hex);
    expect(
      missionRevisionDigest(
        { ...charter(), trigger: { kind: "schedule", everyMs: 3_600_000 } },
        hex
      )
    ).not.toBe(first);
    expect(missionRevisionDigest(charter(), "b".repeat(64))).not.toBe(first);
    expect(missionPrincipal("backup", first)).toBe(`mission:backup@${first}`);
  });

  it("requires exact operations and rejects duplicates", () => {
    const duplicate = charter();
    duplicate.execution.operations = [
      { service: "notification", method: "post", use: "action" },
      { service: "notification", method: "post", use: "conditional" },
    ];
    expect(() => validateMissionCharter(duplicate)).toThrow("Duplicate automation operation");
    const inexact = charter();
    inexact.execution.operations = [{ service: "*", method: "request", use: "action" }];
    expect(() => validateMissionCharter(inexact)).toThrow("exact service and method names");
  });

  it("computes aligned and calendar occurrences", () => {
    expect(missionNextRunAt({ kind: "schedule", everyMs: 60_000, anchorAt: 500 }, 500)).toBe(
      60_500
    );
    const cron = { kind: "cron", expression: "5 5 * * THU", timezone: "America/New_York" } as const;
    expect(missionNextRunAt(cron, Date.UTC(2026, 2, 5, 10, 4, 59))).toBe(
      Date.UTC(2026, 2, 5, 10, 5)
    );
  });

  it("recognizes only explicit natural completion", () => {
    expect(
      missionCompletionResponse({ protocol: "automation-completion.v1", response: "  Complete.  " })
    ).toEqual({ protocol: "automation-completion.v1", response: "Complete." });
    expect(missionCompletionResponse({ response: "done" })).toBeNull();
  });
});
