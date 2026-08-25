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
import { CDP_WEBSOCKET_MAX_PAYLOAD_BYTES } from "./ingressLimits.js";
import { createBlobBundleReader } from "@vibestudio/shared/panel/blobBundle";
import { getPanelRuntimeHelperSet } from "./panelRuntimeHelpers.js";

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

vi.mock("./buildV2/buildStore.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./buildV2/buildStore.js")>();
  return {
    ...actual,
    readArtifactBytesAsync: vi.fn(
      async (_build: unknown, entry: { content: string; encoding: "utf8" | "base64" }) =>
        Buffer.from(entry.content, entry.encoding)
    ),
  };
});

vi.mock("ws", () => ({
  WebSocketServer: vi.fn().mockImplementation((options) => ({
    options,
    on: vi.fn(),
    close: vi.fn(),
  })),
}));

// Must import after mocks
const { PanelHttpServer } = await import("./panelHttpServer.js");
const PANEL_RUNTIME_HELPER_SET = getPanelRuntimeHelperSet();

function createMockResponse(): ServerResponse & {
  body?: unknown;
  // Optional so the intersection stays assignable from a bare ServerResponse,
  // which is what the method casts below produce.
  chunks?: Buffer[];
  statusCodeWritten?: number;
  headersWritten?: OutgoingHttpHeaders;
} {
  const res = {
    headersSent: false,
    chunks: [] as Buffer[],
  } as unknown as ServerResponse & {
    body?: unknown;
    chunks?: Buffer[];
    statusCodeWritten?: number;
    headersWritten?: OutgoingHttpHeaders;
    headersSent: boolean;
  };
  res.write = vi.fn((chunk: unknown) => {
    (res.chunks ??= []).push(Buffer.from(chunk as Uint8Array));
    return true;
  }) as unknown as ServerResponse["write"];
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

  it("keeps the legitimate CDP data-plane payload budget explicit", async () => {
    const server = new PanelHttpServer();
    server.initHandlers();
    const internal = server as unknown as {
      wss: { options: { maxPayload: number } };
    };

    expect(internal.wss.options.maxPayload).toBe(CDP_WEBSOCKET_MAX_PAYLOAD_BYTES);
    await server.stop();
  });

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
      getUnitIcon: vi.fn(async () => null),
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

  describe("build prefetch surfaces", () => {
    const digestOf = (content: string): string =>
      createHash("sha256").update(content).digest("hex");
    const lazy = "console.log('lazy')";
    const sharedCss = "body { color: rebeccapurple; }";
    // Past the size where a gzip header pays for itself, and highly compressible
    // — a real panel bundle is both.
    const big = `export const table = ${JSON.stringify("ab".repeat(2048))};`;
    const prefetchBuild = {
      ...buildResult,
      artifacts: [
        ...buildResult.artifacts.map((artifact) => ({
          ...artifact,
          integrity: `sha256-${digestOf((artifact as { content: string }).content)}`,
          byteLength: Buffer.byteLength((artifact as { content: string }).content),
        })),
        {
          path: "chunk-lazy.js",
          role: "asset",
          contentType: "application/javascript; charset=utf-8",
          encoding: "utf8",
          content: lazy,
          byteLength: Buffer.byteLength(lazy),
          integrity: `sha256-${digestOf(lazy)}`,
        },
        {
          path: "big.js",
          role: "asset",
          contentType: "application/javascript; charset=utf-8",
          encoding: "utf8",
          content: big,
          byteLength: Buffer.byteLength(big),
          integrity: `sha256-${digestOf(big)}`,
        },
        {
          path: `shared-style-${digestOf(sharedCss)}.css`,
          role: "shared-style",
          contentType: "text/css; charset=utf-8",
          encoding: "utf8",
          content: sharedCss,
          byteLength: Buffer.byteLength(sharedCss),
          integrity: `sha256-${digestOf(sharedCss)}`,
        },
      ],
      metadata: {
        ...buildResult.metadata,
        bundleReport: { initialArtifacts: ["bundle.js", "bundle.css", "big.js"] },
      },
    } as unknown as import("./buildV2/buildStore.js").BuildResult;

    const serverWithBuild = () => {
      const server = new PanelHttpServer();
      server.setCallbacks({
        onBuildComplete: vi.fn(),
        getBuild: vi.fn(async () => prefetchBuild),
        getUnitIcon: vi.fn(async () => null),
        getBuildByKey: vi.fn(() => prefetchBuild),
      });
      return server;
    };

    const manifest = async (): Promise<{
      artifacts: {
        path: string;
        contentType: string;
        byteLength?: number;
        integrity?: string;
        initial?: boolean;
      }[];
      runtimeHelpers: {
        path: string;
        contentType: string;
        byteLength: number;
        integrity: string;
        version: string;
        initial: boolean;
      }[];
    }> => {
      const response = await handlePanelRequest(
        serverWithBuild(),
        `/__vibestudio/panel-build/${BUILD_KEY}/__manifest.json`
      );
      expect(response.statusCodeWritten).toBe(200);
      return JSON.parse(String(response.body));
    };

    it("lists every artifact with the digest the bundle will key it under", async () => {
      const { artifacts } = await manifest();
      expect(artifacts.map((artifact) => artifact.path)).toEqual([
        "index.html",
        "bundle.js",
        "bundle.css",
        "chunk-lazy.js",
        "big.js",
        `shared-style-${digestOf(sharedCss)}.css`,
      ]);
      const bundleJs = artifacts.find((artifact) => artifact.path === "bundle.js");
      expect(bundleJs?.integrity).toBe(`sha256-${digestOf("console.log('hi')")}`);
      expect(bundleJs?.byteLength).toBe(Buffer.byteLength("console.log('hi')"));
      expect(bundleJs?.contentType).toBe("application/javascript; charset=utf-8");
    });

    it("marks only what a first paint needs as initial", async () => {
      // The whole point of the flag: a client that prefetched every artifact it
      // lacked would move the lazy chunks and source maps a panel may never
      // request. Shared styles are initial for every panel regardless of the
      // bundle report.
      const { artifacts } = await manifest();
      const initial = artifacts
        .filter((artifact) => artifact.initial)
        .map((artifact) => artifact.path);
      expect(initial).toEqual([
        "bundle.js",
        "bundle.css",
        "big.js",
        `shared-style-${digestOf(sharedCss)}.css`,
      ]);
    });

    it("publishes and bundles the exact content-addressed runtime helper set", async () => {
      const { runtimeHelpers } = await manifest();
      expect(runtimeHelpers).toEqual(
        PANEL_RUNTIME_HELPER_SET.helpers.map((helper) => ({
          path: helper.path,
          version: PANEL_RUNTIME_HELPER_SET.version,
          contentType: helper.contentType,
          byteLength: helper.body.byteLength,
          integrity: `sha256-${helper.integrity}`,
          initial: true,
        }))
      );

      const response = await handlePanelRequest(
        serverWithBuild(),
        `/__vibestudio/panel-build/${BUILD_KEY}/__bundle?helpers=0,1&enc=gzip`
      );
      const reader = createBlobBundleReader();
      const blobs = reader.push(Buffer.concat(response.chunks ?? []));
      reader.end();
      expect(blobs.map((blob) => blob.digest)).toEqual(
        PANEL_RUNTIME_HELPER_SET.helpers.map((helper) => helper.integrity)
      );
      for (const [index, blob] of blobs.entries()) {
        const body =
          blob!.payloadDigest === blob!.digest
            ? Buffer.from(blob!.bytes)
            : gunzipSync(Buffer.from(blob!.bytes));
        expect(body).toEqual(PANEL_RUNTIME_HELPER_SET.helpers[index]!.body);
      }
    });

    it("does not read artifact payloads to answer the manifest", async () => {
      // The inventory must stay cheap enough to serve on every panel open; the
      // build store's content getters hit disk.
      const artifacts = prefetchBuild.artifacts.map((artifact) => {
        const copy = { ...artifact } as Record<string, unknown>;
        Object.defineProperty(copy, "content", {
          enumerable: true,
          get() {
            throw new Error("manifest read an artifact payload");
          },
        });
        return copy;
      });
      const server = new PanelHttpServer();
      server.setCallbacks({
        onBuildComplete: vi.fn(),
        getBuild: vi.fn(async () => prefetchBuild),
        getUnitIcon: vi.fn(async () => null),
        getBuildByKey: vi.fn(
          () =>
            ({
              ...prefetchBuild,
              artifacts,
            }) as unknown as import("./buildV2/buildStore.js").BuildResult
        ),
      });

      const response = await handlePanelRequest(
        server,
        `/__vibestudio/panel-build/${BUILD_KEY}/__manifest.json`
      );
      expect(response.statusCodeWritten).toBe(200);
    });

    it("streams exactly the requested indices as digest-framed records", async () => {
      const response = await handlePanelRequest(
        serverWithBuild(),
        `/__vibestudio/panel-build/${BUILD_KEY}/__bundle?want=2,1`
      );

      expect(response.statusCodeWritten).toBe(200);
      const reader = createBlobBundleReader();
      const blobs = reader.push(Buffer.concat(response.chunks ?? []));
      reader.end();
      // Requested order, not manifest order: the client asked for css first.
      expect(blobs.map((blob) => blob.digest)).toEqual([
        digestOf("body{}"),
        digestOf("console.log('hi')"),
      ]);
      expect(Buffer.from(blobs[1]!.bytes).toString("utf8")).toBe("console.log('hi')");
    });

    it("frames gzip derivatives when asked, and says so per record", async () => {
      // Identity bytes measured as a net loss on a low-latency link: saving
      // ninety round trips does not pay for four times the payload. The record
      // keeps naming the artifact by its RAW digest, so it lands under the same
      // key either way.
      const response = await handlePanelRequest(
        serverWithBuild(),
        `/__vibestudio/panel-build/${BUILD_KEY}/__bundle?want=4&enc=gzip`
      );

      expect(response.headersWritten?.["x-vibestudio-bundle-encoding"]).toBe("gzip");
      const reader = createBlobBundleReader();
      const [blob] = reader.push(Buffer.concat(response.chunks ?? []));
      reader.end();
      expect(blob!.digest).toBe(digestOf(big));
      expect(blob!.payloadDigest).not.toBe(blob!.digest);
      expect(blob!.bytes.byteLength).toBeLessThan(Buffer.byteLength(big) / 4);
      expect(gunzipSync(Buffer.from(blob!.bytes)).toString("utf8")).toBe(big);
      expect(createHash("sha256").update(Buffer.from(blob!.bytes)).digest("hex")).toBe(
        blob!.payloadDigest
      );
    });

    it("leaves artifacts that compression would not help as identity", async () => {
      // bundle.js here is well under the size where a gzip header pays for
      // itself, and a build's images are already compressed. An identity record
      // announces itself by having equal digests, so one response can mix both.
      const response = await handlePanelRequest(
        serverWithBuild(),
        `/__vibestudio/panel-build/${BUILD_KEY}/__bundle?want=2&enc=gzip`
      );
      const reader = createBlobBundleReader();
      const [blob] = reader.push(Buffer.concat(response.chunks ?? []));
      reader.end();
      expect(blob!.payloadDigest).toBe(blob!.digest);
      expect(Buffer.from(blob!.bytes).toString("utf8")).toBe("body{}");
    });

    it("ignores duplicate and out-of-range indices instead of failing the transfer", async () => {
      // A client whose manifest is one build behind should still receive the
      // bytes it CAN use rather than nothing at all.
      const response = await handlePanelRequest(
        serverWithBuild(),
        `/__vibestudio/panel-build/${BUILD_KEY}/__bundle?want=1,1,99,-1,abc`
      );

      const reader = createBlobBundleReader();
      const blobs = reader.push(Buffer.concat(response.chunks ?? []));
      reader.end();
      expect(blobs.map((blob) => blob.digest)).toEqual([digestOf("console.log('hi')")]);
    });

    it("answers an empty selection with an empty, well-formed stream", async () => {
      const response = await handlePanelRequest(
        serverWithBuild(),
        `/__vibestudio/panel-build/${BUILD_KEY}/__bundle`
      );

      expect(response.statusCodeWritten).toBe(200);
      const reader = createBlobBundleReader();
      expect(reader.push(Buffer.concat(response.chunks ?? []))).toEqual([]);
      expect(() => reader.end()).not.toThrow();
    });

    it("refuses both surfaces for a build that is no longer activated", async () => {
      const server = new PanelHttpServer();
      server.setCallbacks({
        onBuildComplete: vi.fn(),
        getBuild: vi.fn(async () => prefetchBuild),
        getUnitIcon: vi.fn(async () => null),
        getBuildByKey: vi.fn(() => null),
      });

      for (const resource of ["__manifest.json", "__bundle?want=1"]) {
        const response = await handlePanelRequest(
          server,
          `/__vibestudio/panel-build/${"c".repeat(64)}/${resource}`
        );
        expect(response.statusCodeWritten).toBe(410);
      }
    });
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

  it("serves a declared unit icon without requesting a runtime build", async () => {
    const server = new PanelHttpServer();
    const body = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const contentHash = createHash("sha256").update(body).digest("hex");
    const getBuild = vi.fn(async () => buildResult);
    const getUnitIcon = vi.fn(async () => ({
      source: "workers/mail",
      path: "assets/icon.svg",
      stateHash: `state:${"a".repeat(64)}`,
      effectiveVersion: "ev-1",
      contentHash,
      contentType: "image/svg+xml",
      body,
    }));
    server.setCallbacks({
      getBuild,
      getUnitIcon,
      getBuildByKey: vi.fn(() => null),
    });

    const response = await handlePanelRequest(
      server,
      "/__vibestudio/unit-icon?source=workers%2Fmail&path=assets%2Ficon.svg"
    );

    expect(getUnitIcon).toHaveBeenCalledWith("workers/mail", "assets/icon.svg", undefined);
    expect(getBuild).not.toHaveBeenCalled();
    expect(response.statusCodeWritten).toBe(200);
    expect(response.headersWritten?.["Content-Type"]).toBe("image/svg+xml");
    expect(response.headersWritten?.["ETag"]).toBe(`"${contentHash}"`);
    expect(response.headersWritten?.["Cache-Control"]).toBe("private, no-cache");
    expect(String(response.body)).toContain("<svg");

    const revalidated = await handlePanelRequest(
      server,
      "/__vibestudio/unit-icon?source=workers%2Fmail&path=assets%2Ficon.svg",
      { "if-none-match": `W/"${contentHash}"` }
    );
    expect(revalidated.statusCodeWritten).toBe(304);
    expect(revalidated.body).toBeUndefined();

    // A `v` selects exact workspace content and makes the URL immutable, so a remote client can
    // store the glyph instead of re-fetching every unit's icon on every
    // launcher render — measured at 20 of 57 round trips for one panel open.
    const versioned = await handlePanelRequest(
      server,
      `/__vibestudio/unit-icon?source=workers%2Fmail&path=assets%2Ficon.svg&v=${contentHash}&s=${"a".repeat(64)}`
    );
    expect(getUnitIcon).toHaveBeenLastCalledWith(
      "workers/mail",
      "assets/icon.svg",
      `state:${"a".repeat(64)}`
    );
    expect(versioned.statusCodeWritten).toBe(200);
    expect(versioned.headersWritten?.["Cache-Control"]).toBe("public, max-age=31536000, immutable");

    const mismatched = await handlePanelRequest(
      server,
      `/__vibestudio/unit-icon?source=workers%2Fmail&path=assets%2Ficon.svg&v=${"f".repeat(64)}&s=${"a".repeat(64)}`
    );
    expect(mismatched.statusCodeWritten).toBe(404);

    // A malformed selector must not be interpreted as mutable current state.
    const bogus = await handlePanelRequest(
      server,
      "/__vibestudio/unit-icon?source=workers%2Fmail&path=assets%2Ficon.svg&v=nope"
    );
    expect(bogus.statusCodeWritten).toBe(400);
  });

  it("does not synthesize build refs from panel context ids", async () => {
    const server = new PanelHttpServer();
    const getBuild = vi.fn(async () => buildResult);
    server.setCallbacks({
      onBuildComplete: vi.fn(),
      getBuild,
      getUnitIcon: vi.fn(async () => null),
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
      getUnitIcon: vi.fn(async () => null),
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
      getUnitIcon: vi.fn(async () => null),
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
      getUnitIcon: vi.fn(async () => null),
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
      getUnitIcon: vi.fn(async () => null),
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
    server.setCallbacks({
      onBuildComplete: vi.fn(),
      getBuild,
      getUnitIcon: vi.fn(async () => null),
      getBuildByKey,
    });

    const response = await handlePanelRequest(
      server,
      `/panels/my-app/?contextId=ctx-panel&buildKey=${BUILD_KEY}`
    );

    expect(response.statusCodeWritten).toBe(200);
    expect(response.headersWritten?.["Cache-Control"]).toBe("public, max-age=31536000, immutable");
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
      getUnitIcon: vi.fn(async () => null),
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
      getUnitIcon: vi.fn(async () => null),
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

    const nestedResponse = await handlePanelRequest(server, "/panels/my-app/assets/icon.svg", {
      referer: `http://localhost/panels/my-app/?contextId=ctx-panel&buildKey=${BUILD_KEY}`,
    });
    expect(nestedResponse.statusCodeWritten).toBe(307);
    expect(nestedResponse.headersWritten).toMatchObject({
      Location: `../../../__vibestudio/panel-build/${BUILD_KEY}/assets/icon.svg`,
    });

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
      getUnitIcon: vi.fn(async () => null),
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
