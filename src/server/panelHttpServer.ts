/**
 * PanelHttpServer — source/ref-keyed static panel asset server.
 *
 * Panel identity is injected by the host shell before app code runs, so this
 * server resolves source builds and serves static assets from path-based URLs.
 */

import * as fs from "fs";
import * as path from "path";
import * as zlib from "node:zlib";
import { WebSocketServer } from "ws";
import { createDevLogger } from "@vibestudio/dev-log";
import type {
  BuildArtifactManifestEntry,
  BuildResult,
  BuildMetadata,
} from "./buildV2/buildStore.js";
import { artifactFilePath } from "./buildV2/buildStore.js";
import type { CdpBridge } from "./cdpBridge.js";
import { PANEL_BOOTSTRAP_SCRIPT } from "./panelBootstrapScript.js";
import { assertPresent } from "../lintHelpers";
import { TransportDerivativeCache } from "./buildV2/transportDerivativeCache.js";

const log = createDevLogger("PanelHttpServer");

declare const __dirname: string | undefined;

// ---------------------------------------------------------------------------
// Pre-compiled browser transport + context bootstrap
// ---------------------------------------------------------------------------

function loadBrowserTransport(): string {
  const transportCandidates = [
    typeof __dirname !== "undefined" && __dirname
      ? path.join(__dirname, "browserTransport.js")
      : null,
    path.join(process.cwd(), "dist", "browserTransport.js"),
    path.join(process.cwd(), "src", "server", "browserTransport.js"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const transportPath of transportCandidates) {
    try {
      return fs.readFileSync(transportPath, "utf-8");
    } catch {
      // Try the next runtime layout.
    }
  }

  log.info(`[PanelHttpServer] Browser transport not found, using inline stub`);
  return `console.warn("[Vibestudio] Browser transport not available — panel RPC will not work.");`;
}

const BROWSER_TRANSPORT_JS = loadBrowserTransport();

function loadBrandAsset(filename: string): Buffer | null {
  const candidates = [
    typeof __dirname !== "undefined" && __dirname
      ? path.join(__dirname, "assets", "brand", filename)
      : null,
    path.join(process.cwd(), "dist", "assets", "brand", filename),
    path.join(process.cwd(), "build-resources", "brand", filename),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const assetPath of candidates) {
    try {
      return fs.readFileSync(assetPath);
    } catch {
      // Try the next runtime layout.
    }
  }
  return null;
}

const BRAND_FAVICON_ICO = loadBrandAsset("favicon.ico");
const BRAND_FAVICON_PNG = loadBrandAsset("favicon-64.png");
const BRAND_FAVICON_SVG = loadBrandAsset("favicon.svg");
const DEFAULT_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><linearGradient id="g" x1="5" y1="4" x2="27" y2="28"><stop stop-color="#6D28D9"/><stop offset="1" stop-color="#EC4899"/></linearGradient></defs><rect width="32" height="32" rx="7" fill="#100B18"/><path d="M23 8C12 5 6 11 9 18c2 4 8 4 12 3M10 23c8 5 16 0 13-7-2-4-6-5-10-4" fill="none" stroke="url(#g)" stroke-width="4" stroke-linecap="round"/></svg>`;
const BRAND_SYMBOL_SVG = loadBrandAsset("vibestudio-symbol.svg");
const DEFAULT_BRAND_SYMBOL_SVG = DEFAULT_FAVICON_SVG;
const BRAND_SYMBOL_DATA_URL = `data:image/svg+xml;base64,${(
  BRAND_SYMBOL_SVG ?? Buffer.from(DEFAULT_BRAND_SYMBOL_SVG)
).toString("base64")}`;

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
  getBuild(source: string, ref?: string): Promise<BuildResult>;

  /** Resolve an already-built immutable artifact selected by runtime activation. */
  getBuildByKey(buildKey: string): BuildResult | null;
}

/** Build output cached by source path (shared across panels) */
interface CachedBuild {
  dir: string;
  artifacts: Array<BuildArtifactManifestEntry & { content: string }>;
  htmlArtifact: BuildArtifactManifestEntry & { content: string };
  metadata: BuildMetadata;
  revision: number;
  compressedArtifacts: Map<string, Promise<Buffer>>;
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

type PanelContentEncoding = "br" | "gzip";

function preferredContentEncoding(
  value: string | string[] | undefined
): PanelContentEncoding | null {
  if (!value) return null;
  const accepted = (Array.isArray(value) ? value.join(",") : value)
    .split(",")
    .map((part) => {
      const [name, ...parameters] = part.trim().toLowerCase().split(";");
      const q = parameters
        .map((parameter) => parameter.trim())
        .find((parameter) => parameter.startsWith("q="));
      return { name, quality: q ? Number(q.slice(2)) : 1 };
    })
    .filter(({ quality }) => Number.isFinite(quality) && quality > 0);
  const quality = (encoding: PanelContentEncoding) =>
    Math.max(0, ...accepted.filter(({ name }) => name === encoding).map(({ quality }) => quality));
  const brotliQuality = quality("br");
  const gzipQuality = quality("gzip");
  if (brotliQuality === 0 && gzipQuality === 0) return null;
  return brotliQuality >= gzipQuality ? "br" : "gzip";
}

function compressArtifact(body: Buffer, encoding: PanelContentEncoding): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const callback = (error: Error | null, result: Buffer) => {
      if (error) reject(error);
      else resolve(result);
    };
    if (encoding === "br") {
      zlib.brotliCompress(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } }, callback);
      return;
    }
    zlib.gzip(body, { level: zlib.constants.Z_BEST_SPEED }, callback);
  });
}

// ---------------------------------------------------------------------------
// PanelHttpServer
// ---------------------------------------------------------------------------

export class PanelHttpServer {
  constructor(private readonly transportDerivativeCache = new TransportDerivativeCache()) {}

  /** Serving cache: source/ref -> resolved build (for fast sub-resource serving within a page load) */
  private servingCache = new Map<string, CachedBuild>();

  /** Immutable activated artifacts. Never invalidated by a later source build. */
  private activatedBuildCache = new Map<string, CachedBuild>();

  /** Digest-addressed base styles shared by every panel URL. */
  private sharedStyleAssets = new Map<
    string,
    {
      build: CachedBuild;
      artifact: BuildArtifactManifestEntry & { content: string };
    }
  >();

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
    // WSS in noServer mode — gateway calls handleGatewayUpgrade for CDP.
    this.wss = new WebSocketServer({ noServer: true });
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
  storeBuild(source: string, buildResult: BuildResult, ref?: string): void {
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
      compressedArtifacts: new Map<string, Promise<Buffer>>(),
    };
    this.servingCache.set(this.buildCacheKey(source, ref), cachedBuild);
    this.activatedBuildCache.set(buildResult.buildKey, cachedBuild);
    this.registerSharedStyles(cachedBuild);
    this.scheduleTransportDerivatives(cachedBuild);

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
    getBuild: () => Promise<BuildResult>
  ): Promise<void> {
    return this.ensureBuild(source, ref, getBuild) ?? Promise.resolve();
  }

  async stop(): Promise<void> {
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    this.port = null;
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
      const shared = this.sharedStyleAssets.get(digest);
      if (!shared) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Shared style not found");
        return;
      }
      await this.writeArtifact(req, res, shared.build, shared.artifact);
      return;
    }

    const activatedArtifactMatch = pathname.match(
      /^\/__vibestudio\/panel-build\/([0-9a-f]{64})(\/.*)$/u
    );
    if (activatedArtifactMatch) {
      const buildKey = assertPresent(activatedArtifactMatch[1]);
      const resource = assertPresent(activatedArtifactMatch[2]);
      const build = this.resolveActivatedBuild(res, buildKey);
      if (build) await this.servePanelResource(req, res, build, resource);
      return;
    }

    // ── Static runtime helpers ────────────────────────────────────────────
    if (this.serveRuntimeHelper(pathname, res)) {
      return;
    }

    // ── Favicon ─────────────────────────────────────────────────────────
    if (pathname === "/favicon.ico" || pathname === "/favicon.svg") {
      this.serveFavicon(pathname, res);
      return;
    }

    const parsed = extractSourcePath(pathname);
    if (parsed) {
      if (this.serveRuntimeHelper(parsed.resource, res)) {
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
    getBuild?: () => Promise<BuildResult>
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

  private serveRuntimeHelper(pathname: string, res: import("http").ServerResponse): boolean {
    if (pathname === "/__loader.js") {
      res.writeHead(200, {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(PANEL_BOOTSTRAP_SCRIPT);
      return true;
    }
    if (pathname === "/__transport.js") {
      res.writeHead(200, {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(BROWSER_TRANSPORT_JS);
      return true;
    }
    return false;
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

    const build = this.resolveActivatedBuild(res, buildKey);
    if (!build) return;

    if (build.metadata.kind !== "panel" || build.metadata.sourcePath !== source) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end(`Activated build ${buildKey} does not belong to panel ${source}`);
      return;
    }
    await this.serveActivatedPanelResource(req, res, build, resource, buildKey);
  }

  private resolveActivatedBuild(
    res: import("http").ServerResponse,
    buildKey: string
  ): CachedBuild | null {
    let build = this.activatedBuildCache.get(buildKey);
    if (!build) {
      const result = this.callbacks?.getBuildByKey(buildKey) ?? null;
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
        compressedArtifacts: new Map<string, Promise<Buffer>>(),
      };
      this.activatedBuildCache.set(buildKey, build);
      this.registerSharedStyles(build);
      this.scheduleTransportDerivatives(build);
    }
    return build;
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
      const content = build.htmlArtifact.content.replace(
        /\b(src|href|data-bundle-src)=(["'])(?:\.\/)?([^"'?#]+)([^"']*)\2/giu,
        (match, attribute: string, quote: string, path: string, suffix: string) =>
          artifactPaths.has(path) ? `${attribute}=${quote}${prefix}${path}${suffix}${quote}` : match
      );
      await this.writeArtifact(req, res, build, { ...build.htmlArtifact, content });
      return;
    }
    res.writeHead(307, {
      Location: `../../__vibestudio/panel-build/${buildKey}/${resource.replace(/^\/+/, "")}`,
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
   * Serve a "building" placeholder page for a pending panel.
   */
  private serveBuildingPage(res: import("http").ServerResponse, panelLabel: string): void {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Building — Vibestudio</title>
  <link rel="icon" type="image/x-icon" href="/favicon.ico">
  <style>
    :root {
      color-scheme: light dark;
      --page-bg: radial-gradient(circle at top, #f5edff 0%, #fcfaff 58%);
      --heading: #24152f;
      --muted: #685875;
      --accent: #6d28d9;
      --spinner-track: #e4d8ed;
      --mark-shadow: drop-shadow(0 18px 24px rgba(109, 40, 217, 0.16));
    }
    html { min-height: 100%; background: var(--page-bg); }
    body { box-sizing: border-box; min-height: 100vh; font-family: ui-sans-serif, system-ui, sans-serif; max-width: 500px; margin: 0 auto; padding: 4rem 1rem; text-align: center; color: var(--heading); }
    h1 { color: var(--heading); font-size: 1.5rem; }
    p { color: var(--muted); line-height: 1.6; }
    code { color: var(--accent); }
    .brand-mark { width: 74px; height: 74px; margin: 0 auto 1.25rem; filter: var(--mark-shadow); }
    .brand-mark img { display: block; width: 100%; height: 100%; object-fit: contain; }
    .spinner { width: 24px; height: 24px; border: 3px solid var(--spinner-track); border-top-color: #a874ff;
               border-radius: 50%; animation: spin 0.8s linear infinite; margin: 1rem auto; }
    @media (prefers-color-scheme: dark) {
      :root {
        --page-bg: radial-gradient(circle at top, #21122f 0%, #100b18 58%);
        --heading: #fbf7ff;
        --muted: #b8a9c5;
        --accent: #a874ff;
        --spinner-track: #49305f;
        --mark-shadow: drop-shadow(0 18px 24px rgba(0, 0, 0, 0.35));
      }
    }
    @media (prefers-reduced-motion: reduce) { .spinner { animation-duration: 1.6s; } }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
  <meta http-equiv="refresh" content="2">
</head>
<body>
  <div class="brand-mark"><img src="${BRAND_SYMBOL_DATA_URL}" alt="" aria-hidden="true"></div>
  <h1>Building Panel</h1>
  <div class="spinner"></div>
  <p>The panel <code>${escapeHtml(panelLabel)}</code> is still building. This page will refresh automatically.</p>
</body>
</html>`;

    res.writeHead(202, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  }

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
  <style>
    :root {
      color-scheme: light dark;
      --page-bg: radial-gradient(circle at top, #f5edff 0%, #fcfaff 58%);
      --heading: #24152f;
      --muted: #685875;
      --accent: #6d28d9;
      --error-bg: #fff1f2;
      --error-border: #fecdd3;
      --error-text: #b91c1c;
      --mark-shadow: drop-shadow(0 18px 24px rgba(109, 40, 217, 0.16));
    }
    html { min-height: 100%; background: var(--page-bg); }
    body { box-sizing: border-box; min-height: 100vh; font-family: ui-sans-serif, system-ui, sans-serif; max-width: 600px; margin: 0 auto; padding: 4rem 1rem; text-align: center; color: var(--heading); }
    h1 { color: var(--heading); font-size: 1.5rem; }
    p { color: var(--muted); line-height: 1.6; }
    code { color: var(--accent); }
    pre { background: var(--error-bg); border: 1px solid var(--error-border); padding: 1rem; border-radius: 10px; text-align: left; overflow-x: auto; font-size: 0.85rem; color: var(--error-text); }
    a { color: var(--accent); }
    .brand-mark { width: 74px; height: 74px; margin: 0 auto 1.25rem; filter: var(--mark-shadow); }
    .brand-mark img { display: block; width: 100%; height: 100%; object-fit: contain; }
    @media (prefers-color-scheme: dark) {
      :root {
        --page-bg: radial-gradient(circle at top, #21122f 0%, #100b18 58%);
        --heading: #fbf7ff;
        --muted: #b8a9c5;
        --accent: #a874ff;
        --error-bg: #170f20;
        --error-border: #49305f;
        --error-text: #fecaca;
        --mark-shadow: drop-shadow(0 18px 24px rgba(0, 0, 0, 0.35));
      }
    }
  </style>
</head>
<body>
  <div class="brand-mark"><img src="${BRAND_SYMBOL_DATA_URL}" alt="" aria-hidden="true"></div>
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
    res.end(build.htmlArtifact.content);
  }

  private resolvePanelArtifact(
    build: CachedBuild,
    resource: string
  ): (BuildArtifactManifestEntry & { content: string }) | null {
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
      const existing = this.sharedStyleAssets.get(style.digest);
      if (existing && existing.artifact.content !== artifact.content) {
        throw new Error(`Shared style digest collision for ${style.digest}`);
      }
      this.sharedStyleAssets.set(style.digest, { build, artifact });
    }
  }

  private scheduleTransportDerivatives(build: CachedBuild): void {
    const initialArtifacts = new Set(build.metadata.bundleReport?.initialArtifacts ?? []);
    for (const artifact of build.artifacts) {
      if (
        artifact.role === "html" ||
        artifact.encoding !== "utf8" ||
        (artifact.byteLength ?? 0) < 1_024 ||
        (artifact.role !== "shared-style" && !initialArtifacts.has(artifact.path)) ||
        !artifact.integrity
      ) {
        continue;
      }
      this.transportDerivativeCache.scheduleFile(
        artifact.integrity,
        artifactFilePath({ dir: build.dir }, artifact)
      );
    }
  }

  private async writeArtifact(
    req: import("http").IncomingMessage,
    res: import("http").ServerResponse,
    build: CachedBuild,
    artifact: BuildArtifactManifestEntry & { content: string }
  ): Promise<void> {
    // Every non-document panel output has a content-derived filename. The HTML
    // remains the mutable pointer to a build; its JS, CSS, maps, chunks and
    // assets can be retained indefinitely by both Electron and mobile clients.
    const cacheControl =
      artifact.role === "html" ? "no-store" : "public, max-age=31536000, immutable";
    if (artifact.encoding === "base64") {
      const body = Buffer.from(artifact.content, "base64");
      res.writeHead(200, {
        "Content-Type": artifact.contentType,
        "Content-Length": body.length,
        "Cache-Control": cacheControl,
        "X-Vibestudio-Build-Revision": String(build.revision),
      });
      res.end(body);
      return;
    }

    const body = Buffer.from(artifact.content);
    const encoding =
      body.length >= 1_024 ? preferredContentEncoding(req.headers["accept-encoding"]) : null;
    let compressedBody: Buffer | null = null;
    if (encoding) {
      if (artifact.integrity) {
        compressedBody = await this.transportDerivativeCache.get(artifact.integrity, encoding);
      }
      const cacheKey = `${encoding}:${artifact.path}`;
      if (!compressedBody) {
        let compressed = build.compressedArtifacts.get(cacheKey);
        if (!compressed) {
          compressed = compressArtifact(body, encoding);
          build.compressedArtifacts.set(cacheKey, compressed);
        }
        try {
          compressedBody = await compressed;
        } catch (error) {
          build.compressedArtifacts.delete(cacheKey);
          log.warn(
            `Failed to ${encoding}-compress panel artifact ${artifact.path}: ${String(error)}`
          );
        }
      }
    }
    res.writeHead(200, {
      "Content-Type": artifact.contentType,
      "Content-Length": compressedBody?.length ?? body.length,
      "Cache-Control": cacheControl,
      ...(encoding && compressedBody
        ? { "Content-Encoding": encoding, Vary: "Accept-Encoding" }
        : {}),
      "X-Vibestudio-Build-Revision": String(build.revision),
    });
    res.end(compressedBody ?? artifact.content);
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
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; max-width: 600px; margin: 2rem auto; padding: 0 1rem; color: #fbf7ff; background: radial-gradient(circle at top, #21122f 0%, #100b18 58%); }
    h1 { color: #fbf7ff; }
    code { background: #170f20; border: 1px solid #49305f; padding: 0.1em 0.4em; border-radius: 5px; font-size: 0.8em; color: #e4d8ed; }
    ul { list-style: none; padding: 0; }
    li { margin: 0.8rem 0; padding: 0.8rem 0; border-bottom: 1px solid #352244; }
    a { color: #a874ff; text-decoration: none; font-weight: 600; }
    a:hover { text-decoration: underline; }
    .brand-header { display: flex; align-items: center; gap: 1rem; margin: 0 0 1.5rem; }
    .brand-mark { width: 58px; height: 58px; filter: drop-shadow(0 18px 24px rgba(0, 0, 0, 0.35)); }
    .brand-mark img { display: block; width: 100%; height: 100%; object-fit: contain; }
    .sub { color: #8f7c9e; margin-left: 0.5em; }
    .empty { color: #b8a9c5; }
    .badge { font-size: 0.7em; padding: 0.15em 0.5em; border-radius: 3px; margin-left: 0.5em; text-transform: uppercase; font-weight: 600; }
    .badge.running { background: #1b5e20; color: #81c784; }
  </style>
</head>
<body>
  <div class="brand-header">
    <div class="brand-mark"><img src="${BRAND_SYMBOL_DATA_URL}" alt="" aria-hidden="true"></div>
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
    if (pathname === "/favicon.svg" && BRAND_FAVICON_SVG) {
      res.writeHead(200, {
        "Content-Type": "image/svg+xml; charset=utf-8",
        "Content-Length": BRAND_FAVICON_SVG.length,
        "Cache-Control": "public, max-age=86400",
      });
      res.end(BRAND_FAVICON_SVG);
      return;
    }
    if (pathname === "/favicon.ico" && BRAND_FAVICON_ICO) {
      res.writeHead(200, {
        "Content-Type": "image/x-icon",
        "Content-Length": BRAND_FAVICON_ICO.length,
        "Cache-Control": "public, max-age=86400",
      });
      res.end(BRAND_FAVICON_ICO);
      return;
    }
    if (BRAND_FAVICON_PNG) {
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": BRAND_FAVICON_PNG.length,
        "Cache-Control": "public, max-age=86400",
      });
      res.end(BRAND_FAVICON_PNG);
      return;
    }
    res.writeHead(200, {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
    });
    res.end(DEFAULT_FAVICON_SVG);
  }
}
