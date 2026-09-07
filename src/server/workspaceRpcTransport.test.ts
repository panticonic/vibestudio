import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { responseEnvelopeFor, type RpcEnvelope } from "@vibestudio/rpc";
import { encodeLengthPrefix, MAX_ENVELOPE_FRAME_BYTES } from "@vibestudio/iroh-transport";
import { createWorkspaceChildHubPort } from "./workspaceChildHubPort.js";
import { receiveHubWorkspaceRpcHttp } from "./workspaceRpcHubTransport.js";
import {
  receiveWorkspaceRpcHttp,
  type WorkspaceRpcDelivery,
  type WorkspaceRpcInvocation,
} from "./workspaceRpcTransport.js";

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        })
    )
  );
});
async function listen(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function invocation(type: "request" | "stream-request" = "request"): WorkspaceRpcInvocation {
  const caller = {
    workspaceId: "source",
    runtime: { kind: "panel" as const, id: "panel:123" },
    subject: { userId: "alice", handle: "alice" },
  };
  return {
    caller,
    authorizingCaller: caller,
    contextIntegrity: null,
    operation: "calendar.slots",
    purpose: "call",
    envelope: {
      from: "panel:123",
      target: "do:workers/calendar:Calendar:context-object",
      destination: { kind: "workspace", workspaceId: "destination" },
      delivery: {
        caller: {
          callerId: "panel:123",
          callerKind: "panel",
          workspaceId: "source",
          userId: "alice",
        },
      },
      provenance: [],
      message: {
        type,
        requestId: "request-one",
        fromId: "panel:123",
        method: "calendar.slots",
        args: [{ contextId: "ctx_feature" }],
      },
    },
  };
}
function reply(input: WorkspaceRpcInvocation, message: RpcEnvelope["message"]): RpcEnvelope {
  return responseEnvelopeFor(
    input.envelope,
    {
      callerId: input.envelope.target,
      callerKind: "do",
      workspaceId: "destination",
      userId: "alice",
    },
    message
  );
}
async function fixture(dispatch: (delivery: WorkspaceRpcDelivery) => Promise<void>) {
  let sourceLive = true;
  let destinationLive = true;
  let permitted = true;
  const deny = () => {
    throw Object.assign(new Error("denied"), { code: "EACCES" });
  };
  const receiver = vi.fn(dispatch);
  const destination = await listen((req, res) => {
    void receiveWorkspaceRpcHttp(req, res, {
      authenticate() {
        if (req.headers.authorization !== "Bearer destination-secret") deny();
      },
      assertLive(input) {
        if (
          !destinationLive ||
          input.envelope.destination?.kind !== "workspace" ||
          input.envelope.destination.workspaceId !== "destination"
        )
          deny();
      },
      dispatch: receiver,
    });
  });
  const resolveDestination = vi.fn(async (workspaceId: string) => {
    if (workspaceId !== "destination") deny();
    return {
      url: `${destination}/_r/s/internal/workspace-rpc`,
      runtimeToken: "destination-secret",
      assertLive() {
        if (!destinationLive) deny();
      },
    };
  });
  const authenticated = deferred();
  const assertAccess = vi.fn(() => {
    if (!permitted) deny();
  });
  const hub = await listen((req, res) => {
    void receiveHubWorkspaceRpcHttp(req, res, {
      authenticateSource() {
        if (!sourceLive || req.headers.authorization !== "Bearer source-secret") deny();
        authenticated.resolve();
        return "source";
      },
      assertAccess,
      resolveDestination,
    });
  });
  return {
    port: createWorkspaceChildHubPort({ hubUrl: hub, runtimeToken: "source-secret" }),
    hub,
    authenticated: authenticated.promise,
    receiver,
    resolveDestination,
    assertAccess,
    revokeSource: () => {
      sourceLive = false;
    },
    restartDestination: () => {
      destinationLive = false;
    },
    denyPolicy: () => {
      permitted = false;
    },
  };
}

describe("host-to-host workspace RPC transport", () => {
  it("preserves target/context selectors, provenance facts and structured application failures", async () => {
    const input = invocation();
    const result = reply(input, {
      type: "response",
      requestId: "request-one",
      error: "Conflict",
      errorCode: "ECONFLICT",
      errorKind: "application",
      errorData: { current: 7 },
    });
    const f = await fixture(async (delivery) => {
      expect(delivery.invocation).toEqual(input);
      expect(delivery.body).toBeUndefined();
      await delivery.send(result);
    });
    const received: RpcEnvelope[] = [];
    await f.port.forwardWorkspaceRpc(input, {
      onEnvelope: (envelope) => {
        received.push(envelope);
      },
    });
    expect(received).toEqual([result]);
    expect(f.resolveDestination).toHaveBeenCalledWith("destination");
  });

  it("streams uploads and replies before upload completion with unchanged full-envelope frames", async () => {
    const input = invocation("stream-request");
    const firstReceived = deferred();
    const secondUpload = deferred();
    const f = await fixture(async (delivery) => {
      const reader = delivery.body!.getReader();
      let count = 0;
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        count += next.value.byteLength;
        await delivery.send(
          reply(input, {
            type: "stream-frame",
            requestId: "request-one",
            fromId: input.envelope.target,
            frameType: 2,
            payload: Buffer.from(next.value).toString("base64"),
          })
        );
      }
      await delivery.send(
        reply(input, {
          type: "stream-frame",
          requestId: "request-one",
          fromId: input.envelope.target,
          frameType: 3,
          payload: JSON.stringify({ bytesIn: count }),
        })
      );
    });
    let pull = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (pull++ === 0) controller.enqueue(new Uint8Array([1, 2, 3]));
        else {
          await secondUpload.promise;
          controller.enqueue(new Uint8Array([4, 5]));
          controller.close();
        }
      },
    });
    const frames: RpcEnvelope[] = [];
    const run = f.port.forwardWorkspaceRpc(input, {
      body,
      onEnvelope(frame) {
        frames.push(frame);
        firstReceived.resolve();
      },
    });
    await firstReceived.promise;
    expect(frames[0]?.message).toMatchObject({ frameType: 2, payload: "AQID" });
    secondUpload.resolve();
    await run;
    expect(frames.map((frame) => frame.message)).toEqual([
      expect.objectContaining({ frameType: 2, payload: "AQID" }),
      expect.objectContaining({ frameType: 2, payload: "BAU=" }),
      expect.objectContaining({ frameType: 3, payload: '{"bytesIn":5}' }),
    ]);
  });

  it("keeps a bodyless stream request bodyless at the receiver", async () => {
    const input = invocation("stream-request");
    const f = await fixture(async (delivery) => {
      expect(delivery.body).toBeUndefined();
      await delivery.send(
        reply(input, {
          type: "stream-frame",
          requestId: "request-one",
          fromId: input.envelope.target,
          frameType: 3,
          payload: '{"bytesIn":0}',
        })
      );
    });
    await f.port.forwardWorkspaceRpc(input, { onEnvelope() {} });
  });

  it.each(["request-cancel", "stream-cancel"] as const)(
    "preserves %s and its admitted original operation",
    async (type) => {
      const input = invocation();
      input.envelope.message = { type, requestId: "request-one", fromId: "panel:123" };
      const f = await fixture(async (delivery) => {
        expect(delivery.invocation).toEqual(input);
        expect(delivery.body).toBeUndefined();
      });
      await f.port.forwardWorkspaceRpc(input, {
        onEnvelope() {
          throw new Error("unexpected reply");
        },
      });
      expect(f.receiver).toHaveBeenCalledOnce();
    }
  );

  it("cancels the exact receiver lifetime when the source aborts", async () => {
    const input = invocation("stream-request");
    const cancelled = deferred();
    const f = await fixture(async (delivery) => {
      delivery.signal.addEventListener("abort", () => cancelled.resolve(), { once: true });
      await delivery.send(
        reply(input, {
          type: "stream-frame",
          requestId: "request-one",
          fromId: input.envelope.target,
          frameType: 1,
          payload: "{}",
        })
      );
      await cancelled.promise;
    });
    const controller = new AbortController();
    await expect(
      f.port.forwardWorkspaceRpc(input, {
        signal: controller.signal,
        onEnvelope() {
          controller.abort();
        },
      })
    ).rejects.toThrow();
    await cancelled.promise;
  });

  it.each(["revokeSource", "restartDestination", "denyPolicy"] as const)(
    "stops subsequent disclosure after %s",
    async (change) => {
      const input = invocation("stream-request");
      const proceed = deferred();
      const f = await fixture(async (delivery) => {
        await delivery.send(
          reply(input, {
            type: "event",
            fromId: input.envelope.target,
            event: "calendar.change",
            payload: 1,
          })
        );
        await proceed.promise;
        await delivery.send(
          reply(input, {
            type: "event",
            fromId: input.envelope.target,
            event: "calendar.change",
            payload: 2,
          })
        );
      });
      const received: RpcEnvelope[] = [];
      await expect(
        f.port.forwardWorkspaceRpc(input, {
          onEnvelope(envelope) {
            received.push(envelope);
            f[change]();
            proceed.resolve();
          },
        })
      ).rejects.toThrow();
      expect(received).toHaveLength(1);
    }
  );

  it("rejects forged source attribution and changed initiating users before resolving a destination", async () => {
    const f = await fixture(async () => {
      throw new Error("must not dispatch");
    });
    for (const mutate of [
      (input: WorkspaceRpcInvocation) => {
        input.caller.workspaceId = "victim";
        input.envelope.delivery.caller.workspaceId = "victim";
      },
      (input: WorkspaceRpcInvocation) => {
        input.authorizingCaller = { ...input.caller, subject: { userId: "bob", handle: "bob" } };
      },
      (input: WorkspaceRpcInvocation) => {
        input.envelope.delivery.caller.userId = "bob";
      },
      (input: WorkspaceRpcInvocation) => {
        input.operation = "other.method";
      },
    ]) {
      const input = invocation();
      mutate(input);
      const payload = Buffer.from(JSON.stringify({ invocation: input, body: false }));
      const response = await fetch(`${f.hub}/_r/s/internal/workspace-rpc`, {
        method: "POST",
        headers: { Authorization: "Bearer source-secret" },
        body: Buffer.concat([encodeLengthPrefix(payload.byteLength), payload]),
      });
      expect(response.status).toBe(403);
    }
    expect(f.resolveDestination).not.toHaveBeenCalled();
    expect(f.receiver).not.toHaveBeenCalled();
  });

  it("rejects missing host authentication before destination discovery", async () => {
    const f = await fixture(async () => {});
    const response = await fetch(`${f.hub}/_r/s/internal/workspace-rpc`, {
      method: "POST",
      body: "untrusted code",
    });
    expect(response.status).toBe(403);
    expect(f.resolveDestination).not.toHaveBeenCalled();
  });

  it("rechecks the exact child token after a delayed invocation frame", async () => {
    const f = await fixture(async () => {});
    const payload = Buffer.from(JSON.stringify({ invocation: invocation(), body: false }));
    const tail = deferred();
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(encodeLengthPrefix(payload.length));
        } else {
          await tail.promise;
          controller.enqueue(payload);
          controller.close();
        }
      },
    });
    const response = fetch(`${f.hub}/_r/s/internal/workspace-rpc`, {
      method: "POST",
      headers: { Authorization: "Bearer source-secret" },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    await f.authenticated;
    f.revokeSource();
    tail.resolve();
    expect((await response).status).toBe(403);
    expect(f.resolveDestination).not.toHaveBeenCalled();
  });

  it("rejects oversized frames without reading or allocating their declared payload", async () => {
    const f = await fixture(async () => {});
    const response = await fetch(`${f.hub}/_r/s/internal/workspace-rpc`, {
      method: "POST",
      headers: { Authorization: "Bearer source-secret" },
      body: Buffer.from(encodeLengthPrefix(MAX_ENVELOPE_FRAME_BYTES + 1)),
    });
    expect(response.status).toBe(400);
    expect(f.resolveDestination).not.toHaveBeenCalled();
  });

  it("closes receiver work when the source delivery callback fails", async () => {
    const input = invocation("stream-request");
    const cancelled = deferred();
    const f = await fixture(async (delivery) => {
      delivery.signal.addEventListener("abort", cancelled.resolve, { once: true });
      await delivery.send(
        reply(input, { type: "event", fromId: input.envelope.target, event: "change", payload: 1 })
      );
      await cancelled.promise;
    });
    await expect(
      f.port.forwardWorkspaceRpc(input, {
        onEnvelope() {
          throw new Error("source retired");
        },
      })
    ).rejects.toThrow("source retired");
    await cancelled.promise;
  });

  it("does not turn a reply channel into a reverse RPC permission", async () => {
    const input = invocation();
    const f = await fixture(async (delivery) => {
      await delivery.send(
        reply(input, {
          type: "request",
          requestId: "new-call",
          fromId: "main",
          method: "credentials.list",
          args: [],
        })
      );
    });
    const onEnvelope = vi.fn();
    await expect(f.port.forwardWorkspaceRpc(input, { onEnvelope })).rejects.toThrow();
    expect(onEnvelope).not.toHaveBeenCalled();
  });

  it("retains authorizing origin across a host-attested hop", async () => {
    const input = invocation();
    input.authorizingCaller = { ...input.caller, workspaceId: "original-workspace" };
    const f = await fixture(async (delivery) => {
      expect(delivery.invocation.authorizingCaller.workspaceId).toBe("original-workspace");
      await delivery.send(
        reply(input, { type: "response", requestId: "request-one", result: true })
      );
    });
    await f.port.forwardWorkspaceRpc(input, { onEnvelope() {} });
  });
});
