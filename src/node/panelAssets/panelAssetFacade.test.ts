import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { createHash } from "node:crypto";
import { encodeBlobRecord } from "@vibestudio/shared/panel/blobBundle";
import { startPanelAssetFacade } from "./panelAssetFacade.js";
import type { PanelAssetStreamClient } from "./panelAssetFacade.js";

type GatewayStream = (service: string, method: string, args: unknown[]) => Promise<Response>;

/** Minimal stream client stub — the façade only ever touches `.stream`. */
function fakeServerClient(stream: GatewayStream): PanelAssetStreamClient {
  return {
    stream,
  } as PanelAssetStreamClient;
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
          "x-vibestudio-build-revision": "7",
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
      expect(res.headers.get("x-vibestudio-build-revision")).toBe("7");
      // content-encoding stripped → the outer fetch reads plain bytes.
      expect(res.headers.get("content-encoding")).toBeNull();
      expect(await res.text()).toBe(body);
    } finally {
      await facade.close();
    }

    // Assert the forwarded descriptor outside the façade's try/catch so a failed
    // expectation surfaces directly instead of being masked as a 502.
    expect(stream).toHaveBeenCalledTimes(1);
    // 4th arg = stream options; GETs carry an abort signal (backstop / webview
    // cancel) but NO body (§1.6 — bodies only on non-GET/HEAD).
    const options = (stream.mock.calls[0] as unknown[] | undefined)?.[3] as
      | { signal?: AbortSignal; body?: unknown }
      | undefined;
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(options?.body).toBeUndefined();
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
        const res = await fetch(`http://127.0.0.1:${facade.port}${blocked}`);
        expect(res.status, blocked).toBe(403);
      }
      // App artifacts and the server's exact immutable shared-style namespace
      // stay reachable. Dynamic worker routes require the authenticated bridge.
      const worker = await fetch(`http://127.0.0.1:${facade.port}/_r/w/workers/my-worker/hook`);
      expect(worker.status).toBe(403);
      for (const allowed of [
        "/_a/build-key/index.html",
        `/__vibestudio/shared-style/${"a".repeat(64)}.css`,
        `/__vibestudio/panel-build/${"b".repeat(64)}/bundle.js`,
      ]) {
        const res = await fetch(`http://127.0.0.1:${facade.port}${allowed}`);
        expect(res.status, allowed).toBe(200);
      }
    } finally {
      await facade.close();
    }
    expect(stream).toHaveBeenCalledTimes(3); // only immutable allowed paths hit the pipe
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

describe("panel asset façade backstops (offline / stalled server)", () => {
  it("surfaces a clear 504 when the server never responds (connect backstop)", async () => {
    // An offline server: the gateway.fetch stream never resolves. Without a
    // backstop the request parks forever → blank webview. With one it fails loud.
    const stream = vi.fn<GatewayStream>(
      () => new Promise<Response>(() => {}) // never resolves
    );
    const facade = await startPanelAssetFacade(fakeServerClient(stream), {
      connectBackstopMs: 100,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${facade.port}/apps/shell/bundle.js`);
      expect(res.status).toBe(504);
      expect(await res.text()).toMatch(/can't reach your server/i);
    } finally {
      await facade.close();
    }
  });

  it("cancels the pipe stream when the webview aborts mid-body", async () => {
    let cancelled = false;
    // A body that emits one chunk then stalls; its cancel() flags the teardown.
    const stream = vi.fn<GatewayStream>(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("first-chunk"));
          // never close — waits for a downstream cancel
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(body, { status: 200 });
    });
    const facade = await startPanelAssetFacade(fakeServerClient(stream));
    try {
      const ac = new AbortController();
      const res = await fetch(`http://127.0.0.1:${facade.port}/apps/shell/stream.js`, {
        signal: ac.signal,
      });
      const reader = res.body!.getReader();
      await reader.read(); // pull the first chunk so the body is actively streaming
      ac.abort(); // webview closes the panel mid-boot
      // The façade's res 'close' handler destroys the source → cancels the web stream.
      await vi.waitFor(() => expect(cancelled).toBe(true), { timeout: 2000 });
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

  it("shares one immutable entry across runtime context ids for the same build", async () => {
    const buildKey = "a".repeat(64);
    const body = "<!doctype html><script src='./bundle.js'></script>";
    const stream = vi.fn<GatewayStream>(async (_service, _method, args) => {
      const descriptor = (args as [CapturedDescriptor])[0];
      if (descriptor.path.includes("/__manifest.json")) {
        return new Response(JSON.stringify({ artifacts: [], runtimeHelpers: [] }), {
          status: 200,
          headers: { "content-type": "application/json", "cache-control": IMMUTABLE },
        });
      }
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": IMMUTABLE },
      });
    });
    const facade = await startPanelAssetFacade(fakeServerClient(stream), {
      stateDir: tempStateDir(),
    });
    try {
      const root = `http://127.0.0.1:${facade.port}/panels/chat/`;
      const first = await fetch(`${root}?contextId=panel-one&buildKey=${buildKey}`);
      expect(await first.text()).toBe(body);
      const second = await fetch(
        `${root}?contextId=panel-two&ref=state%3Anew&buildKey=${buildKey}`
      );
      expect(await second.text()).toBe(body);
      // One entry request plus one immutable inventory; the second context hits
      // both durable cache entries and opens no pipe stream.
      expect(stream).toHaveBeenCalledTimes(2);
    } finally {
      await facade.close();
    }
  });

  it("prefetches initial build artifacts and runtime helpers in one atomic bundle", async () => {
    const buildKey = "d".repeat(64);
    const helperVersion = "e".repeat(64);
    const artifact = "export const boot = true;".repeat(100);
    const helper = "globalThis.__helperReady = true;".repeat(60);
    const artifactDigest = createHash("sha256").update(artifact).digest("hex");
    const helperDigest = createHash("sha256").update(helper).digest("hex");
    const bundle = Buffer.concat([
      Buffer.from(encodeBlobRecord(artifactDigest, Buffer.from(artifact))),
      Buffer.from(encodeBlobRecord(helperDigest, Buffer.from(helper))),
    ]);
    const manifest = JSON.stringify({
      artifacts: [
        {
          path: "bundle.js",
          contentType: "application/javascript; charset=utf-8",
          integrity: `sha256-${artifactDigest}`,
          initial: true,
        },
      ],
      runtimeHelpers: [
        {
          path: "__loader.js",
          version: helperVersion,
          contentType: "application/javascript; charset=utf-8",
          integrity: `sha256-${helperDigest}`,
          initial: true,
        },
      ],
    });
    const seen: string[] = [];
    const stream = vi.fn<GatewayStream>(async (_service, _method, args) => {
      const descriptor = (args as [CapturedDescriptor])[0];
      seen.push(descriptor.path);
      if (descriptor.path.endsWith("/__manifest.json")) {
        return new Response(manifest, { headers: { "content-type": "application/json" } });
      }
      if (descriptor.path.includes("/__bundle?")) {
        return new Response(bundle, { headers: { "content-type": "application/octet-stream" } });
      }
      return new Response("<!doctype html>", {
        headers: { "content-type": "text/html", "cache-control": IMMUTABLE },
      });
    });
    const facade = await startPanelAssetFacade(fakeServerClient(stream), {
      stateDir: tempStateDir(),
    });
    try {
      const origin = `http://127.0.0.1:${facade.port}`;
      expect(
        await (await fetch(`${origin}/panels/chat/?contextId=one&buildKey=${buildKey}`)).text()
      ).toBe("<!doctype html>");
      expect(
        await (await fetch(`${origin}/__vibestudio/panel-build/${buildKey}/bundle.js`)).text()
      ).toBe(artifact);
      expect(
        await (await fetch(`${origin}/panels/chat/__loader.js?v=${helperVersion}`)).text()
      ).toBe(helper);
      expect(seen.filter((value) => value.includes("/__bundle?"))).toHaveLength(1);
      expect(seen).not.toContain(`/__vibestudio/panel-build/${buildKey}/bundle.js`);
      expect(seen).not.toContain(`/panels/chat/__loader.js?v=${helperVersion}`);
    } finally {
      await facade.close();
    }
  });

  it("reuses an immutable representation across credential rotation", async () => {
    const stream = vi.fn<GatewayStream>(async () => {
      return new Response("stable immutable bundle", {
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
      expect(await a1.text()).toBe("stable immutable bundle");
      const b1 = await fetch(url, { headers: { authorization: "Bearer b" } });
      expect(await b1.text()).toBe("stable immutable bundle");
      const a2 = await fetch(url, { headers: { authorization: "Bearer a" } });
      expect(await a2.text()).toBe("stable immutable bundle");
      expect(stream).toHaveBeenCalledTimes(1);
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
            "x-vibestudio-content-gzip": "1",
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

describe("panel asset façade origin contract", () => {
  type StreamWithOptions = (
    service: string,
    method: string,
    args: unknown[],
    options?: { body?: ReadableStream<Uint8Array> | null }
  ) => Promise<Response>;

  it("rejects non-GET requests without opening a pipe stream", async () => {
    const stream = vi.fn<StreamWithOptions>(async () => new Response("unexpected"));

    const facade = await startPanelAssetFacade(fakeServerClient(stream as never));
    try {
      const res = await fetch(`http://127.0.0.1:${facade.port}/api/upload`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"hello":"upload"}',
      });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("GET");
      expect(await res.text()).toMatch(/immutable GET content/u);

      const head = await fetch(`http://127.0.0.1:${facade.port}/apps/shell/`, {
        method: "HEAD",
      });
      expect(head.status).toBe(405);
    } finally {
      await facade.close();
    }

    expect(stream).not.toHaveBeenCalled();
  });

  it("GET requests carry a signal but no body (wire body unchanged)", async () => {
    const optionsSeen: Array<{ signal?: AbortSignal; body?: unknown } | undefined> = [];
    const stream = vi.fn<StreamWithOptions>(async (_service, _method, _args, options) => {
      optionsSeen.push(options as { signal?: AbortSignal; body?: unknown });
      return new Response("ok", { status: 200 });
    });
    const facade = await startPanelAssetFacade(fakeServerClient(stream as never));
    try {
      await (await fetch(`http://127.0.0.1:${facade.port}/apps/shell/`)).text();
    } finally {
      await facade.close();
    }
    expect(optionsSeen).toHaveLength(1);
    expect(optionsSeen[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(optionsSeen[0]?.body).toBeUndefined();
  });
});
