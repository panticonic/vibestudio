import { describe, expect, it, vi } from "vitest";
import {
  collectExposableMethods,
  rpc,
  rpcExposedMethodNames,
  rpcMethodAuthority,
} from "./connectionless.js";
import { createInternalConnectionlessRpcClient } from "./internal.js";
import type { RpcEnvelope } from "./types.js";

const SELF = "do:test:EvalDO:obj1";

function caller() {
  return { callerId: "main", callerKind: "server" as const };
}

function responseEnvelope(requestId: string, body: Record<string, unknown>): RpcEnvelope {
  return {
    from: "main",
    target: SELF,
    delivery: { caller: caller() },
    provenance: [caller()],
    message: { type: "response", requestId, ...body } as never,
  };
}

function requestEnvelope(method: string, args: unknown[], requestId = "q1"): RpcEnvelope {
  return {
    from: "main",
    target: SELF,
    delivery: { caller: caller() },
    provenance: [caller()],
    message: { type: "request", requestId, fromId: "main", method, args },
  };
}

function makeClient(fetchImpl: typeof fetch, authorityParentNonce?: () => string | undefined) {
  return createInternalConnectionlessRpcClient({
    selfId: SELF,
    serverUrl: "http://gw.test",
    authToken: "T",
    callerKind: "do",
    fetch: fetchImpl,
    ...(authorityParentNonce ? { authorityParentNonce } : {}),
  });
}

describe("createConnectionlessRpcClient", () => {
  it("carries the current invocation authority parent on unary and streaming calls", async () => {
    const seen: RpcEnvelope[] = [];
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const envelope = JSON.parse(String(init?.body)) as RpcEnvelope;
      seen.push(envelope);
      const requestId = (envelope.message as { requestId: string }).requestId;
      if (String(_url).endsWith("/rpc/stream")) throw new Error("stop after capture");
      return new Response(JSON.stringify(responseEnvelope(requestId, { result: "ok" })), {
        status: 200,
      });
    });
    let nonce = "host-invocation-parent-1";
    const { client } = makeClient(fetchMock as unknown as typeof fetch, () => nonce);

    await expect(client.call("main", "x.y", [])).resolves.toBe("ok");
    nonce = "host-invocation-parent-2";
    await expect(client.stream("main", "x.y", [])).rejects.toThrow("stop after capture");

    expect(
      seen.map(
        (envelope) => (envelope.message as { authorityParentNonce?: string }).authorityParentNonce
      )
    ).toEqual(["host-invocation-parent-1", "host-invocation-parent-2"]);
  });

  describe("respond (inbound request → response envelope, no POST)", () => {
    it("dispatches an exposed method and captures the response synchronously", async () => {
      const fetchMock = vi.fn();
      const { client, respond } = makeClient(fetchMock as unknown as typeof fetch);
      client.expose("ping", (req) => `pong-${(req.args as unknown[])[0]}`);

      const response = await respond(requestEnvelope("ping", ["x"]));
      expect(response).not.toBeNull();
      expect(response!.message).toMatchObject({
        type: "response",
        requestId: "q1",
        result: "pong-x",
      });
      // The response was captured locally — never POSTed.
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("returns an error response for an unexposed method", async () => {
      const { client: _client, respond } = makeClient(vi.fn() as unknown as typeof fetch);
      const response = await respond(requestEnvelope("nope", []));
      expect(response!.message).toMatchObject({ type: "response" });
      expect((response!.message as { error?: string }).error).toMatch(/not exposed/);
    });
  });

  describe("deliver (inbound event → rpc.on listener)", () => {
    it("fires a matching event listener with no response", async () => {
      const { client, deliver } = makeClient(vi.fn() as unknown as typeof fetch);
      const seen: unknown[] = [];
      client.on("vcs:publication", (ev) => seen.push(ev.payload));
      deliver({
        from: "main",
        target: SELF,
        delivery: { caller: caller() },
        provenance: [caller()],
        message: {
          type: "event",
          fromId: "main",
          event: "vcs:publication",
          payload: { publicationId: "p2" },
        },
      });
      expect(seen).toEqual([{ publicationId: "p2" }]);
    });
  });
});

// A framework base whose plumbing must NEVER be reachable, an intermediate base, and a concrete DO.
// Only `@rpc`-marked methods are exposed (opt-in / default-deny) — including INHERITED decorated
// ones; ungated/private helpers and framework plumbing are unreachable.
class FrameworkBase {
  async dispatchInboundEnvelope(_env: unknown) {
    return "FRAMEWORK_REDISPATCH"; // re-dispatches under caller-supplied identity — must stay hidden
  }
  getStateValue(_key: string) {
    return "internal-state";
  }
}
class IntermediateBase extends FrameworkBase {
  @rpc({
    effect: { kind: "runtime-intrinsic" },
    tier: "open",
    principals: ["code"],
    sensitivity: "write",
  })
  async chatOp(_op: string) {
    return "ok"; // decorated on an intermediate base → still exposed on the concrete DO
  }
}
class ConcreteDO extends IntermediateBase {
  @rpc({
    effect: { kind: "runtime-intrinsic" },
    tier: "open",
    principals: ["code"],
    sensitivity: "write",
  })
  async run(x: number) {
    return x + 1;
  }
  // NOT @rpc — an ungated app helper (like appendDurable/callGad): must be unreachable over RPC.
  async appendDurable(_input: unknown) {
    return "ungated-internal";
  }
}

describe("@rpc opt-in exposure (default-deny, enforced)", () => {
  it("rpcExposedMethodNames collects own + inherited @rpc methods on the concrete class", () => {
    expect([...rpcExposedMethodNames(new ConcreteDO())].sort()).toEqual(["chatOp", "run"]);
  });

  it("collectExposableMethods exposes ONLY @rpc methods — not ungated helpers or framework plumbing", () => {
    const exposed = collectExposableMethods(
      new ConcreteDO(),
      rpcExposedMethodNames(new ConcreteDO()),
      FrameworkBase.prototype
    );
    expect(Object.keys(exposed).sort()).toEqual(["chatOp", "run"]);
    expect(exposed).not.toHaveProperty("appendDurable"); // ungated helper — unreachable
    expect(exposed).not.toHaveProperty("dispatchInboundEnvelope");
    expect(exposed).not.toHaveProperty("getStateValue");
  });

  it("rejects over-the-relay calls to undecorated methods (forgery vector AND ungated helpers closed)", async () => {
    const { client, respond } = makeClient(vi.fn() as unknown as typeof fetch);
    client.exposeAll(
      collectExposableMethods(
        new ConcreteDO(),
        rpcExposedMethodNames(new ConcreteDO()),
        FrameworkBase.prototype
      )
    );
    const ok = await respond(requestEnvelope("run", [41]));
    expect((ok!.message as { result?: unknown }).result).toBe(42);
    for (const method of ["appendDurable", "dispatchInboundEnvelope"]) {
      const denied = await respond(requestEnvelope(method, [{ forged: true }]));
      expect((denied!.message as { error?: string }).error).toMatch(/not exposed/);
    }
  });
});

// Direct authority declarations register both exposure and their compositional requirement.
class PolicyBase {
  @rpc({
    principals: ["host"],
    effect: { kind: "runtime-intrinsic" },
    tier: "open",
    sensitivity: "write",
  })
  async serverOnly() {
    return "s"; // decorated on a base → policy lands on the concrete class too
  }
}
class PolicyDO extends PolicyBase {
  @rpc({
    principals: ["user", "code"],
    effect: { kind: "runtime-intrinsic" },
    tier: "open",
    sensitivity: "read",
  })
  async broad() {
    return "b";
  }
}

describe("@rpc direct authority declaration", () => {
  it("returns the complete declaration for own and inherited methods", () => {
    const inst = new PolicyDO();
    expect(rpcMethodAuthority(inst, "broad")).toEqual({
      principals: ["user", "code"],
      effect: { kind: "runtime-intrinsic" },
      tier: "open",
      sensitivity: "read",
    });
    expect(rpcMethodAuthority(inst, "serverOnly")).toEqual({
      principals: ["host"],
      effect: { kind: "runtime-intrinsic" },
      tier: "open",
      sensitivity: "write",
    });
  });

  it("the factory form still registers exposure", () => {
    expect([...rpcExposedMethodNames(new PolicyDO())].sort()).toEqual(["broad", "serverOnly"]);
  });
});
