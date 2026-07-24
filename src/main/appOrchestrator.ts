import { createDevLogger } from "@vibestudio/dev-log";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import type { PanelViewLike } from "@vibestudio/shared/panelInterfaces";
import type { AppCapability } from "@vibestudio/shared/unitManifest";
import { parseUnitAuthorityManifest } from "@vibestudio/shared/authorityManifest";
import { parseSha256 } from "@vibestudio/shared/execution/identity";
import { domainHash } from "@vibestudio/shared/execution/identity";
import { canonicalJson } from "@vibestudio/shared/contentTree/canonicalJson";
import type { CapabilityScope } from "@vibestudio/rpc";

const log = createDevLogger("AppOrchestrator");

export const ELECTRON_APP_HOST_CAPABILITIES = [
  "native-menus",
  "notifications",
  "open-external",
  "window-management",
  "panel-hosting",
  "incoming-pair-links",
  "fs-read",
  "fs-write",
] as const satisfies readonly AppCapability[];

const electronAppHostCapabilitySet = new Set<AppCapability>(ELECTRON_APP_HOST_CAPABILITIES);

export interface AppAvailableEvent {
  appId: string;
  source?: string;
  target?: "electron" | "react-native" | "terminal";
  launchMode?: "hosted-view" | "native-bootstrap" | "terminal-process";
  url: string;
  artifactRoute?: string;
  contextId?: string | null;
  capabilities?: readonly AppCapability[];
  effectiveVersion?: string | null;
  buildKey?: string | null;
  executionDigest?: string | null;
  authorityRequests?: readonly CapabilityScope[];
  adoptionPolicy?: "immediate" | "prompt" | "artifact-only";
  selectedForHost?: boolean;
}

export interface AppOrchestratorDeps {
  getPanelView(): PanelViewLike | null;
  statePath?: string;
}

interface BakedAppManifest {
  version: 2;
  app: {
    name: string;
    source: string;
    target: "electron" | "react-native" | "terminal";
    capabilities?: AppCapability[];
  };
  build: {
    key: string;
    effectiveVersion: string;
    executionDigest: string;
    execution: {
      version: 1;
      source: { repoPath: string; effectiveVersion: string };
      buildInputDigest: string;
      artifactDigest: string;
      executionDigest: string;
    };
    authorityRequests: readonly CapabilityScope[];
  };
  artifacts: Array<{
    path: string;
    role: string;
    contentType: string;
    encoding: string;
    platform?: string;
    integrity: string;
  }>;
}

export class AppOrchestrator {
  private readonly adopted = new Map<string, AppAvailableEvent>();
  private readonly pending = new Map<string, AppAvailableEvent>();

  constructor(private readonly deps: AppOrchestratorDeps) {
    this.loadPendingState();
  }

  async applyAppAvailable(event: AppAvailableEvent): Promise<void> {
    if (event.target && event.target !== "electron") {
      log.verbose(`Ignoring non-Electron app ${event.appId} for Electron host: ${event.target}`);
      return;
    }
    if (event.selectedForHost === false) {
      log.verbose(`Ignoring unselected Electron app ${event.appId} for Electron host`);
      return;
    }
    if (event.adoptionPolicy === "artifact-only") {
      log.verbose(`Ignoring artifact-only app ${event.appId} for Electron host`);
      return;
    }
    this.validateElectronApp(event);
    const panelView = this.requirePanelView();
    const current = this.adopted.get(event.appId);
    const hasLoadedView = panelView.hasView?.(event.appId) ?? false;
    const isNewBuild = !current || appAvailableIdentity(current) !== appAvailableIdentity(event);
    if (event.adoptionPolicy === "prompt" && hasLoadedView && isNewBuild) {
      this.pending.set(event.appId, event);
      this.savePendingState();
      log.verbose(`Queued app update for ${event.appId}: ${event.url}`);
      return;
    }
    if (!isNewBuild && hasLoadedView) {
      // Availability is emitted at-least-once (host launch, workspace
      // rediscovery). Remounting an already-loaded identical build would
      // re-show the view and restack it over slotted panels.
      log.verbose(`App ${event.appId} already mounted at ${appAvailableIdentity(event)}; skipping`);
      this.adopted.set(event.appId, event);
      return;
    }
    await this.mountApp(event);
  }

  async applyPendingAppUpdate(appId: string): Promise<boolean> {
    const event = this.pending.get(appId);
    if (!event) return false;
    await this.mountApp(event);
    this.pending.delete(appId);
    this.savePendingState();
    return true;
  }

  listPendingAppUpdates(): AppAvailableEvent[] {
    return [...this.pending.values()];
  }

  private validateElectronApp(event: AppAvailableEvent): void {
    const unsupportedCapabilities = (event.capabilities ?? []).filter(
      (capability) => !electronAppHostCapabilitySet.has(capability)
    );
    if (unsupportedCapabilities.length > 0) {
      throw new Error(
        `Electron app ${event.appId} requests unsupported host capabilities: ${unsupportedCapabilities.join(", ")}`
      );
    }
    sealedAppCodeIdentity(event);
  }

  private requirePanelView(): PanelViewLike {
    const panelView = this.deps.getPanelView();
    if (!panelView?.createViewForApp) {
      throw new Error("App view runtime is unavailable");
    }
    return panelView;
  }

  private async mountApp(event: AppAvailableEvent): Promise<void> {
    this.validateElectronApp(event);
    const panelView = this.requirePanelView();
    const createViewForApp = panelView.createViewForApp;
    if (!createViewForApp) throw new Error("App view runtime is unavailable");
    log.verbose(`Loading app view ${event.appId}: ${event.url}`);
    const identity = sealedAppCodeIdentity(event);
    await createViewForApp.call(
      panelView,
      event.appId,
      event.url,
      event.contextId ?? undefined,
      event.capabilities,
      identity
    );
    panelView.setViewVisible?.(event.appId, true);
    this.adopted.set(event.appId, event);
  }

  destroyApp(appId: string): void {
    this.adopted.delete(appId);
    this.pending.delete(appId);
    this.savePendingState();
    this.deps.getPanelView()?.destroyView(appId);
  }

  private pendingStatePath(): string | null {
    return this.deps.statePath
      ? path.join(this.deps.statePath, "app-updates", "pending-electron.json")
      : null;
  }

  private loadPendingState(): void {
    const filePath = this.pendingStatePath();
    if (!filePath || !fs.existsSync(filePath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
        pending?: AppAvailableEvent[];
      };
      for (const event of parsed.pending ?? []) {
        if (event?.appId && event.url) this.pending.set(event.appId, event);
      }
    } catch (error) {
      log.warn(
        `Failed to load pending app update state: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private savePendingState(): void {
    const filePath = this.pendingStatePath();
    if (!filePath) return;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(
        filePath,
        JSON.stringify({ pending: this.listPendingAppUpdates() }, null, 2)
      );
    } catch (error) {
      log.warn(
        `Failed to save pending app update state: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async loadBakedApp(distDir: string): Promise<boolean> {
    const event = readBakedElectronApp(distDir);
    if (!event) return false;
    await this.applyAppAvailable(event);
    return true;
  }
}

function appAvailableIdentity(event: AppAvailableEvent): string {
  return sealedAppCodeIdentity(event).executionDigest;
}

function sealedAppCodeIdentity(event: AppAvailableEvent): {
  source: string;
  effectiveVersion?: string;
  executionDigest: string;
  requested: readonly CapabilityScope[];
} {
  const source = event.source;
  if (
    typeof source !== "string" ||
    source.length === 0 ||
    source !== source.trim() ||
    source !== source.normalize("NFC") ||
    source.includes("\\") ||
    source.startsWith("/") ||
    source.startsWith("workspace/") ||
    source.split(/[\\/]/).some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`Electron app ${event.appId} has an invalid workspace source identity`);
  }
  const executionDigest = parseSha256(
    event.executionDigest ?? "",
    `Electron app ${event.appId} execution digest`
  );
  const authority = parseUnitAuthorityManifest(
    {
      requests: event.authorityRequests,
    },
    `Electron app ${event.appId} sealed authority`
  );
  return {
    source,
    ...(event.effectiveVersion ? { effectiveVersion: event.effectiveVersion } : {}),
    executionDigest,
    requested: authority.requests,
  };
}

export function readBakedElectronApp(distDir: string): AppAvailableEvent | null {
  const manifestPath = path.join(distDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) return null;
  const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Baked app manifest must be an object");
  }
  const manifest = raw as BakedAppManifest;
  if (manifest.version !== 2) {
    throw new Error(`Unsupported baked app manifest version: ${String(manifest.version)}`);
  }
  if (!manifest.app || !manifest.build || !Array.isArray(manifest.artifacts)) {
    throw new Error("Baked app manifest is missing its app, build, or artifact identity");
  }
  if (manifest.app.target !== "electron") return null;
  if (
    typeof manifest.app.name !== "string" ||
    typeof manifest.app.source !== "string" ||
    !Array.isArray(manifest.app.capabilities) ||
    typeof manifest.build.key !== "string" ||
    typeof manifest.build.effectiveVersion !== "string" ||
    manifest.artifacts.some(
      (artifact) =>
        !artifact ||
        typeof artifact !== "object" ||
        typeof artifact.path !== "string" ||
        typeof artifact.role !== "string" ||
        typeof artifact.contentType !== "string" ||
        typeof artifact.encoding !== "string"
    )
  ) {
    throw new Error("Baked Electron app manifest has malformed app, build, or artifact fields");
  }
  const html = manifest.artifacts.find((artifact) => artifact.role === "html");
  if (!html) throw new Error(`Baked Electron app ${manifest.app.name} is missing an HTML artifact`);
  const artifactPaths = new Set<string>();
  for (const artifact of manifest.artifacts) {
    if (
      typeof artifact.path !== "string" ||
      artifact.path.length === 0 ||
      path.isAbsolute(artifact.path) ||
      artifact.path.split(/[\\/]/).some((part) => !part || part === "." || part === "..")
    ) {
      throw new Error(`Baked Electron app has an invalid artifact path: ${String(artifact.path)}`);
    }
    if (artifactPaths.has(artifact.path)) {
      throw new Error(`Baked Electron app has a duplicate artifact path: ${artifact.path}`);
    }
    artifactPaths.add(artifact.path);
    if (!/^sha256-[0-9a-f]{64}$/.test(artifact.integrity ?? "")) {
      throw new Error(
        `Baked Electron app artifact ${artifact.path} is missing canonical content integrity`
      );
    }
    const artifactPath = path.join(distDir, "artifacts", artifact.path);
    if (!fs.existsSync(artifactPath)) {
      throw new Error(`Baked Electron app artifact is missing: ${artifact.path}`);
    }
    const actualIntegrity = `sha256-${crypto
      .createHash("sha256")
      .update(fs.readFileSync(artifactPath))
      .digest("hex")}`;
    if (actualIntegrity !== artifact.integrity) {
      throw new Error(`Baked Electron app artifact integrity mismatch: ${artifact.path}`);
    }
  }
  const htmlPath = path.join(distDir, "artifacts", html.path);
  const executionDigest = verifyBakedExecutionIdentity(manifest);
  const authority = parseUnitAuthorityManifest(
    {
      requests: manifest.build.authorityRequests,
    },
    `Baked Electron app ${manifest.app.name} sealed authority`
  );
  const event: AppAvailableEvent = {
    appId: manifest.app.name,
    source: manifest.app.source,
    target: "electron",
    url: pathToFileURL(htmlPath).href,
    capabilities: manifest.app.capabilities ?? [],
    buildKey: manifest.build.key,
    effectiveVersion: manifest.build.effectiveVersion,
    executionDigest,
    authorityRequests: authority.requests,
  };
  sealedAppCodeIdentity(event);
  return event;
}

function verifyBakedExecutionIdentity(manifest: BakedAppManifest): string {
  const label = `Baked Electron app ${manifest.app.name}`;
  const execution = manifest.build.execution;
  if (
    !execution ||
    execution.version !== 1 ||
    !execution.source ||
    execution.source.repoPath !== manifest.app.source
  ) {
    throw new Error(`${label} execution identity does not match its source`);
  }
  const source = {
    repoPath: execution.source.repoPath,
    effectiveVersion: parseSha256(
      execution.source.effectiveVersion,
      `${label} execution effective version`
    ),
  };
  const buildInputDigest = parseSha256(execution.buildInputDigest, `${label} build input digest`);
  const artifactDigest = domainHash(
    "vibestudio/build-v2-artifacts/v1",
    canonicalJson(
      manifest.artifacts
        .map((artifact) => ({
          path: artifact.path.replace(/\\/g, "/").normalize("NFC"),
          role: artifact.role,
          contentType: artifact.contentType,
          encoding: artifact.encoding,
          platform: artifact.platform ?? null,
          integrity: artifact.integrity ?? null,
        }))
        .sort((left, right) =>
          `${left.path}\0${left.platform ?? ""}`.localeCompare(
            `${right.path}\0${right.platform ?? ""}`
          )
        )
    )
  );
  if (parseSha256(execution.artifactDigest, `${label} artifact digest`) !== artifactDigest) {
    throw new Error(`${label} artifact manifest does not match its execution identity`);
  }
  const executionDigest = domainHash(
    "vibestudio/build-v2-execution/v1",
    canonicalJson({ version: 1, source, buildInputDigest, artifactDigest })
  );
  if (
    parseSha256(execution.executionDigest, `${label} sealed execution digest`) !==
      executionDigest ||
    parseSha256(manifest.build.executionDigest, `${label} execution digest`) !== executionDigest
  ) {
    throw new Error(`${label} execution digest does not match its sealed identity`);
  }
  return executionDigest;
}
