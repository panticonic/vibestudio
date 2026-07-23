import { describe, expect, it } from "vitest";
import type { AuthenticatedCaller } from "@vibestudio/rpc";
import { DurableObjectBase, rpc } from "./index.js";
import { createTestDO, createTestDirectAuthority } from "./test-utils.js";

/**
 * Regression for the path-aware `assertInboundAllowed`: a server-only DO (like
 * the EvalDO) must REFUSE non-server method CALLS but still ACCEPT event
 * DELIVERIES (opt-in subscriptions pushed by a channel DO / server event-push).
 * A blanket server-only guard on both paths broke channel delivery to a
 * subscribed EvalDO ("DO RPC relay failed (500): EvalDO is server-only").
 */
class ServerOnlyProbeDO extends DurableObjectBase {
  static override eventIntake = [
    {
      topicPrefix: "vcs:",
      principals: ["code"],
      effect: { kind: "runtime-intrinsic" },
      tier: "open",
      sensitivity: "write",
    },
  ] as const;

  protected createTables(): void {}

  @rpc({
    principals: ["host", "user", "code"],
    effect: { kind: "runtime-intrinsic" },
    tier: "open",
    sensitivity: "read",
  })
  echo(...args: unknown[]): unknown[] {
    return args;
  }

  protected override assertInboundAllowed(
    caller: AuthenticatedCaller | null,
    kind: "call" | "event"
  ): void {
    if (kind === "event") return; // deliveries are opt-in — accept any publisher
    if (caller?.callerKind !== "server") {
      throw new Error(
        `probe: server-only; refusing caller kind ${caller?.callerKind ?? "unknown"}`
      );
    }
  }
}

function post(instance: unknown, path: string, body: unknown): Promise<Response> {
  const fetchable = instance as { fetch(request: Request): Promise<Response> };
  return fetchable.fetch(
    new Request(`http://test/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

describe("assertInboundAllowed path distinction", () => {
  it("refuses a non-server METHOD CALL (call path)", async () => {
    const { instance } = await createTestDO(ServerOnlyProbeDO);
    const res = await post(instance, "test-key/echo", {
      args: ["hi"],
      __instanceToken: "token",
      __instanceId: "do:internal/WorkspaceDO:test-key",
      __caller: {
        callerId: "do:other",
        callerKind: "do",
        authorization: createTestDirectAuthority({ callerKind: "do", method: "echo" }),
      },
    });
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("server-only"),
    });
  });

  it("allows a server METHOD CALL (call path)", async () => {
    const { instance } = await createTestDO(ServerOnlyProbeDO);
    const res = await post(instance, "test-key/echo", {
      args: ["hi"],
      __instanceToken: "token",
      __instanceId: "do:internal/WorkspaceDO:test-key",
      __caller: {
        callerId: "main",
        callerKind: "server",
        authorization: createTestDirectAuthority({ callerKind: "server", method: "echo" }),
      },
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(["hi"]);
  });

  it("accepts an EVENT delivery from a non-server caller (event path)", async () => {
    const { instance } = await createTestDO(ServerOnlyProbeDO);
    // An event envelope (message.type != request) POSTed to __rpc by a channel DO.
    const envelope = {
      message: { type: "event", event: "vcs:publication", payload: { ok: true } },
      delivery: {
        caller: {
          callerId: "do:workers/pubsub-channel:PubSubChannel:c",
          callerKind: "do",
          authorization: createTestDirectAuthority({
            callerKind: "do",
            method: "__event:vcs:publication",
          }),
        },
      },
    };
    const res = await post(instance, "test-key/__rpc", envelope);
    // The guard must NOT reject it — delivery returns 200 (no listener is fine).
    expect(res.status).toBe(200);

    const replay = await post(instance, "test-key/__rpc", envelope);
    expect(replay.status).toBe(403);
    await expect(replay.json()).resolves.toMatchObject({
      errorCode: "EACCES",
      errorKind: "access",
      error: expect.stringMatching(/replayed/),
      errorData: {
        authorityFailure: {
          reasonCode: "attestation-invalid",
          remediation: { kind: "retry-through-host" },
        },
      },
    });
  });

  it("returns a structured denial for a replayed METHOD CALL", async () => {
    const { instance } = await createTestDO(ServerOnlyProbeDO);
    const body = {
      args: ["hi"],
      __instanceToken: "token",
      __instanceId: "do:internal/WorkspaceDO:test-key",
      __caller: {
        callerId: "main",
        callerKind: "server",
        authorization: createTestDirectAuthority({ callerKind: "server", method: "echo" }),
      },
    };

    expect((await post(instance, "test-key/echo", body)).status).toBe(200);
    const replay = await post(instance, "test-key/echo", body);
    expect(replay.status).toBe(500);
    await expect(replay.json()).resolves.toMatchObject({
      errorCode: "EACCES",
      errorKind: "access",
      error: expect.stringMatching(/replayed/),
      errorData: {
        authorityFailure: {
          reasonCode: "attestation-invalid",
          remediation: { kind: "retry-through-host" },
        },
      },
    });
  });
});
