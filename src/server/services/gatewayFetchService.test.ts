import { afterEach, describe, expect, it } from "vitest";
import * as http from "node:http";
import { gzipSync, gunzipSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import type { CallerKind, ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import { GZIP_MARKER_HEADER, RESUMABLE_GZIP_HEADER } from "@vibestudio/shared/panel/assetHeaders";
import { createGatewayFetchService } from "./gatewayFetchService.js";

const MOBILE_APP_BOOTSTRAP_PATH = "/_r/s/auth/mobile-app-bootstrap";

interface CapturedRequest {
  method: string;
  url: string;
  contentType: string | undefined;
  acceptEncoding: string | undefined;
  body: string;
}

let server: http.Server | null = null;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
});

/** Loopback stand-in for the gateway that records what it receives. */
async function startFakeGateway(
  respond?: (req: http.IncomingMessage, res: http.ServerResponse, body: Buffer) => void
): Promise<{ port: number; requests: CapturedRequest[] }> {
  const requests: CapturedRequest[] = [];
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        contentType: req.headers["content-type"],
        acceptEncoding: req.headers["accept-encoding"],
        body: body.toString("utf-8"),
      });
      if (respond) {
        respond(req, res, body);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  const port = await new Promise<number>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(0, "127.0.0.1", () => resolve((server!.address() as AddressInfo).port));
  });
  return { port, requests };
}

function ctxWithBody(
  body?: ReadableStream<Uint8Array>,
  kind: CallerKind = "panel"
): ServiceContext {
  return {
    caller: { runtime: { id: `${kind}:test`, kind } },
    ...(body ? { body } : {}),
  } as unknown as ServiceContext;
}

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

describe("gatewayFetchService — §1.6 upload path", () => {
  it("keeps the RPC bridge available to panels, workers, and DOs", () => {
    const service = createGatewayFetchService({ getGatewayPort: () => 1 });
    expect(service.authority.principals).toEqual(["user", "code"]);
  });

  it("forwards ctx.body as the loopback request body (streamed, not base64)", async () => {
    const gateway = await startFakeGateway();
    const service = createGatewayFetchService({ getGatewayPort: () => gateway.port });

    const response = (await service.handler(ctxWithBody(streamOf('{"hello":"upload"}')), "fetch", [
      { path: "/api/echo", method: "POST", headers: { "content-type": "application/json" } },
    ])) as Response;

    expect(response.status).toBe(200);
    expect(gateway.requests).toHaveLength(1);
    expect(gateway.requests[0]).toMatchObject({
      method: "POST",
      url: "/api/echo",
      contentType: "application/json",
      body: '{"hello":"upload"}',
    });
  });

  it("sends no body when ctx.body is absent (GET path unchanged)", async () => {
    const gateway = await startFakeGateway();
    const service = createGatewayFetchService({ getGatewayPort: () => gateway.port });

    const response = (await service.handler(ctxWithBody(), "fetch", [
      { path: "/apps/shell/" },
    ])) as Response;

    expect(response.status).toBe(200);
    expect(gateway.requests[0]).toMatchObject({ method: "GET", body: "" });
  });

  it("the descriptor schema REJECTS the deleted base64/plain body fields (fail loud, no silent strip)", () => {
    const service = createGatewayFetchService({ getGatewayPort: () => 1 });
    const schema = service.methods!["fetch"]!.args;
    expect(schema.safeParse([{ path: "/x" }]).success).toBe(true);
    expect(schema.safeParse([{ path: "/x", bodyBase64: "aGk=" }]).success).toBe(false);
    expect(schema.safeParse([{ path: "/x", body: "hi" }]).success).toBe(false);
  });

  it("gzips ordinary responses when requested", async () => {
    const gateway = await startFakeGateway();
    const service = createGatewayFetchService({ getGatewayPort: () => gateway.port });

    const response = (await service.handler(ctxWithBody(), "fetch", [
      { path: "/apps/shell/bundle.js", gzip: true },
    ])) as Response;

    expect(response.status).toBe(200);
    expect(response.headers.get(GZIP_MARKER_HEADER)).toBe("1");
    expect(response.headers.get("content-length")).toBeNull();
  });

  it("forwards an upstream gzip representation without recompressing it", async () => {
    const source = Buffer.from("large panel asset ".repeat(256));
    const encoded = gzipSync(source, { level: 6 });
    const gateway = await startFakeGateway((req, res) => {
      expect(req.headers["accept-encoding"]).toBe("gzip");
      res.writeHead(200, {
        "content-type": "application/javascript",
        "content-encoding": "gzip",
        "content-length": encoded.byteLength,
      });
      res.end(encoded);
    });
    const service = createGatewayFetchService({ getGatewayPort: () => gateway.port });

    const response = (await service.handler(ctxWithBody(), "fetch", [
      { path: "/apps/shell/bundle.js", gzip: true },
    ])) as Response;
    const received = Buffer.from(await response.arrayBuffer());

    expect(gateway.requests[0]?.acceptEncoding).toBe("gzip");
    expect(response.headers.get(GZIP_MARKER_HEADER)).toBe("1");
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBe(String(encoded.byteLength));
    expect(received).toEqual(encoded);
    expect(gunzipSync(received)).toEqual(source);
  });

  it("does not gzip range requests or partial-content responses", async () => {
    const gateway = await startFakeGateway((_req, res) => {
      res.writeHead(206, {
        "content-type": "text/plain",
        "content-range": "bytes 0-3/10",
      });
      res.end("0123");
    });
    const service = createGatewayFetchService({ getGatewayPort: () => gateway.port });

    const response = (await service.handler(ctxWithBody(), "fetch", [
      {
        path: "/apps/shell/bundle.js",
        headers: { Range: "bytes=0-3" },
        gzip: true,
      },
    ])) as Response;

    expect(response.status).toBe(206);
    expect(gateway.requests[0]?.acceptEncoding).not.toBe("gzip");
    expect(response.headers.get(GZIP_MARKER_HEADER)).toBeNull();
    expect(response.headers.get("content-range")).toBe("bytes 0-3/10");
    expect(await response.text()).toBe("0123");
  });

  it("preserves deterministic encoded ranges for resumable mobile bundles", async () => {
    const source = Buffer.from("resumable mobile bundle ".repeat(1024));
    const encoded = gzipSync(source, { level: 6 });
    const gateway = await startFakeGateway((req, res) => {
      expect(req.headers[RESUMABLE_GZIP_HEADER]).toBe("1");
      const match = /^bytes=(\d+)-$/u.exec(req.headers.range ?? "");
      const start = match ? Number(match[1]) : 0;
      res.writeHead(start > 0 ? 206 : 200, {
        "content-type": "application/javascript",
        "content-encoding": "gzip",
        [RESUMABLE_GZIP_HEADER]: "1",
        ...(start > 0
          ? { "content-range": `bytes ${start}-${encoded.length - 1}/${encoded.length}` }
          : {}),
      });
      res.end(encoded.subarray(start));
    });
    const service = createGatewayFetchService({ getGatewayPort: () => gateway.port });
    const offset = Math.floor(encoded.length / 2);
    const response = (await service.handler(ctxWithBody(), "fetch", [
      {
        path: "/_a/build/index.android.bundle",
        gzip: true,
        headers: { [RESUMABLE_GZIP_HEADER]: "1", Range: `bytes=${offset}-` },
      },
    ])) as Response;
    const tail = Buffer.from(await response.arrayBuffer());

    expect(response.status).toBe(206);
    expect(response.headers.get(GZIP_MARKER_HEADER)).toBe("1");
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(gunzipSync(Buffer.concat([encoded.subarray(0, offset), tail]))).toEqual(source);
  });
});

describe("gatewayFetchService — panel-origin path allowlist", () => {
  async function fetchPath(path: string): Promise<{
    response?: Response;
    error?: { code?: string; message: string };
    requests: CapturedRequest[];
  }> {
    const gateway = await startFakeGateway();
    const service = createGatewayFetchService({ getGatewayPort: () => gateway.port });
    try {
      const response = (await service.handler(ctxWithBody(), "fetch", [{ path }])) as Response;
      return { response, requests: gateway.requests };
    } catch (err) {
      const e = err as Error & { code?: string };
      return { error: { code: e.code, message: e.message }, requests: gateway.requests };
    }
  }

  it("allows panel HTML/bundle asset paths (buildPanelUrl shape)", async () => {
    const { response, requests } = await fetchPath("/apps/shell/?contextId=ctx-1");
    expect(response?.status).toBe(200);
    expect(requests[0]?.url).toBe("/apps/shell/?contextId=ctx-1");
  });

  it("allows panel runtime helpers and the index page", async () => {
    for (const path of ["/", "/index.html", "/__loader.js", "/__transport.js", "/favicon.ico"]) {
      const { response } = await fetchPath(path);
      expect(response?.status, path).toBe(200);
    }
  });

  it("allows /_r/w/ worker HTTP routes", async () => {
    const { response, requests } = await fetchPath("/_r/w/workers/my-worker/hook?x=1");
    expect(response?.status).toBe(200);
    expect(requests[0]?.url).toBe("/_r/w/workers/my-worker/hook?x=1");
  });

  it("allows /_a/ approved app artifact routes", async () => {
    const { response } = await fetchPath("/_a/build-key-123/index.html");
    expect(response?.status).toBe(200);
  });

  it("REJECTS /_r/s/ management routes and never touches the gateway", async () => {
    for (const path of [
      MOBILE_APP_BOOTSTRAP_PATH,
      "/_r/s/auth/issue-device",
      "/_r/s/workspaces/default",
      "/_r/s/webhookIngress/sub-1",
      "/_r/s/credentials/oauth/callback",
    ]) {
      const { error, requests } = await fetchPath(path);
      expect(error?.code, path).toBe("EACCES");
      expect(requests, path).toHaveLength(0);
    }
  });

  it("REJECTS the RPC plane and gateway internals", async () => {
    for (const path of [
      "/rpc",
      "/rpc/stream",
      "/healthz",
      "/_r/ext/%40workspace-extensions%2Fgit-tools/upload",
      "/_w/do/x",
      "/_u/do/x",
      "/_workercode/my-worker",
      "/_workerversion/my-worker",
      "/_docode/src/Class",
      "/_doversion/src/Class",
    ]) {
      const { error, requests } = await fetchPath(path);
      expect(error?.code, path).toBe("EACCES");
      expect(requests, path).toHaveLength(0);
    }
  });

  it("REJECTS dot-segment escapes into the management namespace (normalized like fetch)", async () => {
    const { error, requests } = await fetchPath("/apps/shell/../../_r/s/auth/issue-device");
    expect(error?.code).toBe("EACCES");
    expect(requests).toHaveLength(0);
  });

  it("REJECTS origin escapes (relative, protocol-relative, backslash)", async () => {
    for (const path of ["@evil.example", "//evil.example/x", "/\\evil.example/x"]) {
      const { error, requests } = await fetchPath(path);
      expect(error?.code, path).toBe("EINVAL");
      expect(requests, path).toHaveLength(0);
    }
  });

  it("fetches the NORMALIZED path (in-namespace dot segments resolve before the loopback fetch)", async () => {
    const { response, requests } = await fetchPath("/apps/shell/sub/../bundle.js");
    expect(response?.status).toBe(200);
    expect(requests[0]?.url).toBe("/apps/shell/bundle.js");
  });
});

describe("gatewayFetchService — mobile native bootstrap exception", () => {
  it("allows trusted shell/app callers to POST the exact mobile bootstrap route", async () => {
    const gateway = await startFakeGateway();
    const service = createGatewayFetchService({ getGatewayPort: () => gateway.port });

    for (const kind of ["shell", "app"] as const) {
      const response = (await service.handler(
        ctxWithBody(streamOf(`{"caller":"${kind}"}`), kind),
        "fetch",
        [
          {
            path: MOBILE_APP_BOOTSTRAP_PATH,
            method: "post",
            headers: { "content-type": "application/json" },
          },
        ]
      )) as Response;
      expect(response.status, kind).toBe(200);
    }

    expect(gateway.requests).toHaveLength(2);
    expect(gateway.requests[0]).toMatchObject({
      method: "POST",
      url: MOBILE_APP_BOOTSTRAP_PATH,
      contentType: "application/json",
      body: '{"caller":"shell"}',
    });
    expect(gateway.requests[1]).toMatchObject({
      method: "POST",
      url: MOBILE_APP_BOOTSTRAP_PATH,
      contentType: "application/json",
      body: '{"caller":"app"}',
    });
  });

  it("rejects panel callers even when they POST the exact mobile bootstrap route", async () => {
    const gateway = await startFakeGateway();
    const service = createGatewayFetchService({ getGatewayPort: () => gateway.port });

    try {
      await service.handler(ctxWithBody(streamOf("{}")), "fetch", [
        { path: MOBILE_APP_BOOTSTRAP_PATH, method: "POST" },
      ]);
      throw new Error("expected gateway.fetch to reject");
    } catch (err) {
      const error = err as Error & { code?: string };
      expect(error.code).toBe("EACCES");
      expect(error.message).toContain("panel origin");
    }
    expect(gateway.requests).toHaveLength(0);
  });

  it("rejects shell callers unless the mobile bootstrap request is POST", async () => {
    const gateway = await startFakeGateway();
    const service = createGatewayFetchService({ getGatewayPort: () => gateway.port });

    try {
      await service.handler(ctxWithBody(undefined, "shell"), "fetch", [
        { path: MOBILE_APP_BOOTSTRAP_PATH, method: "GET" },
      ]);
      throw new Error("expected gateway.fetch to reject");
    } catch (err) {
      const error = err as Error & { code?: string };
      expect(error.code).toBe("EACCES");
    }
    expect(gateway.requests).toHaveLength(0);
  });
});

describe("gatewayFetchService — null-body upstream statuses", () => {
  it("passes a 304 through instead of throwing on the Response constructor", async () => {
    // A panel WebView revalidates its build chunks, so 304 is routine here.
    // Attaching the upstream stream to one makes the constructor throw, the
    // proxied fetch never resolves, and the dynamic import of that chunk
    // fails — which the user sees as the panel crashing.
    const gateway = await startFakeGateway((_req, res) => {
      res.writeHead(304, { etag: '"abc"', "content-length": "4096" });
      res.end();
    });
    const service = createGatewayFetchService({ getGatewayPort: () => gateway.port });

    const response = (await service.handler(ctxWithBody(), "fetch", [
      {
        path: "/__vibestudio/panel-build/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/chunk-ABC.js",
        gzip: true,
      },
    ])) as Response;

    expect(response.status).toBe(304);
    expect(response.body).toBeNull();
    expect(response.headers.get("etag")).toBe('"abc"');
    // Upstream describes the cached body; forwarding its framing onto a
    // bodyless response is net::ERR_CONTENT_LENGTH_MISMATCH in the WebView.
    expect(response.headers.get("content-length")).toBeNull();
  });

  it("passes a 204 through with no body", async () => {
    const gateway = await startFakeGateway((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    const service = createGatewayFetchService({ getGatewayPort: () => gateway.port });

    const response = (await service.handler(ctxWithBody(), "fetch", [
      { path: "/api/thing", method: "DELETE", gzip: true },
    ])) as Response;

    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });

  it("still streams a body for an ordinary 200", async () => {
    const gateway = await startFakeGateway((_req, res) => {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end("export default 1;\n");
    });
    const service = createGatewayFetchService({ getGatewayPort: () => gateway.port });

    const response = (await service.handler(ctxWithBody(), "fetch", [
      {
        path: "/__vibestudio/panel-build/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/chunk-ABC.js",
      },
    ])) as Response;

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("export default 1;\n");
  });
});
