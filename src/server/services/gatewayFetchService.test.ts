import { afterEach, describe, expect, it } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import type { ServiceContext } from "@vibez1/shared/serviceDispatcher";
import { GZIP_MARKER_HEADER } from "@vibez1/shared/panel/assetHeaders";
import { createGatewayFetchService } from "./gatewayFetchService.js";

interface CapturedRequest {
  method: string;
  url: string;
  contentType: string | undefined;
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

function ctxWithBody(body?: ReadableStream<Uint8Array>): ServiceContext {
  return {
    caller: { runtime: { id: "panel:test", kind: "panel" } },
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
    expect(response.headers.get(GZIP_MARKER_HEADER)).toBeNull();
    expect(response.headers.get("content-range")).toBe("bytes 0-3/10");
    expect(await response.text()).toBe("0123");
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
