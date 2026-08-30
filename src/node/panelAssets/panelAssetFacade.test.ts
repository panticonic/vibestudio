import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { startPanelAssetFacade } from "./panelAssetFacade.js";
import type { PanelAssetStreamClient } from "./panelAssetFacade.js";

type GatewayStream = (service: string, method: string, args: unknown[]) => Promise<Response>;

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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
const BUILD_KEY = "b".repeat(64);

function initialManifest(paths: string[]): string {
  return JSON.stringify({
    artifacts: paths.map((resourcePath) => ({
      path: resourcePath,
      contentType: "text/javascript; charset=utf-8",
      integrity: `sha256-${"a".repeat(64)}`,
      initial: true,
    })),
    runtimeHelpers: [],
  });
}

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
    const stream = vi.fn<GatewayStream>(
      async () =>
        new Response(body, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": IMMUTABLE },
        })
    );
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
      // Context identity is not part of an immutable build entry's cache key.
      const entryCalls = stream.mock.calls.filter((call) => {
        const descriptor = (call[2] as unknown as [CapturedDescriptor])[0];
        return descriptor.path.startsWith("/panels/chat/");
      });
      expect(entryCalls).toHaveLength(1);
    } finally {
      await facade.close();
    }
  });

  it("dispatches demanded assets independently without speculative bundle barriers", async () => {
    const releaseFirst = deferred<void>();
    const observed: string[] = [];
    const stream = vi.fn<GatewayStream>(async (_service, _method, args) => {
      const descriptor = (args as [CapturedDescriptor])[0];
      observed.push(descriptor.path);
      if (descriptor.path.endsWith("first.js")) await releaseFirst.promise;
      return new Response(descriptor.path, {
        status: 200,
        headers: { "content-type": "text/javascript", "cache-control": IMMUTABLE },
      });
    });
    const facade = await startPanelAssetFacade(fakeServerClient(stream), {
      stateDir: tempStateDir(),
    });
    try {
      const origin = `http://127.0.0.1:${facade.port}`;
      const first = fetch(`${origin}/__vibestudio/panel-build/${"b".repeat(64)}/first.js`);
      await vi.waitFor(() => expect(observed).toHaveLength(1));
      const second = await fetch(`${origin}/__vibestudio/panel-build/${"b".repeat(64)}/second.js`);
      expect(await second.text()).toContain("second.js");
      expect(observed).toEqual([
        `/__vibestudio/panel-build/${"b".repeat(64)}/first.js`,
        `/__vibestudio/panel-build/${"b".repeat(64)}/second.js`,
      ]);
      expect(observed.some((value) => value.includes("__bundle"))).toBe(false);
      releaseFirst.resolve(undefined);
      await (await first).text();
    } finally {
      releaseFirst.resolve(undefined);
      await facade.close();
    }
  });

  it("coalesces prewarm-first and demanded transfer into one per-asset job", async () => {
    const releaseAsset = deferred<void>();
    const assetStarted = deferred<void>();
    const assetPath = `/__vibestudio/panel-build/${BUILD_KEY}/shared.js`;
    const observed: string[] = [];
    const stream = vi.fn<GatewayStream>(async (_service, _method, args) => {
      const descriptor = (args as [CapturedDescriptor])[0];
      observed.push(descriptor.path);
      if (descriptor.path.endsWith("__manifest.json")) {
        return new Response(initialManifest(["shared.js"]), {
          headers: { "content-type": "application/json", "cache-control": IMMUTABLE },
        });
      }
      if (descriptor.path === assetPath) {
        assetStarted.resolve(undefined);
        await releaseAsset.promise;
        return new Response("shared asset", {
          headers: { "content-type": "text/javascript", "cache-control": IMMUTABLE },
        });
      }
      return new Response("<html>entry</html>", {
        headers: { "content-type": "text/html", "cache-control": IMMUTABLE },
      });
    });
    const facade = await startPanelAssetFacade(fakeServerClient(stream), {
      stateDir: tempStateDir(),
    });
    try {
      const origin = `http://127.0.0.1:${facade.port}`;
      await (
        await fetch(`${origin}/panels/chat/?contextId=panel-one&buildKey=${BUILD_KEY}`)
      ).text();
      await assetStarted.promise;
      const demanded = fetch(`${origin}${assetPath}`).then((response) => response.text());
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(observed.filter((value) => value === assetPath)).toHaveLength(1);
      releaseAsset.resolve(undefined);
      await expect(demanded).resolves.toBe("shared asset");
      expect(observed.some((value) => value.includes("__bundle"))).toBe(false);
    } finally {
      releaseAsset.resolve(undefined);
      await facade.close();
    }
  });

  it("coalesces demand-first and subsequent prewarm into one per-asset job", async () => {
    const releaseAsset = deferred<void>();
    const assetStarted = deferred<void>();
    const assetPath = `/__vibestudio/panel-build/${BUILD_KEY}/shared.js`;
    const observed: string[] = [];
    const stream = vi.fn<GatewayStream>(async (_service, _method, args) => {
      const descriptor = (args as [CapturedDescriptor])[0];
      observed.push(descriptor.path);
      if (descriptor.path.endsWith("__manifest.json")) {
        return new Response(initialManifest(["shared.js"]), {
          headers: { "content-type": "application/json", "cache-control": IMMUTABLE },
        });
      }
      if (descriptor.path === assetPath) {
        assetStarted.resolve(undefined);
        await releaseAsset.promise;
        return new Response("shared asset", {
          headers: { "content-type": "text/javascript", "cache-control": IMMUTABLE },
        });
      }
      return new Response("<html>entry</html>", {
        headers: { "content-type": "text/html", "cache-control": IMMUTABLE },
      });
    });
    const facade = await startPanelAssetFacade(fakeServerClient(stream), {
      stateDir: tempStateDir(),
    });
    try {
      const origin = `http://127.0.0.1:${facade.port}`;
      const demanded = fetch(`${origin}${assetPath}`).then((response) => response.text());
      await assetStarted.promise;
      await (
        await fetch(`${origin}/panels/chat/?contextId=panel-one&buildKey=${BUILD_KEY}`)
      ).text();
      await vi.waitFor(() =>
        expect(observed.some((value) => value.endsWith("__manifest.json"))).toBe(true)
      );
      expect(observed.filter((value) => value === assetPath)).toHaveLength(1);
      releaseAsset.resolve(undefined);
      await expect(demanded).resolves.toBe("shared asset");
    } finally {
      releaseAsset.resolve(undefined);
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
