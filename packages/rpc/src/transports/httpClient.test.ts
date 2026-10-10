import { serializeRpcFailure, RemoteRpcAggregateError } from "../errors.js";
import { describe, expect, it, vi } from "vitest";
import { envelopeFromMessage, responseEnvelopeFor } from "../envelope.js";
import { httpClientTransport } from "./httpClient.js";
import type { RpcEnvelope } from "../types.js";

function requestEnvelope(): RpcEnvelope {
  return envelopeFromMessage({
    selfId: "worker:agent",
    from: "worker:agent",
    target: "main",
    callerKind: "worker",
    message: {
      type: "request",
      requestId: "req-1",
      fromId: "worker:agent",
      method: "ping",
      args: [],
    },
  });
}

describe("httpClientTransport", () => {
  it("binds unary cancellation to the original HTTP request without retrying it", async () => {
    let observedSignal: AbortSignal | null = null;
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        observedSignal = init?.signal ?? null;
        return await new Promise<Response>((_resolve, reject) => {
          observedSignal?.addEventListener("abort", () => reject(observedSignal?.reason), {
            once: true,
          });
        });
      }
    ) as unknown as typeof fetch;
    const transport = httpClientTransport({
      selfId: "worker:agent",
      serverUrl: "http://127.0.0.1:65530",
      authToken: "token",
      fetch: fetchMock,
    });
    const controller = new AbortController();
    const pending = transport.send(requestEnvelope(), controller.signal);
    const reason = new Error("caller released activation");

    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(observedSignal).toBe(controller.signal);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the admitted HTTP request owned through its terminal response body", async () => {
    let releaseBody!: () => void;
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        releaseBody = () => {
          value.enqueue(
            new TextEncoder().encode(
              JSON.stringify(
                responseEnvelopeFor(
                  requestEnvelope(),
                  { callerId: "main", callerKind: "server" },
                  { type: "response", requestId: "req-1", result: "done" }
                )
              )
            )
          );
          value.close();
        };
      },
    });
    const fetchMock = vi.fn(
      async () => new Response(body, { status: 200 })
    ) as unknown as typeof fetch;
    const transport = httpClientTransport({
      selfId: "worker:agent",
      serverUrl: "http://127.0.0.1:65530",
      authToken: "token",
      fetch: fetchMock,
    });
    let terminal: RpcEnvelope | undefined;
    transport.onMessage((envelope) => {
      terminal = envelope;
    });

    let settled = false;
    const pending = transport.send(requestEnvelope()).then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    expect(terminal).toBeUndefined();

    releaseBody();
    await pending;
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(terminal?.message).toMatchObject({ result: "done" });
  });

  it("orders cancellation behind the original HTTP admission receipt", async () => {
    let admit!: (response: Response) => void;
    const admission = new Promise<Response>((resolve) => {
      admit = resolve;
    });
    const postedTypes: string[] = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const message = JSON.parse(String(init?.body)).message as { type: string };
      postedTypes.push(message.type);
      if (message.type === "request") return admission;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const transport = httpClientTransport({
      selfId: "worker:agent",
      serverUrl: "http://127.0.0.1:65530",
      authToken: "token",
      fetch: fetchMock,
    });

    const sending = transport.send(requestEnvelope());
    await vi.waitFor(() => expect(postedTypes).toEqual(["request"]));
    const cancelled = transport.send({
      ...requestEnvelope(),
      message: { type: "request-cancel", requestId: "req-1", fromId: "worker:agent" },
    });
    await Promise.resolve();
    expect(postedTypes).toEqual(["request"]);

    admit(new Response("{}", { status: 200 }));
    await sending;
    await cancelled;
    expect(postedTypes).toEqual(["request", "request-cancel"]);
  });

  it("treats an already-terminal request cancellation as an authoritative no-op", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const message = JSON.parse(String(init?.body)).message as { type: string };
      if (message.type === "request") return new Response("{}", { status: 200 });
      return new Response(JSON.stringify({ error: "RPC request is not active" }), {
        status: 409,
      });
    }) as unknown as typeof fetch;
    const transport = httpClientTransport({
      selfId: "worker:agent",
      serverUrl: "http://127.0.0.1:65530",
      authToken: "token",
      fetch: fetchMock,
    });

    await transport.send(requestEnvelope());
    await expect(
      transport.send({
        ...requestEnvelope(),
        message: { type: "request-cancel", requestId: "req-1", fromId: "worker:agent" },
      })
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("annotates fetch failures with the RPC endpoint and low-level cause", async () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:65530"), {
      code: "ECONNREFUSED",
      syscall: "connect",
      address: "127.0.0.1",
      port: 65530,
    });
    const fetchError = Object.assign(new TypeError("fetch failed"), { cause });
    const fetchMock = vi.fn(async () => {
      throw fetchError;
    }) as unknown as typeof fetch;
    const transport = httpClientTransport({
      selfId: "worker:agent",
      serverUrl: "http://127.0.0.1:65530",
      authToken: "token",
      fetch: fetchMock,
    });

    await expect(transport.send(requestEnvelope())).rejects.toThrow(
      /RPC fetch to http:\/\/127\.0\.0\.1:65530\/rpc failed: fetch failed \(cause: Error: connect ECONNREFUSED 127\.0\.0\.1:65530 code=ECONNREFUSED syscall=connect address=127\.0\.0\.1 port=65530\)/
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retains an inbound invocation until its actual terminal response arrives", async () => {
    const fetchMock = vi.fn(async () => new Response("{}")) as unknown as typeof fetch;
    const transport = httpClientTransport({
      selfId: "do:approval:Waiter:key",
      serverUrl: "http://127.0.0.1:65530",
      authToken: "token",
      fetch: fetchMock,
    });
    const inbound = requestEnvelope();
    let settled = false;
    const completion = transport.respond(inbound).completion.then((response) => {
      settled = true;
      return response;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();

    await transport.send(
      responseEnvelopeFor(
        inbound,
        { callerId: "do:approval:Waiter:key", callerKind: "do" },
        { type: "response", requestId: "req-1", result: "completed" }
      )
    );
    await expect(completion).resolves.toMatchObject({
      message: { type: "response", requestId: "req-1", result: "completed" },
    });
    expect(settled).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

it("propagates an HTTP event failure graph to the emitting caller", async () => {
  const original = new Error("event handler failed");
  const transport = httpClientTransport({
    serverUrl: "http://localhost",
    authToken: "test",
    selfId: "worker:agent",
    fetch: async () =>
      new Response(
        JSON.stringify({
          error: serializeRpcFailure(
            new AggregateError([original, new Error("event cleanup failed")], "event failed", {
              cause: original,
            })
          ),
        })
      ),
  });
  const envelope = envelopeFromMessage({
    selfId: "worker:agent",
    from: "worker:agent",
    target: "main",
    callerKind: "worker",
    message: { type: "event", fromId: "worker:agent", event: "changed", payload: {} },
  });
  const failure = await transport.send(envelope).catch((error) => error);
  expect(failure).toBeInstanceOf(RemoteRpcAggregateError);
  expect(failure.errors.map((error: Error) => error.message)).toEqual([
    "event handler failed",
    "event cleanup failed",
  ]);
  expect(failure.cause).toBe(failure.errors[0]);
});
