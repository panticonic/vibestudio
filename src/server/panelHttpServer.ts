import { ByteBudgetCache } from "@vibestudio/shared/byteBudgetCache";
/**
 * PanelHttpServer — source/ref-keyed static panel asset server.
 *
 * Panel identity is injected by the host shell before app code runs, so this
 * server resolves source builds and serves static assets from path-based URLs.
 */

import * as fs from "fs";
import * as path from "path";
import { WebSocketServer } from "ws";
import { CDP_WEBSOCKET_MAX_PAYLOAD_BYTES } from "./ingressLimits.js";
import { createDevLogger } from "@vibestudio/dev-log";
import type {
  BuildArtifactManifestEntry,
  BuildMetadata,
  StoredBuildResult,
} from "./buildV2/buildStore.js";
import type { CdpBridge } from "./cdpBridge.js";
import { assertPresent } from "../lintHelpers";
import { TransportDerivativeCache } from "./buildV2/transportDerivativeCache.js";
import {
  BuildArtifactTransport,
  preferredContentEncoding,
  type TransportBuild,
} from "./buildArtifactTransport.js";
import type { ResolvedUnitIcon } from "./buildV2/index.js";
import { resolveRequiredHostArtifactRoot } from "./appRoot.js";
import { getPanelRuntimeHelperSet } from "./panelRuntimeHelpers.js";

const log = createDevLogger("PanelHttpServer");

// ---------------------------------------------------------------------------
// Pre-compiled browser transport + context bootstrap
// ---------------------------------------------------------------------------

interface BrandAssets {
  faviconIco: Buffer;
  faviconPng: Buffer;
  faviconSvg: Buffer;
  symbolLightDataUrl: string;
  symbolDarkDataUrl: string;
}

let brandAssets: BrandAssets | null = null;

/**
 * The host build copies `build-resources/brand` into every artifact generation,
 * so these files are part of the build contract: read them on first use and
 * fail loudly if a generation is missing one.
 */
function getBrandAssets(): BrandAssets {
  if (brandAssets) return brandAssets;
  const brandDir = path.join(resolveRequiredHostArtifactRoot(), "assets", "brand");
  const read = (filename: string) => fs.readFileSync(path.join(brandDir, filename));
  const dataUrl = (svg: Buffer) => `data:image/svg+xml;base64,${svg.toString("base64")}`;
  brandAssets = {
    faviconIco: read("favicon.ico"),
    faviconPng: read("favicon-64.png"),
    faviconSvg: read("favicon.svg"),
    symbolLightDataUrl: dataUrl(read("vibestudio-symbol.svg")),
    symbolDarkDataUrl: dataUrl(read("vibestudio-symbol-dark.svg")),
  };
  return brandAssets;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Callback interface for panel-related data.
 * The HTTP server receives all panel data via these callbacks — no per-panel state stored.
 */
export interface PanelHttpCallbacks {
  /** Build-complete notification (source-level) */
  onBuildComplete?(source: string, error?: string): void;

  /** Build trigger */
  getBuild(source: string, ref?: string): Promise<StoredBuildResult>;

  /** Declared icon bytes from current or explicitly selected workspace content. */
  getUnitIcon(
    source: string,
    artifactPath: string,
    stateRef?: string
  ): Promise<ResolvedUnitIcon | null>;

  /** Resolve an already-built immutable artifact selected by runtime activation. */
  getBuildByKey(buildKey: string): Promise<StoredBuildResult | null>;
  findSharedStyleBuild(digest: string): Promise<StoredBuildResult | null>;
  readArtifactBytes(
    build: Pick<StoredBuildResult, "dir">,
    artifact: BuildArtifactManifestEntry
  ): Promise<Buffer>;
  artifactFilePath(
    build: Pick<StoredBuildResult, "dir">,
    artifact: BuildArtifactManifestEntry
  ): string;
  buildDescriptorBytes(build: Pick<StoredBuildResult, "dir" | "metadata" | "artifacts">): number;
}

/** Build output cached by source path (shared across panels) */
interface CachedBuild {
  dir: string;
  artifacts: BuildArtifactManifestEntry[];
  htmlArtifact: BuildArtifactManifestEntry;
  metadata: BuildMetadata;
  revision: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Extract source path (first two segments) and resource from URL pathname.
 *  /panels/my-app/bundle.js → { source: "panels/my-app", resource: "/bundle.js" }
 *  /panels/my-app/ → { source: "panels/my-app", resource: "/" }
 *  /panels/my-app → { source: "panels/my-app", resource: "/" }
 */
function extractSourcePath(pathname: string): { source: string; resource: string } | null {
  const match = pathname.match(/^\/([^/]+\/[^/]+)(\/.*)?$/);
  if (!match) return null;
  return { source: assertPresent(match[1]), resource: match[2] || "/" };
}

function shouldLogPanelResourceRequests(): boolean {
  if (process.env["VIBESTUDIO_PANEL_RESOURCE_LOG"] === "0") return false;
  return (
    process.env["VIBESTUDIO_PANEL_RESOURCE_LOG"] === "1" ||
    process.env["NODE_ENV"] === "development"
  );
}

function isPanelAssetRequest(resource: string): boolean {
  const normalized = resource.replace(/^\/+/, "");
  return (
    normalized === "bundle.js" ||
    normalized === "bundle.css" ||
    normalized.startsWith("assets/") ||
    normalized.startsWith("chunk-") ||
    /\.[cm]?js(?:\.map)?$/iu.test(normalized) ||
    /\.css(?:\.map)?$/iu.test(normalized) ||
    /\.(?:png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|wasm)$/iu.test(normalized)
  );
}

/** A client document may load only its own origin's scripts, styles and images. */
const CLIENT_DOCUMENT_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss: http: https:";

/** `enc=gzip` asks for each text-like record of a bundle in its compressed form. */
function bundleWantsGzip(req: import("http").IncomingMessage): boolean {
  return (
    new URL(req.url ?? "/", "http://build-artifacts.invalid").searchParams.get("enc") === "gzip"
  );
}

// ---------------------------------------------------------------------------
// PanelHttpServer
// ---------------------------------------------------------------------------

export class PanelHttpServer {
  private readonly runtimeHelperSet = getPanelRuntimeHelperSet();
  private readonly transport: BuildArtifactTransport;
  constructor(transportDerivativeCache = new TransportDerivativeCache()) {
    this.transport = new BuildArtifactTransport(
      () => this.requireCallbacks(),
      transportDerivativeCache
    );
  }

  private buildDescriptorBytes(build: CachedBuild): number {
    const reader = this.callbacks?.buildDescriptorBytes;
    if (!reader) throw new Error("Panel build store is not connected");
    return reader(build);
  }

  /** Serving cache: source/ref -> resolved build (for fast sub-resource serving within a page load) */
  private servingCache = new ByteBudgetCache<string, CachedBuild>(32 * 1024 * 1024, (build) =>
    this.buildDescriptorBytes(build)
  );

  /** Immutable activated artifacts. Never invalidated by a later source build. */
  private activatedBuildCache = new ByteBudgetCache<string, CachedBuild>(
    32 * 1024 * 1024,
    (build) => this.buildDescriptorBytes(build)
  );

  /** Digest-addressed base styles shared by every panel URL. */
  private sharedStyleAssets = new ByteBudgetCache<
    string,
    {
      build: CachedBuild;
      artifact: BuildArtifactManifestEntry;
    }
  >(32 * 1024 * 1024, ({ build }) => this.buildDescriptorBytes(build));

  /** Builds currently in flight (dedup concurrent requests) */
  private buildInFlight = new Map<string, Promise<void>>();

  /** Build errors: source -> error message (surface to next request) */
  private buildErrors = new Map<string, string>();
  private buildRevisionCounter = 0;

  private port: number | null = null;

  /**
   * Source registry populated at startup from the package graph.
   * Used to list launchable panels on the index page.
   */
  private sourceRegistry = new Map<string, { name: string }>();

  /** Callbacks for panel-related data (zero per-panel state on server) */
  private callbacks: PanelHttpCallbacks | null = null;

  private wss: WebSocketServer | null = null;
  private cdpBridge: CdpBridge | null = null;
  private workerdInspectorBridge:
    | import("./workerdInspectorBridge.js").WorkerdInspectorBridge
    | null = null;

  // The panel asset façade is loopback-only and serves non-secret assets
  // exclusively (HTML / bundles / __loader.js / __transport.js / css / wasm).
  // It carries no management surface and no per-request token: the grant token
  // reaches the panel out-of-band via the shell bridge, and panel RPC rides
  // that bridge, never a loopback socket. The gateway binds 127.0.0.1 only.

  // =========================================================================
  // Configuration
  // =========================================================================

  /**
   * Set the callback interface for panel-related queries.
   * All panel data comes through these callbacks — no per-panel state stored.
   */
  setCallbacks(callbacks: PanelHttpCallbacks): void {
    this.callbacks = callbacks;
  }

  /**
   * Populate the source registry with available panels from the package graph.
   */
  populateSourceRegistry(entries: Array<{ source: string; name: string }>): void {
    this.sourceRegistry.clear();
    for (const entry of entries) {
      this.sourceRegistry.set(entry.source, { name: entry.name });
    }
    log.info(`Source registry populated with ${entries.length} panels`);
  }

  setCdpBridge(bridge: CdpBridge): void {
    this.cdpBridge = bridge;
  }

  setWorkerdInspectorBridge(
    bridge: import("./workerdInspectorBridge.js").WorkerdInspectorBridge
  ): void {
    this.workerdInspectorBridge = bridge;
  }

  // =========================================================================
  // Server lifecycle
  // =========================================================================

  /**
   * Initialize handlers without binding a socket.
   * Call this when the gateway owns the socket and dispatches to us.
   */
  initHandlers(): void {
    if (this.handlersInitialized) return;
    this.handlersInitialized = true;
    // CDP/inspector traffic can legitimately contain large screenshots and
    // protocol results. The bridges authenticate before calling handleUpgrade,
    // so this post-admission data-plane budget does not apply to anonymous peers.
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: CDP_WEBSOCKET_MAX_PAYLOAD_BYTES,
    });
  }
  private handlersInitialized = false;

  getPort(): number {
    if (this.port === null) throw new Error("PanelHttpServer not started");
    return this.port;
  }

  // =========================================================================
  // Build cache (source/ref-keyed, inherently server)
  // =========================================================================

  /**
   * Store a build result. Keyed by source/ref.
   */
  storeBuild(source: string, buildResult: StoredBuildResult, ref?: string): void {
    const htmlArtifact = buildResult.artifacts.find((artifact) => artifact.role === "html");
    const primaryArtifact = buildResult.artifacts.find((artifact) => artifact.role === "primary");
    if (!htmlArtifact || !primaryArtifact) {
      throw new Error(`Build result for ${source} missing HTML or primary artifact`);
    }

    const revision = ++this.buildRevisionCounter;
    const cachedBuild = {
      dir: buildResult.dir,
      artifacts: buildResult.artifacts,
      htmlArtifact,
      metadata: buildResult.metadata,
      revision,
    };
    this.servingCache.set(this.buildCacheKey(source, ref), cachedBuild);
    this.activatedBuildCache.set(buildResult.buildKey, cachedBuild);
    this.registerSharedStyles(cachedBuild);
    this.transport.warm(cachedBuild);

    log.info(`Stored build: ${this.buildCacheKey(source, ref)}`);

    // Notify callback (source-level — caller does per-panel fan-out)
    this.callbacks?.onBuildComplete?.(source);
  }

  /**
   * Invalidate cached build for a source (used by force-rebuild).
   * Also clears build errors so force-rebuild retries cleanly.
   */
  invalidateBuild(source: string): void {
    for (const key of [...this.servingCache.keys()]) {
      if (key === source || key.startsWith(`${source}@`)) {
        this.servingCache.delete(key);
      }
    }
    for (const key of [...this.buildErrors.keys()]) {
      if (key === source || key.startsWith(`${source}@`)) {
        this.buildErrors.delete(key);
      }
    }
  }

  /**
   * Check if a build is cached for a source.
   */
  hasBuild(source: string, ref?: string): boolean {
    return this.servingCache.has(this.buildCacheKey(source, ref));
  }

  getBuildRevision(source: string, ref?: string): number | undefined {
    return this.servingCache.get(this.buildCacheKey(source, ref))?.revision;
  }

  /**
   * Begin resolving a panel runtime image when its entity becomes active.
   * The supplied factory is lazy so duplicate entity activations and HTTP
   * requests share one build flight without even asking BuildV2 twice.
   */
  primeBuild(
    source: string,
    ref: string | undefined,
    getBuild: () => Promise<StoredBuildResult>
  ): Promise<void> {
    return this.ensureBuild(source, ref, getBuild) ?? Promise.resolve();
  }

  async stop(): Promise<void> {
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    try {
      await this.transport.close();
    } finally {
      this.port = null;
    }
  }

  // =========================================================================
  // Gateway in-process handlers
  // =========================================================================

  /** Handle an HTTP request from the gateway (in-process dispatch). */
  handleGatewayRequest(
    req: import("http").IncomingMessage,
    res: import("http").ServerResponse
  ): void {
    this.handleRequest(req, res).catch((err) => {
      log.warn(`Request handler error: ${err}`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal Server Error");
      }
    });
  }

  /** Handle a WebSocket upgrade from the gateway (CDP bridge). */
  handleGatewayUpgrade(
    req: import("http").IncomingMessage,
    socket: import("stream").Duplex,
    head: Buffer
  ): void {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (this.workerdInspectorBridge?.isInspectorPath(pathname) && this.wss) {
      this.workerdInspectorBridge.handleUpgrade(req, socket, head, this.wss);
      return;
    }
    if (this.cdpBridge && this.wss) {
      this.cdpBridge.handleUpgrade(req, socket, head, this.wss);
    } else {
      socket.destroy();
    }
  }

  // =========================================================================
  // Request routing
  // =========================================================================

  private async handleRequest(
    req: import("http").IncomingMessage,
    res: import("http").ServerResponse
  ): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;

    const sharedStyleMatch = pathname.match(/^\/__vibestudio\/shared-style\/([0-9a-f]{64})\.css$/u);
    if (sharedStyleMatch) {
      const digest = assertPresent(sharedStyleMatch[1]);
      let shared = this.sharedStyleAssets.get(digest);
      if (!shared) {
        const result = await this.callbacks?.findSharedStyleBuild(digest);
        if (result) {
          const build = this.cachedBuild(result);
          this.registerSharedStyles(build);
          shared = this.sharedStyleAssets.get(digest);
          if (!shared) {
            const artifact = build.artifacts.find(
              (entry) => entry.role === "shared-style" && entry.integrity === `sha256-${digest}`
            );
            if (artifact) shared = { build, artifact };
          }
        }
      }
      if (!shared) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Shared style not found");
        return;
      }
      await this.writeArtifact(req, res, shared.build, shared.artifact);
      return;
    }

    if (pathname === "/__vibestudio/unit-icon") {
      const source = url.searchParams.get("source");
      const artifactPath = url.searchParams.get("path");
      const version = url.searchParams.get("v");
      const state = url.searchParams.get("s");
      if (!source || !artifactPath || artifactPath.startsWith("/") || artifactPath.includes("..")) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Invalid unit icon request");
        return;
      }
      if (version !== null && !/^[0-9a-f]{8,64}$/u.test(version)) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Invalid unit icon version");
        return;
      }
      if (state !== null && !/^state:[0-9a-f]{64}$/u.test(state)) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Invalid unit icon state");
        return;
      }
      try {
        const icon = await this.callbacks?.getUnitIcon(source, artifactPath, state ?? undefined);
        if (!icon) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Unit icon not found");
          return;
        }
        if (version && !icon.contentHash.startsWith(version)) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Unit icon version not found");
          return;
        }
        const etag = `"${icon.contentHash}"`;
        // `v` names verified content bytes. `s` selects the immutable workspace
        // state from which those bytes must be read. Either coordinate is enough
        // to make the response immutable. This is
        // the difference between a client storing the icon once and re-fetching
        // every unit's icon on every launcher render. Measured on a phone, the
        // revalidating form was 20 of 57 round trips for one panel open.
        //
        const versioned = version !== null || state !== null;
        const headers = {
          "Cache-Control": versioned ? "public, max-age=31536000, immutable" : "private, no-cache",
          ETag: etag,
          "X-Content-Type-Options": "nosniff",
        };
        if (requestAcceptsEtag(req, etag)) {
          res.writeHead(304, headers);
          res.end();
          return;
        }
        res.writeHead(200, {
          ...headers,
          "Content-Type": icon.contentType,
          "Content-Length": icon.body.byteLength,
        });
        res.end(icon.body);
      } catch (error) {
        log.warn(`Unit icon resolution failed for ${source}: ${String(error)}`);
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Unit icon unavailable");
      }
      return;
    }

    const activatedArtifactMatch = pathname.match(
      /^\/__vibestudio\/panel-build\/([0-9a-f]{64})(\/.*)$/u
    );
    if (activatedArtifactMatch) {
      const buildKey = assertPresent(activatedArtifactMatch[1]);
      const resource = assertPresent(activatedArtifactMatch[2]);
      const build = await this.resolveActivatedBuild(res, buildKey);
      if (!build) return;
      // Prefetch surfaces live INSIDE the build-pinned namespace on purpose:
      // that path is already reachable from the panel origin and already
      // content-addressed by its build key, so they inherit the existing
      // allowlist and add no new authority surface. A remote client that would
      // otherwise spend one round trip per subresource (~92 of them, each ~6ms
      // of server work against ~560ms observed) asks for the inventory once and
      // then for exactly what it lacks, once.
      if (resource === "/__manifest.json") {
        this.transport.writeManifest(res, build, this.runtimeHelperSet);
        return;
      }
      if (resource === "/__bundle" || resource.startsWith("/__bundle?")) {
        await this.transport.writeBundle(req, res, build, {
          gzip: bundleWantsGzip(req),
          runtimeHelpers: this.runtimeHelperSet,
        });
        return;
      }
      await this.servePanelResource(req, res, build, resource);
      return;
    }

    // ── Static runtime helpers ────────────────────────────────────────────
    if (await this.serveRuntimeHelper(pathname, url, req, res)) {
      return;
    }

    // ── Favicon ─────────────────────────────────────────────────────────
    if (pathname === "/favicon.ico" || pathname === "/favicon.svg") {
      this.serveFavicon(pathname, res);
      return;
    }

    const parsed = extractSourcePath(pathname);
    if (parsed) {
      if (await this.serveRuntimeHelper(parsed.resource, url, req, res)) {
        return;
      }
      const contextId =
        url.searchParams.get("contextId") || this.contextIdFromReferer(req) || undefined;
      const routeLabel = contextId || parsed.source;
      // `contextId` is panel/runtime identity, not necessarily a VCS head.
      // Only an explicit ref selects a non-main build.
      const ref = url.searchParams.get("ref") || this.refFromReferer(req) || undefined;
      const buildKey =
        url.searchParams.get("buildKey") || this.buildKeyFromReferer(req) || undefined;
      this.logPanelResourceRequest(req, res, parsed.source, parsed.resource, routeLabel);
      if (buildKey) {
        await this.resolveAndServeActivatedBuild(
          req,
          res,
          parsed.source,
          parsed.resource,
          buildKey
        );
      } else {
        await this.resolveAndServeBuild(req, res, parsed.source, routeLabel, parsed.resource, ref);
      }
      return;
    }

    // ── Index page ────────────────────────────────────────────────────────
    if (pathname === "/" || pathname === "/index.html") {
      this.serveIndex(res);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }

  private logPanelResourceRequest(
    req: import("http").IncomingMessage,
    res: import("http").ServerResponse,
    source: string,
    resource: string,
    routeLabel: string
  ): void {
    if (!shouldLogPanelResourceRequests()) return;
    const startedAt = Date.now();
    const method = req.method ?? "GET";
    const userAgent = req.headers["user-agent"];
    res.once("finish", () => {
      const durationMs = Date.now() - startedAt;
      const client =
        typeof userAgent === "string" && userAgent.includes("Vibestudio-Mobile") ? "mobile" : "web";
      log.info(
        `Panel resource ${method} ${source}${resource} route=${routeLabel} ` +
          `status=${res.statusCode} durationMs=${durationMs} client=${client}`
      );
    });
  }

  // =========================================================================
  // Build resolution (single source of truth)
  // =========================================================================

  /**
   * Resolve the current build for a source via getBuild callback.
   *
   * The build system (buildStore + EV recompute) is the single source of truth
   * for builds. This method always goes through it to ensure freshness, then
   * updates servingCache so sub-resource requests are served fast.
   *
   * Entity activation normally starts this build before the browser navigates.
   * A direct HTTP request remains a valid fallback and starts the same
   * deduplicated flight. The response waits for the requested artifact rather
   * than returning an HTML `202` placeholder for an asset request.
   */
  private async resolveAndServeBuild(
    req: import("http").IncomingMessage,
    res: import("http").ServerResponse,
    source: string,
    panelLabel: string,
    resource: string,
    ref?: string
  ): Promise<void> {
    const flightKey = this.buildCacheKey(source, ref);

    const cached = this.servingCache.get(flightKey);
    if (cached) {
      await this.servePanelResource(req, res, cached, resource);
      return;
    }

    const flight = this.ensureBuild(source, ref);
    if (!flight) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Panel build service unavailable");
      return;
    }
    await flight;

    const build = this.servingCache.get(flightKey);
    if (build) {
      await this.servePanelResource(req, res, build, resource);
      return;
    }

    const error = this.buildErrors.get(flightKey);
    if (error && (resource === "/" || resource === "/index.html")) {
      this.serveBuildErrorPage(res, source, error);
      return;
    }
    res.writeHead(error ? 500 : 404, { "Content-Type": "text/plain" });
    res.end(error ?? `Panel artifact not found: ${panelLabel}${resource}`);
  }

  private ensureBuild(
    source: string,
    ref?: string,
    getBuild?: () => Promise<StoredBuildResult>
  ): Promise<void> | null {
    const flightKey = this.buildCacheKey(source, ref);
    if (this.servingCache.has(flightKey)) return Promise.resolve();
    const existing = this.buildInFlight.get(flightKey);
    if (existing) return existing;

    const defaultGetBuild = this.callbacks?.getBuild;
    const factory = getBuild ?? (defaultGetBuild ? () => defaultGetBuild(source, ref) : null);
    if (!factory) return null;

    const promise = Promise.resolve()
      .then(factory)
      .then((result) => {
        this.storeBuild(source, result, ref);
        this.buildErrors.delete(flightKey);
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        log.info(`Build failed for ${flightKey}: ${msg}`);
        this.buildErrors.set(flightKey, msg);
        this.callbacks?.onBuildComplete?.(source, msg);
      })
      .finally(() => {
        this.buildInFlight.delete(flightKey);
      });
    this.buildInFlight.set(flightKey, promise);
    return promise;
  }

  private buildCacheKey(source: string, ref?: string): string {
    return ref ? `${source}@${ref}` : source;
  }

  private async serveRuntimeHelper(
    pathname: string,
    url: URL,
    req: import("http").IncomingMessage,
    res: import("http").ServerResponse
  ): Promise<boolean> {
    const helper = this.runtimeHelperSet.helpers.find((entry) => `/${entry.path}` === pathname);
    if (!helper) return false;
    const versioned = url.searchParams.get("v") === this.runtimeHelperSet.version;
    const encoding =
      helper.body.length >= 1_024 ? preferredContentEncoding(req.headers["accept-encoding"]) : null;
    const encoded = encoding
      ? await this.transport.compressed(
          `sha256-${helper.integrity}`,
          helper.path,
          helper.body,
          encoding
        )
      : null;
    res.writeHead(200, {
      "Content-Type": helper.contentType,
      "Content-Length": encoded?.length ?? helper.body.length,
      "Cache-Control": versioned ? "public, max-age=31536000, immutable" : "no-store",
      Vary: "Accept-Encoding",
      ...(encoding && encoded ? { "Content-Encoding": encoding } : {}),
    });
    res.end(encoded ?? helper.body.toString("utf8"));
    return true;
  }

  private refFromReferer(req: import("http").IncomingMessage): string | null {
    const referer = req.headers.referer;
    if (typeof referer !== "string") return null;
    try {
      const parsed = new URL(referer);
      return parsed.searchParams.get("ref");
    } catch {
      return null;
    }
  }

  private buildKeyFromReferer(req: import("http").IncomingMessage): string | null {
    const referer = req.headers.referer;
    if (typeof referer !== "string") return null;
    try {
      return new URL(referer).searchParams.get("buildKey");
    } catch {
      return null;
    }
  }

  private async resolveAndServeActivatedBuild(
    req: import("http").IncomingMessage,
    res: import("http").ServerResponse,
    source: string,
    resource: string,
    buildKey: string
  ): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(buildKey)) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Invalid panel build key");
      return;
    }

    const build = await this.resolveActivatedBuild(res, buildKey);
    if (!build) return;

    if (build.metadata.kind !== "panel" || build.metadata.sourcePath !== source) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end(`Activated build ${buildKey} does not belong to panel ${source}`);
      return;
    }
    await this.serveActivatedPanelResource(req, res, build, resource, buildKey);
  }

  private cachedBuild(result: StoredBuildResult): CachedBuild {
    const htmlArtifact = result.artifacts.find((artifact) => artifact.role === "html");
    const primaryArtifact = result.artifacts.find((artifact) => artifact.role === "primary");
    if (!htmlArtifact || !primaryArtifact)
      throw new Error(`Activated panel build ${result.buildKey} is incomplete`);
    return {
      dir: result.dir,
      artifacts: result.artifacts,
      htmlArtifact,
      metadata: result.metadata,
      revision: ++this.buildRevisionCounter,
    };
  }

  private async resolveActivatedBuild(
    res: import("http").ServerResponse,
    buildKey: string
  ): Promise<CachedBuild | null> {
    let build = this.activatedBuildCache.get(buildKey);
    if (!build) {
      const result = (await this.callbacks?.getBuildByKey(buildKey)) ?? null;
      if (!result) {
        res.writeHead(410, { "Content-Type": "text/plain" });
        res.end(`Activated panel build is unavailable: ${buildKey}`);
        return null;
      }
      if (result.buildKey !== buildKey || result.metadata.buildKey !== buildKey) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Immutable panel build store returned a mismatched artifact");
        return null;
      }
      const htmlArtifact = result.artifacts.find((artifact) => artifact.role === "html");
      const primaryArtifact = result.artifacts.find((artifact) => artifact.role === "primary");
      if (!htmlArtifact || !primaryArtifact) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end(`Activated panel build ${buildKey} is incomplete`);
        return null;
      }
      build = {
        dir: result.dir,
        artifacts: result.artifacts,
        htmlArtifact,
        metadata: result.metadata,
        revision: ++this.buildRevisionCounter,
      };
      this.activatedBuildCache.set(buildKey, build);
      this.registerSharedStyles(build);
      this.transport.warm(build);
    }
    return build;
  }

  /**
   * Serve one file of an immutable app build: `/_a/<buildKey>/<path>`, its
   * inventory, or its bundle. The caller has already decided the build is one
   * this host serves. The bytes follow the same protocol as a panel build's.
   */
  async serveAppArtifact(
    req: import("http").IncomingMessage,
    res: import("http").ServerResponse,
    buildKey: string,
    remainderPath: string
  ): Promise<void> {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "Content-Type": "text/plain" });
      res.end("Method Not Allowed");
      return;
    }
    const build = await this.requireCallbacks().getBuildByKey(buildKey);
    const clean = decodeURIComponent(remainderPath.replace(/^\/+/, "")) || "index.html";
    const artifactPath =
      path.isAbsolute(clean) || clean.split(/[\\/]/).includes("..")
        ? "__invalid__"
        : clean.replace(/\\/g, "/");
    if (build && artifactPath === "__manifest.json") {
      this.transport.writeManifest(res, build);
      return;
    }
    if (build && artifactPath === "__bundle") {
      await this.transport.writeBundle(req, res, build, { gzip: bundleWantsGzip(req) });
      return;
    }
    const artifact = build?.artifacts.find((entry) => entry.path === artifactPath);
    if (!build || !artifact) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("App artifact not found");
      return;
    }
    await this.writeArtifact(req, res, build, artifact, true);
  }

  private async serveActivatedPanelResource(
    req: import("http").IncomingMessage,
    res: import("http").ServerResponse,
    build: CachedBuild,
    resource: string,
    buildKey: string
  ): Promise<void> {
    if (resource === "/" || resource === "/index.html") {
      // Panel URLs may be mounted below a routed-workspace prefix. Keep
      // immutable artifacts relative to the panel source route so the browser
      // does not escape to the developer hub root.
      const prefix = `../../__vibestudio/panel-build/${buildKey}/`;
      const artifactPaths = new Set(
        build.artifacts
          .filter((artifact) => artifact.role !== "html")
          .map((artifact) => artifact.path)
      );
      const content = (await this.readArtifactText(build, build.htmlArtifact)).replace(
        /\b(src|href|data-bundle-src)=(["'])(?:\.\/)?([^"'?#]+)([^"']*)\2/giu,
        (match, attribute: string, quote: string, path: string, suffix: string) =>
          artifactPaths.has(path) ? `${attribute}=${quote}${prefix}${path}${suffix}${quote}` : match
      );
      await this.writeArtifact(req, res, build, build.htmlArtifact, true, content);
      return;
    }
    const artifactPath = resource.replace(/^\/+/, "");
    const artifactDirectoryDepth = Math.max(0, artifactPath.split("/").length - 1);
    const sourceRoot = "../".repeat(2 + artifactDirectoryDepth);
    res.writeHead(307, {
      Location: `${sourceRoot}__vibestudio/panel-build/${buildKey}/${artifactPath}`,
      "Cache-Control": "no-store",
    });
    res.end();
  }

  private contextIdFromReferer(req: import("http").IncomingMessage): string | null {
    const referer = req.headers.referer;
    if (typeof referer !== "string") return null;
    try {
      const parsed = new URL(referer);
      return parsed.searchParams.get("contextId");
    } catch {
      return null;
    }
  }

  // =========================================================================
  // Building / error pages
  // =========================================================================

  /**
   * Serve a build error page instead of looping on a failed build.
   */
  private serveBuildErrorPage(
    res: import("http").ServerResponse,
    source: string,
    error: string
  ): void {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Build Error — Vibestudio</title>
  <link rel="icon" type="image/x-icon" href="/favicon.ico">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" sizes="any">
  <style>
    :root {
      color-scheme: light dark;
      --page-bg: #ffffff;
      --heading: #0e1a2d;
      --muted: #445166;
      --accent: #1d4db4;
      --error-bg: #fff1f2;
      --error-border: #fecdd3;
      --error-text: #b91c1c;
      --mark-light-display: block;
      --mark-dark-display: none;
    }
    html { min-height: 100%; background: var(--page-bg); }
    body { box-sizing: border-box; min-height: 100vh; font-family: ui-sans-serif, system-ui, sans-serif; max-width: 600px; margin: 0 auto; padding: 4rem 1rem; text-align: center; color: var(--heading); }
    h1 { color: var(--heading); font-size: 1.5rem; }
    p { color: var(--muted); line-height: 1.6; }
    code { color: var(--accent); }
    pre { background: var(--error-bg); border: 1px solid var(--error-border); padding: 1rem; border-radius: 4px; text-align: left; overflow-x: auto; font-size: 0.85rem; color: var(--error-text); }
    a { color: var(--accent); }
    .brand-mark { width: 74px; height: 74px; margin: 0 auto 1.25rem; }
    .brand-mark img { display: block; width: 100%; height: 100%; object-fit: contain; }
    .brand-mark .mark-light { display: var(--mark-light-display); }
    .brand-mark .mark-dark { display: var(--mark-dark-display); }
    @media (prefers-color-scheme: dark) {
      :root {
        --page-bg: #111419;
        --heading: #eef1f6;
        --muted: #b1bbcb;
        --accent: #9dbaff;
        --error-bg: #171b22;
        --error-border: #434d5f;
        --error-text: #fecaca;
        --mark-light-display: none;
        --mark-dark-display: block;
      }
    }
  </style>
</head>
<body>
  <div class="brand-mark"><img class="mark-light" src="${getBrandAssets().symbolLightDataUrl}" alt="" aria-hidden="true"><img class="mark-dark" src="${getBrandAssets().symbolDarkDataUrl}" alt="" aria-hidden="true"></div>
  <h1>Build Failed</h1>
  <p>The panel <code>${escapeHtml(source)}</code> failed to build:</p>
  <pre>${escapeHtml(error)}</pre>
  <p><a href="http://127.0.0.1:${this.port}/">View active panels</a></p>
</body>
</html>`;

    res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  }

  // =========================================================================
  // Panel resource serving
  // =========================================================================

  private async servePanelResource(
    req: import("http").IncomingMessage,
    res: import("http").ServerResponse,
    build: CachedBuild,
    resource: string
  ): Promise<void> {
    const artifact = this.resolvePanelArtifact(build, resource);
    if (artifact) {
      await this.writeArtifact(req, res, build, artifact);
      return;
    }

    if (isPanelAssetRequest(resource)) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    // ── SPA catch-all ──
    // Unknown paths on a panel's source prefix get the panel HTML so
    // client-side routing (pushState) works.
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Vibestudio-Build-Revision": String(build.revision),
    });
    res.end(await this.transport.readBytes(build, build.htmlArtifact));
  }

  private resolvePanelArtifact(
    build: CachedBuild,
    resource: string
  ): BuildArtifactManifestEntry | null {
    if (resource === "/" || resource === "/index.html") return build.htmlArtifact;
    const normalized = resource.replace(/^\/+/, "");
    return build.artifacts.find((artifact) => artifact.path === normalized) ?? null;
  }

  private registerSharedStyles(build: CachedBuild): void {
    for (const style of build.metadata.sharedStyles ?? []) {
      if (
        !/^[0-9a-f]{64}$/u.test(style.digest) ||
        style.url !== `../../__vibestudio/shared-style/${style.digest}.css`
      ) {
        throw new Error(`Build ${build.metadata.buildKey} has an invalid shared style reference`);
      }
      const artifact = build.artifacts.find(
        (candidate) =>
          candidate.role === "shared-style" &&
          candidate.contentType === style.contentType &&
          candidate.integrity === `sha256-${style.digest}`
      );
      if (!artifact) {
        throw new Error(`Build ${build.metadata.buildKey} is missing shared style ${style.digest}`);
      }
      this.sharedStyleAssets.set(style.digest, { build, artifact });
    }
  }

  /**
   * The one way build-pinned bytes leave this server, for panels and apps.
   *
   * The representation is chosen by `Accept-Encoding` (br, gzip or identity;
   * bodies under 1 KiB stay identity) and is the same canonical bytes on every
   * request. That makes a byte `Range` taken from one response valid against the
   * next, so a client on a flaky link resumes with `Range` (and `If-Range` to
   * guard against a changed representation) instead of a private header: the
   * range applies to the selected, encoded representation, as HTTP defines it.
   */
  private async writeArtifact(
    req: import("http").IncomingMessage,
    res: import("http").ServerResponse,
    build: TransportBuild & { revision?: number },
    artifact: BuildArtifactManifestEntry,
    immutableDocument = false,
    contentOverride?: string | Buffer
  ): Promise<void> {
    // A build-pinned entry document is as immutable as its subresources. The
    // unpinned developer entry remains a mutable pointer and must not be cached.
    const cacheControl =
      artifact.role === "html" && !immutableDocument
        ? "no-store"
        : "public, max-age=31536000, immutable";
    const identity =
      contentOverride === undefined
        ? await this.transport.readBytes(build, artifact)
        : Buffer.isBuffer(contentOverride)
          ? contentOverride
          : Buffer.from(contentOverride);
    const encoding =
      identity.length >= 1_024 ? preferredContentEncoding(req.headers["accept-encoding"]) : null;
    const encoded = encoding
      ? await this.transport.compressed(
          contentOverride === undefined ? artifact.integrity : undefined,
          artifact.path,
          identity,
          encoding
        )
      : null;
    const body = encoded ?? identity;
    const headers: Record<string, string | number> = {
      "Content-Type": artifact.contentType,
      "Cache-Control": cacheControl,
      Vary: "Accept-Encoding",
      "Accept-Ranges": "bytes",
      ...(encoded && encoding ? { "Content-Encoding": encoding } : {}),
      ...(build.revision === undefined ? {} : { "X-Vibestudio-Build-Revision": build.revision }),
    };
    // Only the build's own bytes carry a digest identity; a rewritten document does not.
    const etag =
      contentOverride === undefined && artifact.integrity
        ? `"${artifact.integrity}${encoded && encoding ? `;${encoding}` : ""}"`
        : null;
    if (etag && artifact.integrity) {
      headers["ETag"] = etag;
      headers["X-Vibestudio-Content-Digest"] = artifact.integrity;
    }
    if (artifact.role === "html" && build.metadata.kind === "client") {
      headers["Content-Security-Policy"] = CLIENT_DOCUMENT_CSP;
    }

    const range = this.requestedRange(req, etag, body.length);
    if (range === "unsatisfiable") {
      res.writeHead(416, {
        ...headers,
        "Content-Range": `bytes */${body.length}`,
        "Content-Length": 0,
      });
      res.end();
      return;
    }
    if (range) {
      const partial = body.subarray(range.start, range.end + 1);
      res.writeHead(206, {
        ...headers,
        "Content-Range": `bytes ${range.start}-${range.end}/${body.length}`,
        "Content-Length": partial.length,
      });
      res.end(req.method === "HEAD" ? undefined : partial);
      return;
    }
    res.writeHead(200, { ...headers, "Content-Length": body.length });
    res.end(
      req.method === "HEAD"
        ? undefined
        : encoded
          ? encoded
          : artifact.encoding === "utf8"
            ? identity.toString("utf8")
            : identity
    );
  }

  /** A single byte range over the selected representation, if one was asked for and still applies. */
  private requestedRange(
    req: import("http").IncomingMessage,
    etag: string | null,
    size: number
  ): { start: number; end: number } | "unsatisfiable" | null {
    const header = req.headers.range;
    if (typeof header !== "string") return null;
    // If-Range ties the range to the representation the client already holds; a
    // different one is sent whole rather than spliced onto the old bytes.
    const ifRange = req.headers["if-range"];
    if (typeof ifRange === "string" && ifRange !== etag) return null;
    const match = /^bytes=(\d+)-(\d*)$/u.exec(header);
    const start = match ? Number(match[1]) : Number.NaN;
    const requestedEnd = match?.[2] ? Number(match[2]) : size - 1;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(requestedEnd) ||
      requestedEnd < start ||
      start >= size
    ) {
      return "unsatisfiable";
    }
    return { start, end: Math.min(requestedEnd, size - 1) };
  }

  private requireCallbacks(): PanelHttpCallbacks {
    if (!this.callbacks) throw new Error("Panel HTTP callbacks are not connected");
    return this.callbacks;
  }

  private async readArtifactText(
    build: CachedBuild,
    artifact: BuildArtifactManifestEntry
  ): Promise<string> {
    if (artifact.encoding !== "utf8") {
      throw new Error(`Artifact ${artifact.path} is not UTF-8 text`);
    }
    return (await this.transport.readBytes(build, artifact)).toString("utf8");
  }

  // =========================================================================
  // Static pages
  // =========================================================================

  private serveIndex(res: import("http").ServerResponse): void {
    const origin = `http://127.0.0.1:${this.port}`;
    // Launchable panels: from the source registry (loopback asset façade).
    const allEntries = Array.from(this.sourceRegistry.entries()).map(([source, { name }]) => {
      return `<li>
  <a href="${origin}/${escapeHtml(source)}/">${escapeHtml(name)}</a>
  <small class="sub">${escapeHtml(source)}</small>
</li>`;
    });

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Vibestudio Panels</title>
  <link rel="icon" type="image/x-icon" href="/favicon.ico">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" sizes="any">
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; max-width: 600px; margin: 2rem auto; padding: 0 1rem; color: #0e1a2d; background: #ffffff; }
    h1 { color: #0e1a2d; }
    code { background: #f6f8fb; border: 1px solid #ccd4e0; padding: 0.1em 0.4em; border-radius: 4px; font-size: 0.8em; color: #0e1a2d; }
    ul { list-style: none; padding: 0; }
    li { margin: 0.8rem 0; padding: 0.8rem 0; border-bottom: 1px solid #ccd4e0; }
    a { color: #1d4db4; text-decoration: none; font-weight: 600; }
    a:hover { text-decoration: underline; }
    .brand-header { display: flex; align-items: center; gap: 1rem; margin: 0 0 1.5rem; }
    .brand-mark { width: 58px; height: 58px; }
    .brand-mark img { display: block; width: 100%; height: 100%; object-fit: contain; }
    .brand-mark .mark-dark { display: none; }
    .sub { color: #445166; margin-left: 0.5em; }
    .empty { color: #445166; }
    .badge { font-size: 0.7em; padding: 0.15em 0.5em; border-radius: 3px; margin-left: 0.5em; text-transform: uppercase; font-weight: 600; }
    .badge.running { background: #1b5e20; color: #81c784; }
    @media (prefers-color-scheme: dark) {
      body { color: #eef1f6; background: #111419; }
      h1 { color: #eef1f6; }
      code { background: #252b36; border-color: #434d5f; color: #eef1f6; }
      li { border-bottom-color: #434d5f; }
      a { color: #9dbaff; }
      .sub, .empty { color: #b1bbcb; }
      .brand-mark .mark-light { display: none; }
      .brand-mark .mark-dark { display: block; }
    }
  </style>
</head>
<body>
  <div class="brand-header">
    <div class="brand-mark"><img class="mark-light" src="${getBrandAssets().symbolLightDataUrl}" alt="" aria-hidden="true"><img class="mark-dark" src="${getBrandAssets().symbolDarkDataUrl}" alt="" aria-hidden="true"></div>
    <h1>Vibestudio Panels</h1>
  </div>
  ${
    allEntries.length > 0
      ? `<ul>${allEntries.join("\n")}</ul>`
      : `<p class="empty">No panels available. Add panels to the workspace <code>panels/</code> directory.</p>`
  }
</body>
</html>`;

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  }

  private serveFavicon(pathname: string, res: import("http").ServerResponse): void {
    const brand = getBrandAssets();
    const [body, contentType] =
      pathname === "/favicon.svg"
        ? [brand.faviconSvg, "image/svg+xml; charset=utf-8"]
        : pathname === "/favicon.ico"
          ? [brand.faviconIco, "image/x-icon"]
          : [brand.faviconPng, "image/png"];
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": body.length,
      "Cache-Control": "public, max-age=86400",
    });
    res.end(body);
  }
}

function requestAcceptsEtag(req: import("http").IncomingMessage, etag: string): boolean {
  const header = req.headers["if-none-match"];
  const values: string[] = Array.isArray(header) ? header : header ? [header] : [];
  return values.some((value) =>
    value.split(",").some((candidate) => {
      const normalized = candidate.trim();
      return normalized === "*" || normalized === etag || normalized === `W/${etag}`;
    })
  );
}
