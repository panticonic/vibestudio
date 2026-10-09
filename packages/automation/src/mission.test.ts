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
  createMissionsClient,
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

describe("author-side missions client", () => {
  it("passes observation cancellation as invocation metadata and keeps the version in wire arguments", async () => {
    const controller = new AbortController();
    const call = vi.fn(async (_target: string, method: string) =>
      method === "workers.resolveService"
        ? { kind: "durable-object", targetId: "missions" }
        : { version: "new" }
    );
    await expect(
      createMissionsClient({ call }).observeChanges({
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
      if (method === "authority.compileAuthorityPlan") return { schemaVersion: 2, digest: hex };
      if (method === "workers.resolveService")
        return { kind: "durable-object", targetId: "missions" };
      return { missionId: "mission-1" };
    });
    await createMissionsClient({ call }).launch(
      { name: "Backup", charter: charter() },
      { idempotencyKey: "request-1" }
    );
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
      [expect.objectContaining({ authorityPlan: { schemaVersion: 2, digest: hex } })],
      { idempotencyKey: "request-1" }
    );
  });

  it("does not dispatch a launch when plan compilation fails", async () => {
    const original = new Error("author cannot access context");
    const call = vi.fn(async () => {
      throw original;
    });
    await expect(
      createMissionsClient({ call }).launch({ name: "Backup", charter: charter() })
    ).rejects.toBe(original);
    expect(call).toHaveBeenCalledOnce();
  });

  it("keeps a current non-seeded plan for a name-only edit and recompiles a seeded default", async () => {
    let seeded = false;
    const call = vi.fn(async (_target: string, method: string) => {
      if (method === "workers.resolveService")
        return { kind: "durable-object", targetId: "missions" };
      if (method === "get")
        return { charter: charter(), authorityPlan: { schemaVersion: 2, digest: hex }, seeded };
      if (method === "authority.compileAuthorityPlan") return { schemaVersion: 2, digest: hex };
      return { missionId: "mission-1" };
    });
    const client = createMissionsClient({ call });
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
