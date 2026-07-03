import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { startPanelAssetFacade } from "./panelAssetFacade.js";
import type { ServerClient } from "./serverClient.js";

type GatewayStream = (service: string, method: string, args: unknown[]) => Promise<Response>;

/** Minimal ServerClient stub — the façade only ever touches `.stream`. */
function fakeServerClient(stream: GatewayStream): ServerClient {
  return {
    call: async () => undefined,
    stream,
    callAs: async () => undefined,
    addMessageListener: () => () => {},
    isConnected: () => true,
    getConnectionStatus: () => "connected",
    close: async () => undefined,
  } as unknown as ServerClient;
}

interface CapturedDescriptor {
  path: string;
  method?: string;
  headers?: Record<string, string>;
  gzip?: boolean;
}

const tmpDirs: string[] = [];
function tempStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "panel-facade-test-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("startPanelAssetFacade", () => {
  it("streams the body, status, and forwarded headers from gateway.fetch", async () => {
    const body = "<!DOCTYPE html><html><body>shell panel</body></html>";

    let captured: CapturedDescriptor | undefined;
    const stream = vi.fn<GatewayStream>(async (_service, _method, args) => {
      captured = (args as [CapturedDescriptor])[0];
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "x-vibez1-build-revision": "7",
          // A stale hop header that must NOT be echoed (body is re-framed + re-sent).
          "content-encoding": "gzip",
        },
      });
    });

    const facade = await startPanelAssetFacade(fakeServerClient(stream));
    try {
      const res = await fetch(`http://127.0.0.1:${facade.port}/apps/shell/?contextId=ctx-1`, {
        headers: { authorization: "Bearer tkn-1", "x-not-forwarded": "1" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(res.headers.get("x-vibez1-build-revision")).toBe("7");
      // content-encoding stripped → the outer fetch reads plain bytes.
      expect(res.headers.get("content-encoding")).toBeNull();
      expect(await res.text()).toBe(body);
    } finally {
      await facade.close();
    }

    // Assert the forwarded descriptor outside the façade's try/catch so a failed
    // expectation surfaces directly instead of being masked as a 502.
    expect(stream).toHaveBeenCalledTimes(1);
    // 4th arg = stream options; GETs carry none (§1.6 — bodies only on non-GET/HEAD).
    expect(stream).toHaveBeenCalledWith("gateway", "fetch", expect.any(Array), undefined);
    expect(captured?.path).toBe("/apps/shell/?contextId=ctx-1");
    expect(captured?.method).toBe("GET");
    // Desktop now requests gzip on the wire (parity with mobile).
    expect(captured?.gzip).toBe(true);
    // Allowlisted request header forwarded; non-listed header dropped.
    expect(captured?.headers?.["authorization"]).toBe("Bearer tkn-1");
    expect(captured?.headers?.["x-not-forwarded"]).toBeUndefined();
  });

  it("streams a large body (multi-MB) without a size limit", async () => {
    // The whole point of streaming: a body far larger than any single-message
    // data-channel limit flows through chunked.
    const big = "x".repeat(5 * 1024 * 1024);
    const stream = vi.fn<GatewayStream>(async () => new Response(big, { status: 200 }));
    const facade = await startPanelAssetFacade(fakeServerClient(stream));
    try {
      const res = await fetch(`http://127.0.0.1:${facade.port}/apps/shell/bundle.js`);
      expect(res.status).toBe(200);
      expect((await res.text()).length).toBe(big.length);
    } finally {
      await facade.close();
    }
  });

  it("responds 403 to non-panel-reachable paths WITHOUT a pipe round-trip (mirror of the server allowlist)", async () => {
    const stream = vi.fn<GatewayStream>(async () => new Response("nope", { status: 200 }));
    const facade = await startPanelAssetFacade(fakeServerClient(stream));
    try {
      for (const blocked of ["/_r/s/auth/issue-device", "/rpc", "/rpc/stream", "/_w/do/x"]) {
        const res = await fetch(`http://127.0.0.1:${facade.port}${blocked}`, { method: "POST" });
        expect(res.status, blocked).toBe(403);
      }
      // Worker routes and app artifacts stay reachable.
      for (const allowed of ["/_r/w/workers/my-worker/hook", "/_a/build-key/index.html"]) {
        const res = await fetch(`http://127.0.0.1:${facade.port}${allowed}`);
        expect(res.status, allowed).toBe(200);
      }
    } finally {
      await facade.close();
    }
    expect(stream).toHaveBeenCalledTimes(2); // only the two allowed paths hit the pipe
  });

  it("responds 502 when the gateway.fetch stream rejects", async () => {
    const stream = vi.fn<GatewayStream>(async () => {
      throw new Error("pipe down");
    });

    const facade = await startPanelAssetFacade(fakeServerClient(stream));
    try {
      const res = await fetch(`http://127.0.0.1:${facade.port}/apps/shell/bundle.js`);
      expect(res.status).toBe(502);
      expect(await res.text()).toContain("Panel asset bridge error");
    } finally {
      await facade.close();
    }
  });
});

const IMMUTABLE = "public, max-age=31536000, immutable";

describe("panel asset façade content cache", () => {
  it("serves immutable assets from disk on the second request (zero pipe fetch)", async () => {
    const body = "export const x = 1;".repeat(100);
    const stream = vi.fn<GatewayStream>(
      async () =>
        new Response(body, {
          status: 200,
          headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": IMMUTABLE },
        })
    );
    const facade = await startPanelAssetFacade(fakeServerClient(stream), {
      stateDir: tempStateDir(),
    });
    try {
      const url = `http://127.0.0.1:${facade.port}/apps/shell/assets/app-abc123.js`;
      const r1 = await fetch(url);
      expect(await r1.text()).toBe(body);
      const r2 = await fetch(url);
      expect(await r2.text()).toBe(body);
      // Second request served from disk → only one pipe fetch total.
      expect(stream).toHaveBeenCalledTimes(1);
    } finally {
      await facade.close();
    }
  });

  it("varies immutable disk-cache entries by forwarded request headers", async () => {
    const stream = vi.fn<GatewayStream>(async (_service, _method, args) => {
      const descriptor = (args as [CapturedDescriptor])[0];
      const auth = descriptor.headers?.["authorization"] ?? "none";
      return new Response(`bundle for ${auth}`, {
        status: 200,
        headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": IMMUTABLE },
      });
    });
    const facade = await startPanelAssetFacade(fakeServerClient(stream), {
      stateDir: tempStateDir(),
    });
    try {
      const url = `http://127.0.0.1:${facade.port}/apps/shell/assets/app-abc123.js`;
      const a1 = await fetch(url, { headers: { authorization: "Bearer a" } });
      expect(await a1.text()).toBe("bundle for Bearer a");
      const b1 = await fetch(url, { headers: { authorization: "Bearer b" } });
      expect(await b1.text()).toBe("bundle for Bearer b");
      const a2 = await fetch(url, { headers: { authorization: "Bearer a" } });
      expect(await a2.text()).toBe("bundle for Bearer a");
      expect(stream).toHaveBeenCalledTimes(2);
    } finally {
      await facade.close();
    }
  });

  it("never caches no-store HTML (refetches every time)", async () => {
    const stream = vi.fn<GatewayStream>(
      async () =>
        new Response("<html>entry</html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        })
    );
    const facade = await startPanelAssetFacade(fakeServerClient(stream), {
      stateDir: tempStateDir(),
    });
    try {
      const url = `http://127.0.0.1:${facade.port}/apps/shell/?contextId=c1`;
      await (await fetch(url)).text();
      await (await fetch(url)).text();
      expect(stream).toHaveBeenCalledTimes(2);
    } finally {
      await facade.close();
    }
  });

  it("translates the gzip marker to Content-Encoding and caches the encoded body", async () => {
    const plain = "console.log('bundle');".repeat(50);
    const gz = zlib.gzipSync(Buffer.from(plain));
    const stream = vi.fn<GatewayStream>(
      async () =>
        new Response(gz, {
          status: 200,
          headers: {
            "content-type": "text/javascript; charset=utf-8",
            "cache-control": IMMUTABLE,
            "x-vibez1-content-gzip": "1",
          },
        })
    );
    const facade = await startPanelAssetFacade(fakeServerClient(stream), {
      stateDir: tempStateDir(),
    });
    try {
      const url = `http://127.0.0.1:${facade.port}/apps/shell/assets/gz-deadbeef.js`;
      // undici auto-inflates Content-Encoding: gzip → we read the original text.
      const r1 = await fetch(url);
      expect(r1.headers.get("content-encoding")).toBe("gzip");
      expect(await r1.text()).toBe(plain);
      const r2 = await fetch(url); // from disk
      expect(await r2.text()).toBe(plain);
      expect(stream).toHaveBeenCalledTimes(1);
    } finally {
      await facade.close();
    }
  });

  it("re-binds the same persisted loopback port across restarts", async () => {
    const stateDir = tempStateDir();
    const stream = vi.fn<GatewayStream>(async () => new Response("ok", { status: 200 }));

    const first = await startPanelAssetFacade(fakeServerClient(stream), { stateDir });
    const firstPort = first.port;
    await first.close();

    expect(fs.existsSync(path.join(stateDir, "port"))).toBe(true);
    expect(Number(fs.readFileSync(path.join(stateDir, "port"), "utf-8"))).toBe(firstPort);

    const second = await startPanelAssetFacade(fakeServerClient(stream), { stateDir });
    try {
      expect(second.port).toBe(firstPort);
    } finally {
      await second.close();
    }
  });
});

describe("panel asset façade request bodies (§1.6)", () => {
  type StreamWithOptions = (
    service: string,
    method: string,
    args: unknown[],
    options?: { body?: ReadableStream<Uint8Array> | null }
  ) => Promise<Response>;

  async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
    const reader = stream.getReader();
    const chunks: Buffer[] = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString("utf-8");
  }

  it("forwards a POST body as a streamed gateway.fetch upload (and its content-type)", async () => {
    let captured: CapturedDescriptor | undefined;
    let uploaded: Promise<string> | undefined;
    const stream = vi.fn<StreamWithOptions>(async (_service, _method, args, options) => {
      captured = (args as [CapturedDescriptor])[0];
      expect(options?.body).toBeInstanceOf(ReadableStream);
      uploaded = drain(options!.body!);
      return new Response('{"ok":true}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const facade = await startPanelAssetFacade(fakeServerClient(stream as never));
    try {
      const res = await fetch(`http://127.0.0.1:${facade.port}/api/upload`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"hello":"upload"}',
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    } finally {
      await facade.close();
    }

    expect(stream).toHaveBeenCalledTimes(1);
    expect(captured?.method).toBe("POST");
    expect(captured?.headers?.["content-type"]).toBe("application/json");
    await expect(uploaded!).resolves.toBe('{"hello":"upload"}');
  });

  it("GET requests carry no body option (wire unchanged)", async () => {
    const optionsSeen: unknown[] = [];
    const stream = vi.fn<StreamWithOptions>(async (_service, _method, _args, options) => {
      optionsSeen.push(options);
      return new Response("ok", { status: 200 });
    });
    const facade = await startPanelAssetFacade(fakeServerClient(stream as never));
    try {
      await (await fetch(`http://127.0.0.1:${facade.port}/apps/shell/`)).text();
    } finally {
      await facade.close();
    }
    expect(optionsSeen).toEqual([undefined]);
  });
});
