import { describe, expect, it, vi } from "vitest";
import type { EnvelopeRpcTransport, RpcEnvelope } from "./types.js";
import { createRpcInitiatorTransport } from "./transport-helpers.js";

function envelope(type: RpcEnvelope["message"]["type"]): RpcEnvelope {
  const message =
    type === "request" || type === "stream-request"
      ? { type, requestId: `${type}-1`, fromId: "main", method: "probe", args: [] }
      : type === "response"
        ? { type, requestId: "response-1", result: "ok" }
        : { type: "event" as const, fromId: "main", event: "probe", payload: null };
  return {
    from: "main",
    target: "panel:nav-test",
    delivery: { caller: { callerId: "main", callerKind: "server" } },
    provenance: [{ callerId: "main", callerKind: "server" }],
    message,
  } as RpcEnvelope;
}

describe("createRpcInitiatorTransport", () => {
  it("forwards outbound envelopes and inbound replies without consuming endpoint requests", async () => {
    let inbound: ((envelope: RpcEnvelope) => void) | undefined;
    const send = vi.fn(async () => undefined);
    const source: EnvelopeRpcTransport = {
      send,
      onMessage: (handler) => {
        inbound = handler;
        return () => undefined;
      },
    };
    const transport = createRpcInitiatorTransport(source);
    const received: RpcEnvelope[] = [];
    transport.onMessage((next) => received.push(next));
    const outbound = envelope("event");

    await transport.send(outbound);
    inbound?.(envelope("request"));
    inbound?.(envelope("stream-request"));
    const response = envelope("response");
    inbound?.(response);

    expect(send).toHaveBeenCalledWith(outbound, undefined);
    expect(received).toEqual([response]);
  });
});
