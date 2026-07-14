import { describe, expect, it } from "vitest";
import { DurableObjectBase, rpc } from "./index.js";
import { createTestDirectAuthority, createTestDO } from "./test-utils.js";

/**
 * Product-seed DOs use the same exact-target authority contract as ordinary
 * Workspace DOs. Runtime shape is irrelevant; opt-in event deliveries remain
 * outside the method-call capability surface.
 */
class ServerOnlyProbeDO extends DurableObjectBase {
  protected createTables(): void {}

  @rpc({ principals: ["host"] })
  echo(...args: unknown[]): unknown[] {
    return args;
  }
}

function post(
  instance: unknown,
  path: string,
  body: unknown
): Promise<Response> {
  const fetchable = instance as { fetch(request: Request): Promise<Response> };
  return fetchable.fetch(
    new Request(`http://test/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

describe("product-seed direct authority", () => {
  it("refuses a method call without host mediation regardless of caller kind", async () => {
    const { instance } = await createTestDO(ServerOnlyProbeDO);
    const res = await post(instance, "test-key/echo", {
      args: ["hi"],
      __instanceToken: "token",
      __instanceId: "do:internal/WorkspaceDO:test-key",
      __caller: { callerId: "do:other", callerKind: "do" },
    });
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("authority attestation"),
    });
  });

  it("allows an oddly-shaped caller carrying exact host authority", async () => {
    const { instance } = await createTestDO(ServerOnlyProbeDO);
    const res = await post(instance, "test-key/echo", {
      args: ["hi"],
      __instanceToken: "token",
      __instanceId: "do:internal/WorkspaceDO:test-key",
      __caller: {
        callerId: "do:odd-shape",
        callerKind: "do",
        authorization: createTestDirectAuthority({
          source: "test",
          className: "TestDO",
          objectKey: "test-key",
          method: "echo",
        }),
      },
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(["hi"]);
  });

  it("accepts an opt-in event delivery without a method capability", async () => {
    const { instance } = await createTestDO(ServerOnlyProbeDO);
    // An event envelope (message.type != request) POSTed to __rpc by a channel DO.
    const res = await post(instance, "test-key/__rpc", {
      message: { type: "event", event: "vcs:head:main", payload: { ok: true } },
      delivery: { caller: { callerId: "do:workers/pubsub-channel:PubSubChannel:c", callerKind: "do" } },
    });
    // The guard must NOT reject it — delivery returns 200 (no listener is fine).
    expect(res.status).toBe(200);
  });
});
