/**
 * Tests for PanelHttpServer routing, build cache, and callback-based flow.
 *
 * These are unit tests for the zero per-panel state server:
 * - extractSourcePath (URL parsing)
 * - storeBuild / invalidateBuild (serving cache)
 * - Callback-based flow (listPanels)
 */

import { describe, it, expect } from "vitest";
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "http";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// extractSourcePath is module-private, so we test the regex logic directly.
// ---------------------------------------------------------------------------

function extractSourcePath(pathname: string): { source: string; resource: string } | null {
  const match = pathname.match(/^\/([^/]+\/[^/]+)(\/.*)?$/);
  if (!match) return null;
  return { source: match[1]!, resource: match[2] || "/" };
}

describe("extractSourcePath", () => {
  it("parses two-segment source with trailing slash", () => {
    expect(extractSourcePath("/panels/my-app/")).toEqual({
      source: "panels/my-app",
      resource: "/",
    });
  });

  it("parses two-segment source without trailing slash", () => {
    expect(extractSourcePath("/panels/my-app")).toEqual({
      source: "panels/my-app",
      resource: "/",
    });
  });

  it("parses source with resource path", () => {
    expect(extractSourcePath("/panels/my-app/bundle.js")).toEqual({
      source: "panels/my-app",
      resource: "/bundle.js",
    });
  });

  it("parses source with nested resource path", () => {
    expect(extractSourcePath("/panels/my-app/assets/style.css")).toEqual({
      source: "panels/my-app",
      resource: "/assets/style.css",
    });
  });

  it("parses shell source (about/about format)", () => {
    expect(extractSourcePath("/about/about/")).toEqual({
      source: "about/about",
      resource: "/",
    });
  });

  it("returns null for single-segment path", () => {
    expect(extractSourcePath("/bundle.js")).toBeNull();
  });

  it("returns null for root path", () => {
    expect(extractSourcePath("/")).toBeNull();
  });

  it("returns null for empty path", () => {
    expect(extractSourcePath("")).toBeNull();
  });

  it("rejects colon-based single-segment path", () => {
    expect(extractSourcePath("/shell:about/")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PanelHttpServer unit tests (zero per-panel state)
// ---------------------------------------------------------------------------

import { vi } from "vitest";

vi.mock("fs", () => ({
  readFileSync: vi.fn().mockReturnValue("// stub"),
  existsSync: vi.fn().mockReturnValue(false),
}));

vi.mock("ws", () => ({
  WebSocketServer: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    close: vi.fn(),
  })),
}));

// Must import after mocks
const { PanelHttpServer } = await import("./panelHttpServer.js");

function createMockResponse(): ServerResponse & {
  body?: unknown;
  statusCodeWritten?: number;
  headersWritten?: OutgoingHttpHeaders;
} {
  const res = {
    headersSent: false,
  } as unknown as ServerResponse & {
    body?: unknown;
    statusCodeWritten?: number;
    headersWritten?: OutgoingHttpHeaders;
    headersSent: boolean;
  };
  res.setHeader = vi.fn() as unknown as ServerResponse["setHeader"];
  res.writeHead = vi.fn((statusCode: number, headers?: OutgoingHttpHeaders) => {
    res.headersSent = true;
    res.statusCodeWritten = statusCode;
    res.headersWritten = headers;
    return res;
  }) as unknown as ServerResponse["writeHead"];
  res.end = vi.fn((body?: unknown) => {
    res.body = body;
    return res;
  }) as unknown as ServerResponse["end"];
  return res;
}

async function handlePanelRequest(
  server: InstanceType<typeof PanelHttpServer>,
  url: string,
  headers: Record<string, string> = {}
): Promise<ReturnType<typeof createMockResponse>> {
  const req = {
    method: "GET",
    url,
    headers,
  } as unknown as IncomingMessage;
  const res = createMockResponse();
  await (
    server as unknown as {
      handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void>;
    }
  ).handleRequest(req, res);
  return res;
}

describe("PanelHttpServer build cache", () => {
  const BUILD_KEY = "b".repeat(64);
  const buildResult = {
    dir: "/tmp/build",
    buildKey: BUILD_KEY,
    sourceStateHash: "state-hash",
    artifacts: [
      {
        path: "index.html",
        role: "html",
        contentType: "text/html; charset=utf-8",
        encoding: "utf8",
        content: "<html></html>",
      },
      {
        path: "bundle.js",
        role: "primary",
        contentType: "application/javascript; charset=utf-8",
        encoding: "utf8",
        content: "console.log('hi')",
      },
      {
        path: "bundle.css",
        role: "css",
        contentType: "text/css; charset=utf-8",
        encoding: "utf8",
        content: "body{}",
      },
    ],
    metadata: {
      kind: "panel",
      name: "my-app",
      buildKey: BUILD_KEY,
      sourcePath: "panels/my-app",
      ev: "ev-1",
      sourceStateHash: "state-hash",
      sourcemap: true,
      details: { kind: "panel", target: "electron" },
      builtAt: "2026-07-21T00:00:00.000Z",
    },
  } as unknown as import("./buildV2/buildStore.js").BuildResult;

  it("storeBuild caches by source, hasBuild returns true", () => {
    const server = new PanelHttpServer();
    server.storeBuild("panels/my-app", buildResult);
    expect(server.hasBuild("panels/my-app")).toBe(true);
    expect(server.hasBuild("panels/other")).toBe(false);
  });

  it("keys cached builds by ref", () => {
    const server = new PanelHttpServer();
    server.storeBuild("panels/my-app", buildResult, "main");
    expect(server.hasBuild("panels/my-app")).toBe(false);
    expect(server.hasBuild("panels/my-app", "main")).toBe(true);
    expect(server.hasBuild("panels/my-app", "feature")).toBe(false);
  });

  it("assigns monotonically increasing build revisions by cache entry", () => {
    const server = new PanelHttpServer();
    server.storeBuild("panels/my-app", buildResult);
    const firstRevision = server.getBuildRevision("panels/my-app");
    server.storeBuild("panels/my-app", buildResult, "feature");
    const secondRevision = server.getBuildRevision("panels/my-app", "feature");

    expect(firstRevision).toBeGreaterThan(0);
    expect(secondRevision).toBeGreaterThan(firstRevision ?? 0);
    expect(server.getBuildRevision("panels/other")).toBeUndefined();
  });

  it("invalidateBuild removes cached build", () => {
    const server = new PanelHttpServer();
    server.storeBuild("panels/my-app", buildResult);
    server.storeBuild("panels/my-app", buildResult, "feature");
    server.invalidateBuild("panels/my-app");
    expect(server.hasBuild("panels/my-app")).toBe(false);
    expect(server.hasBuild("panels/my-app", "feature")).toBe(false);
  });

  it("storeBuild rejects build without html", () => {
    const server = new PanelHttpServer();
    expect(() =>
      server.storeBuild("panels/x", {
        ...buildResult,
        artifacts: buildResult.artifacts.filter((artifact) => artifact.role !== "html"),
      })
    ).toThrow(/missing HTML or primary artifact/);
  });

  it("storeBuild rejects build without bundle", () => {
    const server = new PanelHttpServer();
    expect(() =>
      server.storeBuild("panels/x", {
        ...buildResult,
        artifacts: buildResult.artifacts.filter((artifact) => artifact.role !== "primary"),
      })
    ).toThrow(/missing HTML or primary artifact/);
  });

  it("storeBuild calls onBuildComplete callback with source", () => {
    const server = new PanelHttpServer();
    const onBuildComplete = vi.fn();
    server.setCallbacks({
      onBuildComplete,
      getBuild: vi.fn(),
      getBuildByKey: vi.fn(() => buildResult),
    });

    server.storeBuild("panels/my-app", buildResult);
    expect(onBuildComplete).toHaveBeenCalledWith("panels/my-app");
  });

  it("does not read lazy artifact payloads while activating a panel build", () => {
    const server = new PanelHttpServer();
    const lazyArtifact = {
      path: "chunk-lazy.js",
      role: "asset" as const,
      contentType: "text/javascript; charset=utf-8",
      encoding: "utf8" as const,
      byteLength: 10_000,
      integrity: `sha256-${"a".repeat(64)}`,
    } as import("./buildV2/buildStore.js").BuildResult["artifacts"][number];
    Object.defineProperty(lazyArtifact, "content", {
      enumerable: true,
      get() {
        throw new Error("lazy payload was read");
      },
    });

    expect(() =>
      server.storeBuild("panels/my-app", {
        ...buildResult,
        artifacts: [...buildResult.artifacts, lazyArtifact],
        metadata: {
          ...buildResult.metadata,
          bundleReport: {
            version: 2,
            mode: "report-only",
            entryOutput: "bundle.js",
            initialArtifacts: ["bundle.js"],
            initial: { requests: 1, bytes: 1, jsBytes: 1, cssBytes: 0 },
            lazy: { requests: 1, bytes: 10_000, jsBytes: 10_000, cssBytes: 0 },
            total: { requests: 2, bytes: 10_001, jsBytes: 10_001, cssBytes: 0 },
            largestJsChunkBytes: 10_000,
            largestInitialInputs: [],
            largestLazyInputs: [],
          },
        },
      })
    ).not.toThrow();
  });

  it("serves shared styles from one digest-addressed URL across panel sources", async () => {
    const server = new PanelHttpServer();
    const content = "body { color: rebeccapurple; }";
    const digest = createHash("sha256").update(content).digest("hex");
    const sharedBuild = {
      ...buildResult,
      artifacts: [
        ...buildResult.artifacts,
        {
          path: `shared-style-${digest}.css`,
          role: "shared-style",
          contentType: "text/css; charset=utf-8",
          encoding: "utf8",
          integrity: `sha256-${digest}`,
          content,
        },
      ],
      metadata: {
        ...buildResult.metadata,
        sharedStyles: [
          {
            digest,
            contentType: "text/css; charset=utf-8",
            url: `../../__vibestudio/shared-style/${digest}.css`,
          },
        ],
      },
    } as import("./buildV2/buildStore.js").BuildResult;
    server.storeBuild("panels/my-app", sharedBuild);
    server.storeBuild("panels/other", {
      ...sharedBuild,
      metadata: { ...sharedBuild.metadata, sourcePath: "panels/other" },
    });

    const response = await handlePanelRequest(server, `/__vibestudio/shared-style/${digest}.css`);

    expect(response.statusCodeWritten).toBe(200);
    expect(response.body).toBe(content);
    expect(response.headersWritten?.["Cache-Control"]).toBe("public, max-age=31536000, immutable");
  });

  it("does not synthesize build refs from panel context ids", async () => {
    const server = new PanelHttpServer();
    const getBuild = vi.fn(async () => buildResult);
    server.setCallbacks({
      onBuildComplete: vi.fn(),
      getBuild,
      getBuildByKey: vi.fn(() => buildResult),
    });

    await handlePanelRequest(
      server,
      "/panels/my-app/?contextId=ctx-panel-tree-panels-chat-mqcv4k57-8e395774"
    );

    expect(getBuild).toHaveBeenCalledWith("panels/my-app", undefined);
  });

  it("serves runtime helpers from a panel route for workspace-prefixed clients", async () => {
    const server = new PanelHttpServer();
    const getBuild = vi.fn(async () => buildResult);
    server.setCallbacks({
      onBuildComplete: vi.fn(),
      getBuild,
      getBuildByKey: vi.fn(() => buildResult),
    });

    const loader = await handlePanelRequest(server, "/panels/my-app/__loader.js");
    expect(loader.statusCodeWritten).toBe(200);
    expect(String(loader.body)).toContain("__vibestudioPanelInit");

    const transport = await handlePanelRequest(server, "/panels/my-app/__transport.js");
    expect(transport.statusCodeWritten).toBe(200);
    expect(transport.body).toBe("// stub");
    expect(getBuild).not.toHaveBeenCalled();
  });

  it("uses explicit panel build refs when present", async () => {
    const server = new PanelHttpServer();
    const getBuild = vi.fn(async () => buildResult);
    server.setCallbacks({
      onBuildComplete: vi.fn(),
      getBuild,
      getBuildByKey: vi.fn(() => buildResult),
    });

    await handlePanelRequest(server, "/panels/my-app/?contextId=ctx-panel&ref=state:abc123");

    expect(getBuild).toHaveBeenCalledWith("panels/my-app", "state:abc123");
  });

  it("reuses an entity-primed build flight and waits for the requested artifact", async () => {
    const server = new PanelHttpServer();
    let resolveBuild!: (result: typeof buildResult) => void;
    const primedBuild = new Promise<typeof buildResult>((resolve) => {
      resolveBuild = resolve;
    });
    const getBuild = vi.fn(() => primedBuild);
    server.setCallbacks({
      onBuildComplete: vi.fn(),
      getBuild: vi.fn(async () => buildResult),
      getBuildByKey: vi.fn(() => buildResult),
    });
    server.primeBuild("panels/my-app", undefined, getBuild);

    const responsePending = handlePanelRequest(server, "/panels/my-app/bundle.js");
    await Promise.resolve();
    expect(getBuild).toHaveBeenCalledOnce();
    resolveBuild(buildResult);
    const response = await responsePending;

    expect(response.statusCodeWritten).toBe(200);
    expect(response.body).toBe("console.log('hi')");
  });

  it("serves a theme-adaptive build error page", async () => {
    const server = new PanelHttpServer();
    server.setCallbacks({
      onBuildComplete: vi.fn(),
      getBuild: vi.fn(async () => {
        throw new Error("broken build");
      }),
      getBuildByKey: vi.fn(() => null),
    });

    const response = await handlePanelRequest(server, "/panels/my-app/");
    const body = String(response.body);

    expect(response.statusCodeWritten).toBe(500);
    expect(body).toContain("--error-bg: #fff1f2");
    expect(body).toContain("@media (prefers-color-scheme: dark)");
    expect(body).toContain("broken build");
  });

  it("serves an activated panel strictly from its immutable build key", async () => {
    const server = new PanelHttpServer();
    const getBuild = vi.fn(async () => buildResult);
    const getBuildByKey = vi.fn(() => buildResult);
    server.setCallbacks({ onBuildComplete: vi.fn(), getBuild, getBuildByKey });

    const response = await handlePanelRequest(
      server,
      `/panels/my-app/?contextId=ctx-panel&buildKey=${BUILD_KEY}`
    );

    expect(response.statusCodeWritten).toBe(200);
    expect(getBuildByKey).toHaveBeenCalledWith(BUILD_KEY);
    expect(getBuild).not.toHaveBeenCalled();
  });

  it("fails closed when an activated build is missing or belongs to another panel", async () => {
    const server = new PanelHttpServer();
    let exactBuild: import("./buildV2/buildStore.js").BuildResult | null = null;
    const getBuildByKey = vi.fn(() => exactBuild);
    server.setCallbacks({
      onBuildComplete: vi.fn(),
      getBuild: vi.fn(async () => buildResult),
      getBuildByKey,
    });

    const missing = await handlePanelRequest(
      server,
      `/panels/my-app/?contextId=ctx-panel&buildKey=${BUILD_KEY}`
    );
    expect(missing.statusCodeWritten).toBe(410);

    exactBuild = {
      ...buildResult,
      metadata: { ...buildResult.metadata, sourcePath: "panels/other" },
    };
    const mismatched = await handlePanelRequest(
      server,
      `/panels/my-app/?contextId=ctx-panel&buildKey=${BUILD_KEY}`
    );
    expect(mismatched.statusCodeWritten).toBe(403);
  });

  it("pins subresources to the build key carried by their document referer", async () => {
    const server = new PanelHttpServer();
    const getBuildByKey = vi.fn(() => buildResult);
    server.setCallbacks({
      onBuildComplete: vi.fn(),
      getBuild: vi.fn(async () => buildResult),
      getBuildByKey,
    });

    const response = await handlePanelRequest(server, "/panels/my-app/bundle.js", {
      referer: `http://localhost/panels/my-app/?contextId=ctx-panel&buildKey=${BUILD_KEY}`,
    });

    expect(response.statusCodeWritten).toBe(307);
    expect(response.headersWritten).toMatchObject({
      Location: `../../__vibestudio/panel-build/${BUILD_KEY}/bundle.js`,
    });
    expect(getBuildByKey).toHaveBeenCalledWith(BUILD_KEY);

    const pinned = await handlePanelRequest(
      server,
      `/__vibestudio/panel-build/${BUILD_KEY}/bundle.js`
    );
    expect(pinned.statusCodeWritten).toBe(200);
    expect(pinned.body).toBe("console.log('hi')");
  });

  it("rewrites activated HTML artifact references onto the immutable build route", async () => {
    const server = new PanelHttpServer();
    const activated = {
      ...buildResult,
      artifacts: buildResult.artifacts.map((artifact) =>
        artifact.role === "html"
          ? {
              ...artifact,
              content:
                '<html><head><link rel="stylesheet" href="./bundle.css"></head>' +
                '<body><script src="./__loader.js" data-bundle-src="./bundle.js"></script></body></html>',
            }
          : artifact
      ),
    } as typeof buildResult;
    server.setCallbacks({
      onBuildComplete: vi.fn(),
      getBuild: vi.fn(async () => activated),
      getBuildByKey: vi.fn(() => activated),
    });

    const response = await handlePanelRequest(
      server,
      `/panels/my-app/?contextId=ctx-panel&buildKey=${BUILD_KEY}`
    );
    const prefix = `../../__vibestudio/panel-build/${BUILD_KEY}/`;

    expect(response.statusCodeWritten).toBe(200);
    expect(response.body).toContain(`href="${prefix}bundle.css"`);
    expect(response.body).toContain(`data-bundle-src="${prefix}bundle.js"`);
    expect(response.body).toContain('src="./__loader.js"');
  });

  it("compresses cacheable panel startup artifacts for desktop and mobile clients", async () => {
    const server = new PanelHttpServer();
    const source = "console.log('startup');\n".repeat(512);
    const compressedBuild = {
      ...buildResult,
      artifacts: buildResult.artifacts.map((artifact) =>
        artifact.role === "primary" ? { ...artifact, content: source } : artifact
      ),
    } as typeof buildResult;
    server.storeBuild("panels/my-app", compressedBuild);

    const response = await handlePanelRequest(server, "/panels/my-app/bundle.js", {
      "accept-encoding": "br;q=0.1, gzip;q=1",
      "user-agent": "Vibestudio-Mobile",
    });

    expect(response.headersWritten).toMatchObject({
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Encoding": "gzip",
      Vary: "Accept-Encoding",
    });
    expect(Buffer.isBuffer(response.body)).toBe(true);
    expect(gunzipSync(response.body as Buffer).toString()).toBe(source);
  });

  it("keeps the mutable panel HTML pointer out of persistent caches", async () => {
    const server = new PanelHttpServer();
    server.storeBuild("panels/my-app", buildResult);

    const response = await handlePanelRequest(server, "/panels/my-app/");

    expect(response.headersWritten?.["Cache-Control"]).toBe("no-store");
  });

  it("does not serve a main entry artifact for a referer-less ref-pinned asset path", async () => {
    const server = new PanelHttpServer();
    const mainBuild = {
      ...buildResult,
      artifacts: buildResult.artifacts.map((artifact) =>
        artifact.role === "primary"
          ? { ...artifact, path: "bundle-main.js", content: "console.log('main')" }
          : artifact
      ),
    } as typeof buildResult;
    const refBuild = {
      ...buildResult,
      artifacts: buildResult.artifacts.map((artifact) =>
        artifact.role === "primary"
          ? { ...artifact, path: "bundle-ref.js", content: "console.log('ref')" }
          : artifact
      ),
    } as typeof buildResult;

    server.storeBuild("panels/my-app", mainBuild);
    server.storeBuild("panels/my-app", refBuild, "state:abc123");

    const refererless = await handlePanelRequest(server, "/panels/my-app/bundle-ref.js");
    expect(refererless.statusCodeWritten).toBe(404);
    expect(refererless.body).toBe("Not found");

    const pinned = await handlePanelRequest(server, "/panels/my-app/bundle-ref.js", {
      referer: "http://localhost:1234/panels/my-app/?ref=state:abc123",
    });
    expect(pinned.statusCodeWritten).toBe(200);
    expect(pinned.body).toBe("console.log('ref')");
  });
});
