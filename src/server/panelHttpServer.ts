/**
 * PanelHttpServer — source/ref-keyed static panel asset server.
 *
 * Panel identity is injected by the host shell before app code runs, so this
 * server resolves source builds and serves static assets from path-based URLs.
 */

import * as fs from "fs";
import * as path from "path";
import { WebSocketServer } from "ws";
import { createDevLogger } from "@vibestudio/dev-log";
import type {
  BuildArtifactManifestEntry,
  BuildResult,
  BuildMetadata,
} from "./buildV2/buildStore.js";
import type { CdpBridge } from "./cdpBridge.js";
import { CONFIG_LOADER_JS } from "./configLoader.js";
import { assertPresent } from "../lintHelpers";

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
const DEFAULT_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#111"/><path d="M7 25h18M14 25V13l-8 5M14 13l5-3M18 15l5 5M18 15l7-2" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`;
const BRAND_MARK_WHITE_SVG = loadBrandAsset("vibestudio-mark-white.svg");
const DEFAULT_BRAND_MARK_WHITE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 904 904" fill="none"><path d="M116 805H788" stroke="#F8FAFC" stroke-width="32" stroke-linecap="round"/><path d="M496 805V350L204 536" stroke="#F8FAFC" stroke-width="32" stroke-linecap="round" stroke-linejoin="round"/><path d="M155 608L496 392" stroke="#F8FAFC" stroke-width="32" stroke-linecap="round"/><path d="M280 238L414 372L179 519" stroke="#F8FAFC" stroke-width="32" stroke-linecap="round" stroke-linejoin="round"/><path d="M302 184L430 312" stroke="#F8FAFC" stroke-width="32" stroke-linecap="round"/><path d="M338 88L510 278" stroke="#F8FAFC" stroke-width="32" stroke-linecap="round"/><path d="M265 127L291 153" stroke="#F8FAFC" stroke-width="32" stroke-linecap="round"/><path d="M496 278L557 180C592 123 552 80 507 87C470 93 450 121 450 165V236" stroke="#F8FAFC" stroke-width="32" stroke-linecap="round" stroke-linejoin="round"/><path d="M525 355L616 222C653 168 728 189 737 238C743 274 724 295 690 303L538 342L633 437" stroke="#F8FAFC" stroke-width="32" stroke-linecap="round" stroke-linejoin="round"/><path d="M554 578V431L709 579V394" stroke="#F8FAFC" stroke-width="32" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const BRAND_MARK_WHITE_DATA_URL = `data:image/svg+xml;base64,${(
  BRAND_MARK_WHITE_SVG ?? Buffer.from(DEFAULT_BRAND_MARK_WHITE_SVG)
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
}

/** Build output cached by source path (shared across panels) */
interface CachedBuild {
  artifacts: Array<BuildArtifactManifestEntry & { content: string }>;
  htmlArtifact: BuildArtifactManifestEntry & { content: string };
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

// ---------------------------------------------------------------------------
// PanelHttpServer
// ---------------------------------------------------------------------------

export class PanelHttpServer {
  /** Serving cache: source/ref -> resolved build (for fast sub-resource serving within a page load) */
  private servingCache = new Map<string, CachedBuild>();

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

  /** Set the port (used when gateway owns the socket). */
  setPort(port: number): void {
    this.port = port;
  }

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
    this.servingCache.set(this.buildCacheKey(source, ref), {
      artifacts: buildResult.artifacts,
      htmlArtifact,
      metadata: buildResult.metadata,
      revision,
    });

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
  primeBuild(source: string, ref: string | undefined, getBuild: () => Promise<BuildResult>): void {
    void this.ensureBuild(source, ref, getBuild);
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
      this.logPanelResourceRequest(req, res, parsed.source, parsed.resource, routeLabel);
      await this.resolveAndServeBuild(res, parsed.source, routeLabel, parsed.resource, ref);
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
    res: import("http").ServerResponse,
    source: string,
    panelLabel: string,
    resource: string,
    ref?: string
  ): Promise<void> {
    const flightKey = this.buildCacheKey(source, ref);

    const cached = this.servingCache.get(flightKey);
    if (cached) {
      this.servePanelResource(res, cached, resource);
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
      this.servePanelResource(res, build, resource);
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

    const factory =
      getBuild ?? (this.callbacks?.getBuild ? () => this.callbacks!.getBuild(source, ref) : null);
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
      res.end(CONFIG_LOADER_JS);
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
      --page-bg: radial-gradient(circle at top, #fffbeb 0%, #f8fafc 58%);
      --heading: #111827;
      --muted: #64748b;
      --accent: #b45309;
      --spinner-track: #e2e8f0;
      --mark-filter: brightness(0) saturate(100%);
      --mark-shadow: drop-shadow(0 18px 24px rgba(15, 23, 42, 0.12));
    }
    html { min-height: 100%; background: var(--page-bg); }
    body { box-sizing: border-box; min-height: 100vh; font-family: ui-sans-serif, system-ui, sans-serif; max-width: 500px; margin: 0 auto; padding: 4rem 1rem; text-align: center; color: var(--heading); }
    h1 { color: var(--heading); font-size: 1.5rem; }
    p { color: var(--muted); line-height: 1.6; }
    code { color: var(--accent); }
    .brand-mark { width: 74px; height: 74px; margin: 0 auto 1.25rem; filter: var(--mark-shadow); }
    .brand-mark img { display: block; width: 100%; height: 100%; object-fit: contain; filter: var(--mark-filter); }
    .spinner { width: 24px; height: 24px; border: 3px solid var(--spinner-track); border-top-color: #f59e0b;
               border-radius: 50%; animation: spin 0.8s linear infinite; margin: 1rem auto; }
    @media (prefers-color-scheme: dark) {
      :root {
        --page-bg: radial-gradient(circle at top, #222834 0%, #0a0b0c 58%);
        --heading: #f8fafc;
        --muted: #9ca3af;
        --accent: #facc15;
        --spinner-track: #303a4f;
        --mark-filter: none;
        --mark-shadow: drop-shadow(0 18px 24px rgba(0, 0, 0, 0.35));
      }
    }
    @media (prefers-reduced-motion: reduce) { .spinner { animation-duration: 1.6s; } }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
  <meta http-equiv="refresh" content="2">
</head>
<body>
  <div class="brand-mark"><img src="${BRAND_MARK_WHITE_DATA_URL}" alt="" aria-hidden="true"></div>
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
      --page-bg: radial-gradient(circle at top, #fff7ed 0%, #f8fafc 58%);
      --heading: #111827;
      --muted: #64748b;
      --accent: #b45309;
      --error-bg: #fff1f2;
      --error-border: #fecdd3;
      --error-text: #b91c1c;
      --mark-filter: brightness(0) saturate(100%);
      --mark-shadow: drop-shadow(0 18px 24px rgba(15, 23, 42, 0.12));
    }
    html { min-height: 100%; background: var(--page-bg); }
    body { box-sizing: border-box; min-height: 100vh; font-family: ui-sans-serif, system-ui, sans-serif; max-width: 600px; margin: 0 auto; padding: 4rem 1rem; text-align: center; color: var(--heading); }
    h1 { color: var(--heading); font-size: 1.5rem; }
    p { color: var(--muted); line-height: 1.6; }
    code { color: var(--accent); }
    pre { background: var(--error-bg); border: 1px solid var(--error-border); padding: 1rem; border-radius: 10px; text-align: left; overflow-x: auto; font-size: 0.85rem; color: var(--error-text); }
    a { color: var(--accent); }
    .brand-mark { width: 74px; height: 74px; margin: 0 auto 1.25rem; filter: var(--mark-shadow); }
    .brand-mark img { display: block; width: 100%; height: 100%; object-fit: contain; filter: var(--mark-filter); }
    @media (prefers-color-scheme: dark) {
      :root {
        --page-bg: radial-gradient(circle at top, #222834 0%, #0a0b0c 58%);
        --heading: #f8fafc;
        --muted: #9ca3af;
        --accent: #f59e0b;
        --error-bg: #101318;
        --error-border: #303a4f;
        --error-text: #fecaca;
        --mark-filter: none;
        --mark-shadow: drop-shadow(0 18px 24px rgba(0, 0, 0, 0.35));
      }
    }
  </style>
</head>
<body>
  <div class="brand-mark"><img src="${BRAND_MARK_WHITE_DATA_URL}" alt="" aria-hidden="true"></div>
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

  private servePanelResource(
    res: import("http").ServerResponse,
    build: CachedBuild,
    resource: string
  ): void {
    const artifact = this.resolvePanelArtifact(build, resource);
    if (artifact) {
      this.writeArtifact(res, build.revision, artifact);
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

  private writeArtifact(
    res: import("http").ServerResponse,
    revision: number,
    artifact: BuildArtifactManifestEntry & { content: string }
  ): void {
    const cacheControl =
      artifact.role === "asset" || artifact.role === "map"
        ? "public, max-age=31536000, immutable"
        : "no-store";
    if (artifact.encoding === "base64") {
      const body = Buffer.from(artifact.content, "base64");
      res.writeHead(200, {
        "Content-Type": artifact.contentType,
        "Content-Length": body.length,
        "Cache-Control": cacheControl,
        "X-Vibestudio-Build-Revision": String(revision),
      });
      res.end(body);
      return;
    }
    res.writeHead(200, {
      "Content-Type": artifact.contentType,
      "Cache-Control": cacheControl,
      "X-Vibestudio-Build-Revision": String(revision),
    });
    res.end(artifact.content);
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
    body { font-family: ui-sans-serif, system-ui, sans-serif; max-width: 600px; margin: 2rem auto; padding: 0 1rem; color: #f8fafc; background: radial-gradient(circle at top, #222834 0%, #0a0b0c 58%); }
    h1 { color: #f8fafc; }
    code { background: #101318; border: 1px solid #303a4f; padding: 0.1em 0.4em; border-radius: 5px; font-size: 0.8em; color: #d1d5db; }
    ul { list-style: none; padding: 0; }
    li { margin: 0.8rem 0; padding: 0.8rem 0; border-bottom: 1px solid #222834; }
    a { color: #f59e0b; text-decoration: none; font-weight: 600; }
    a:hover { text-decoration: underline; }
    .brand-header { display: flex; align-items: center; gap: 1rem; margin: 0 0 1.5rem; }
    .brand-mark { width: 58px; height: 58px; filter: drop-shadow(0 18px 24px rgba(0, 0, 0, 0.35)); }
    .brand-mark img { display: block; width: 100%; height: 100%; object-fit: contain; }
    .sub { color: #6b7280; margin-left: 0.5em; }
    .empty { color: #9ca3af; }
    .badge { font-size: 0.7em; padding: 0.15em 0.5em; border-radius: 3px; margin-left: 0.5em; text-transform: uppercase; font-weight: 600; }
    .badge.running { background: #1b5e20; color: #81c784; }
  </style>
</head>
<body>
  <div class="brand-header">
    <div class="brand-mark"><img src="${BRAND_MARK_WHITE_DATA_URL}" alt="" aria-hidden="true"></div>
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
