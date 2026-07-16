import { envelopeFromMessage, type RpcEnvelope } from "@vibestudio/rpc";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  HttpRpcHandler,
  resolveRpcMaxBodyBytes,
  type HttpRpcHandlerDeps,
} from "./httpRpcHandler.js";

interface CapturedResponse {
  status: number | null;
  headers: unknown;
  body: string;
}

function request(options: { body?: string; method?: string; url?: string }): IncomingMessage {
  const req = Readable.from(options.body === undefined ? [] : [Buffer.from(options.body)]);
  return Object.assign(req, {
    method: options.method ?? "POST",
    url: options.url ?? "/rpc",
    headers: {},
  }) as IncomingMessage;
}

function response(): { res: ServerResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = { status: null, headers: null, body: "" };
  const res = {
    writeHead(status: number, headers?: unknown) {
      captured.status = status;
      captured.headers = headers;
      return this;
    },
    end(body?: string | Buffer) {
      captured.body = body === undefined ? "" : body.toString();
      return this;
    },
  } as unknown as ServerResponse;
  return { res, captured };
}

function rpcEnvelope(): RpcEnvelope {
  return envelopeFromMessage({
    selfId: "forged-caller",
    from: "forged-caller",
    target: "main",
    callerKind: "panel",
    message: {
      type: "request",
      requestId: "request-1",
      fromId: "forged-caller",
      method: "docs.listServices",
      args: [],
    },
  });
}

function deps(overrides: Partial<HttpRpcHandlerDeps> = {}): HttpRpcHandlerDeps {
  return {
    maxBodyBytes: 1024,
    authenticate: vi.fn(
      () =>
        ({
          ok: true,
          caller: { callerId: "worker:trusted", callerKind: "worker" },
        }) satisfies ReturnType<HttpRpcHandlerDeps["authenticate"]>
    ),
    handleStreamingRequest: vi.fn(async () => undefined),
    handleRequest: vi.fn(async () => ({ services: ["docs"] })),
    handleEvent: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("HttpRpcHandler", () => {
  it("routes streaming requests directly to the injected streaming collaborator", async () => {
    const configured = deps();
    const handler = new HttpRpcHandler(configured);
    const req = request({ url: "/rpc/stream" });
    const { res } = response();

    await handler.handle(req, res);

    expect(configured.handleStreamingRequest).toHaveBeenCalledWith(req, res);
    expect(configured.authenticate).not.toHaveBeenCalled();
  });

  it("rejects an oversized body before authentication or dispatch", async () => {
    const configured = deps({ maxBodyBytes: 4 });
    const handler = new HttpRpcHandler(configured);
    const { res, captured } = response();

    await handler.handle(request({ body: "12345" }), res);

    expect(captured.status).toBe(413);
    expect(JSON.parse(captured.body)).toEqual({
      error: "RPC body exceeds 4 bytes (set VIBESTUDIO_RPC_MAX_BODY_BYTES to raise)",
    });
    expect(configured.authenticate).not.toHaveBeenCalled();
    expect(configured.handleRequest).not.toHaveBeenCalled();
  });

  it("serializes admission failures without reaching the dispatch callback", async () => {
    const configured = deps({
      authenticate: () => ({
        ok: false,
        status: 403,
        body: { error: "Not a member", code: "EACCES" },
      }),
    });
    const handler = new HttpRpcHandler(configured);
    const { res, captured } = response();

    await handler.handle(request({ body: JSON.stringify(rpcEnvelope()) }), res);

    expect(captured.status).toBe(403);
    expect(JSON.parse(captured.body)).toEqual({ error: "Not a member", code: "EACCES" });
    expect(configured.handleRequest).not.toHaveBeenCalled();
  });

  it("encodes a void RPC result explicitly on the JSON wire", async () => {
    const configured = deps({ handleRequest: vi.fn(async () => undefined) });
    const handler = new HttpRpcHandler(configured);
    const { res, captured } = response();

    await handler.handle(request({ body: JSON.stringify(rpcEnvelope()) }), res);

    expect(captured.status).toBe(200);
    expect(JSON.parse(captured.body).message).toMatchObject({
      type: "response",
      requestId: "request-1",
      result: null,
    });
  });

  it("dispatches with the authenticated caller and emits a response envelope", async () => {
    const configured = deps();
    const handler = new HttpRpcHandler(configured);
    const envelope = rpcEnvelope();
    const { res, captured } = response();

    await handler.handle(request({ body: JSON.stringify(envelope) }), res);

    expect(configured.handleRequest).toHaveBeenCalledWith(
      { callerId: "worker:trusted", callerKind: "worker" },
      envelope,
      envelope.message
    );
    expect(captured.status).toBe(200);
    expect(JSON.parse(captured.body)).toMatchObject({
      message: {
        type: "response",
        requestId: "request-1",
        result: { services: ["docs"] },
      },
    });
  });
});

describe("resolveRpcMaxBodyBytes", () => {
  it("accepts finite non-negative overrides and falls back for invalid values", () => {
    expect(resolveRpcMaxBodyBytes("0")).toBe(0);
    expect(resolveRpcMaxBodyBytes("12.9")).toBe(12);
    expect(resolveRpcMaxBodyBytes("-1")).toBe(256 * 1024 * 1024);
    expect(resolveRpcMaxBodyBytes("invalid")).toBe(256 * 1024 * 1024);
  });
});
