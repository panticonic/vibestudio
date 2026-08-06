import { randomUUID } from "node:crypto";
import {
  systemPreferences,
  type MediaAccessPermissionRequest,
  type PermissionCheckHandlerHandlerDetails,
  type PermissionRequest,
  type Session,
  type WebContents,
} from "electron";
import { browserPermissionsMethods } from "@vibestudio/service-schemas/browserPermissions";
import type { BrowserSitePermissionCapability } from "@vibestudio/shared/approvals";
import { capabilityPatternCovers } from "@vibestudio/shared/authorityManifest";
import { scopeCovers } from "@vibestudio/shared/authorization";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import type { EventService } from "@vibestudio/shared/eventsService";
import type { CapabilityScope } from "@vibestudio/rpc";
import { browserEnvironmentPartition } from "@vibestudio/shared/panelInterfaces";
import type { ServerClient } from "../serverClient.js";
import type { ViewManager } from "../viewManager.js";

export type BrowserPermissionCapability = BrowserSitePermissionCapability;
export type BrowserSecurityOrigin =
  | {
      kind: "tuple";
      scheme: "http" | "https";
      host: string;
      port: string;
      serialized: string;
    }
  | { kind: "opaque"; nonce: string };

type PermissionGrant = {
  origin: string;
  capability: BrowserPermissionCapability;
  decision: "allow" | "block";
  scope: "session" | "always" | "block";
  updatedAt: number;
};

const SENSITIVE_PERMISSIONS = new Set([
  "geolocation",
  "notifications",
  "media",
  "clipboard-read",
  "clipboard-sanitized-write",
]);

/**
 * Connects workspace views to Electron's permission hooks.
 *
 * Exact workspace-unit authority is available as soon as ViewManager exists.
 * A canonical browser environment may attach later; only website grant
 * projection depends on it. Keeping those lifecycles separate means a delayed
 * browser-data extension cannot disable local panel features such as a
 * user-activated clipboard write.
 */
export class BrowserPermissionController {
  private readonly grants = new Map<string, PermissionGrant>();
  private readonly client;
  private readonly sessionEpoch = randomUUID();
  private readonly automationTaint = new Set<number>();
  private browserPartition: string | null = null;
  private environmentKey: string | null = null;
  private stopped = false;
  private releaseGrantEvents: (() => void) | null = null;

  constructor(
    private readonly deps: {
      serverClient: ServerClient;
      eventService: EventService;
      getViewManager(): ViewManager | null;
      isTargetUnderAutomation(targetId: string): boolean;
    }
  ) {
    this.client = createTypedServiceClient(
      "browserPermissions",
      browserPermissionsMethods,
      (service, method, args) => deps.serverClient.call(service, method, args)
    );
  }

  /**
   * Resolve and attach the canonical browser environment owned by the signed-in
   * workspace user. This server primitive is deliberately independent of the
   * optional browser-data extension: ordinary browser views must be usable
   * while cookie projection is still attaching (or unavailable).
   */
  async attachBrowserEnvironment(): Promise<string> {
    if (this.stopped) throw new Error("Browser permission controller is stopped");
    this.detachBrowserEnvironment();
    try {
      const snapshot = await this.client.snapshot({ sessionEpoch: this.sessionEpoch });
      const partition = browserEnvironmentPartition(snapshot.environmentKey);
      this.browserPartition = partition;
      this.environmentKey = snapshot.environmentKey;
      this.replaceProjection(snapshot.grants);
      this.releaseGrantEvents = this.deps.serverClient.onDirectEvent(
        "browser-permissions:changed",
        ({ environmentKey, grants }) => {
          if (environmentKey === this.environmentKey) this.replaceProjection(grants);
        }
      );
      return partition;
    } catch (error) {
      this.detachBrowserEnvironment();
      throw error;
    }
  }

  /** Detach browser-only state while retaining local workspace-unit enforcement. */
  detachBrowserEnvironment(): void {
    this.releaseGrantEvents?.();
    this.releaseGrantEvents = null;
    this.grants.clear();
    this.browserPartition = null;
    this.environmentKey = null;
  }

  stop(): void {
    this.stopped = true;
    this.detachBrowserEnvironment();
    this.automationTaint.clear();
  }

  async refresh(): Promise<void> {
    if (this.stopped || !this.browserPartition) {
      throw new Error("Browser permission environment is not attached");
    }
    const snapshot = await this.client.snapshot({ sessionEpoch: this.sessionEpoch });
    this.environmentKey = snapshot.environmentKey;
    this.replaceProjection(snapshot.grants);
  }

  isGranted(origin: string, capability: BrowserPermissionCapability): boolean {
    const normalized = browserSecurityOrigin(origin, "notification");
    return Boolean(
      normalized.kind === "tuple" &&
      this.grants.get(grantKey(normalized.serialized, capability))?.decision === "allow"
    );
  }

  ownsContents(contents: WebContents): boolean {
    if (this.isBrowserPanel(contents)) return true;
    const origin = browserSecurityOrigin(contents.getURL(), `contents:${contents.id}:top-level`);
    return (
      origin.kind === "tuple" && this.mayRequest(contents, ["notifications"], origin.serialized)
    );
  }

  readonly checkPermission = (
    contents: WebContents | null,
    permission: Parameters<NonNullable<Parameters<Session["setPermissionCheckHandler"]>[0]>>[1],
    requestingOrigin: string,
    details: PermissionCheckHandlerHandlerDetails
  ): boolean => {
    if (permission === "fullscreen") return this.isBrowserPanel(contents);
    if (!SENSITIVE_PERMISSIONS.has(permission)) return false;
    if (!contents) return false;

    const topLevelOrigin = browserSecurityOrigin(
      contents.getURL(),
      `contents:${contents.id}:top-level`
    );
    const origin = browserSecurityOrigin(
      details.securityOrigin ?? details.requestingUrl ?? requestingOrigin,
      `contents:${contents.id}:request`
    );
    if (
      origin.kind !== "tuple" ||
      topLevelOrigin.kind !== "tuple" ||
      origin.serialized !== topLevelOrigin.serialized
    ) {
      return false;
    }

    const capabilities = capabilitiesForCheck(permission, details);
    const panelId = this.deps.getViewManager()?.findViewIdByWebContentsId(contents.id);
    if (!panelId || this.isAutomationTainted(contents, panelId)) return false;
    // Chromium already constrains sanitized writes to its secure-context and
    // user-activation path. A Copy action must not require read capability.
    if (permission === "clipboard-sanitized-write") return true;
    if (deniedPeripheralCapability(capabilities)) return false;
    if (this.hasApprovedUnitCapability(contents, capabilities, origin.serialized)) return true;
    if (!this.mayRequest(contents, capabilities, origin.serialized)) return false;
    return (
      capabilities.length > 0 &&
      capabilities.every(
        (capability) =>
          this.grants.get(grantKey(origin.serialized, capability))?.decision === "allow"
      )
    );
  };

  readonly requestPermission = (
    contents: WebContents,
    permission: Parameters<NonNullable<Parameters<Session["setPermissionRequestHandler"]>[0]>>[1],
    callback: (permissionGranted: boolean) => void,
    details: PermissionRequest
  ): void => {
    if (permission === "fullscreen") {
      callback(this.isBrowserPanel(contents));
      return;
    }
    if (!SENSITIVE_PERMISSIONS.has(permission)) {
      callback(false);
      return;
    }

    const finish = once(callback);
    if (this.stopped) {
      finish(false);
      return;
    }
    const panelId = this.deps.getViewManager()?.findViewIdByWebContentsId(contents.id);
    const topLevelUrl = contents.getURL();
    const topLevelOrigin = browserSecurityOrigin(topLevelUrl, `contents:${contents.id}:top-level`);
    const mediaDetails = details as MediaAccessPermissionRequest;
    const origin = browserSecurityOrigin(
      mediaDetails.securityOrigin ?? details.requestingUrl,
      `contents:${contents.id}:request`
    );
    const capabilities = capabilitiesForRequest(permission, details);
    if (
      !panelId ||
      origin.kind !== "tuple" ||
      topLevelOrigin.kind !== "tuple" ||
      origin.serialized !== topLevelOrigin.serialized ||
      capabilities.length === 0 ||
      this.isAutomationTainted(contents, panelId)
    ) {
      this.notifyDenied(
        panelId ?? null,
        capabilities,
        "The request did not come from the current page."
      );
      finish(false);
      return;
    }
    // Match normal browser behavior: Chromium enforces the user gesture for
    // sanitized writes, so panel manifests only need to declare clipboard for
    // reading the device clipboard.
    if (permission === "clipboard-sanitized-write") {
      finish(true);
      return;
    }
    const osDenied = deniedPeripheralCapability(capabilities);
    if (osDenied) {
      this.notifyDenied(
        panelId,
        [osDenied],
        `${capabilityLabel(osDenied)} access is disabled in system privacy settings.`
      );
      finish(false);
      return;
    }
    if (this.hasApprovedUnitCapability(contents, capabilities, origin.serialized)) {
      finish(true);
      return;
    }
    if (!this.mayRequest(contents, capabilities, origin.serialized)) {
      this.notifyDenied(panelId, capabilities, "This page did not declare the requested access.");
      finish(false);
      return;
    }

    void this.requestOriginCapabilities(
      contents,
      panelId,
      topLevelUrl,
      origin.serialized,
      capabilities
    ).then(finish);
  };

  /**
   * Authorize a browser feature whose enforcement hook is not one of
   * Electron's permission callbacks (downloads, autofill, and popups).
   */
  async requestSiteCapability(
    contents: WebContents,
    capability: Extract<BrowserPermissionCapability, "downloads" | "autofill" | "popups">
  ): Promise<boolean> {
    if (this.stopped || contents.isDestroyed()) return false;
    const panelId = this.deps.getViewManager()?.findViewIdByWebContentsId(contents.id);
    const topLevelUrl = contents.getURL();
    const origin = browserSecurityOrigin(topLevelUrl, `contents:${contents.id}:top-level`);
    if (
      !panelId ||
      origin.kind !== "tuple" ||
      !this.isBrowserPanel(contents) ||
      this.isAutomationTainted(contents, panelId)
    ) {
      this.notifyDenied(panelId ?? null, [capability]);
      return false;
    }
    return this.requestOriginCapabilities(contents, panelId, topLevelUrl, origin.serialized, [
      capability,
    ]);
  }

  private async requestOriginCapabilities(
    contents: WebContents,
    panelId: string,
    topLevelUrl: string,
    origin: string,
    capabilities: BrowserPermissionCapability[]
  ): Promise<boolean> {
    const abort = new AbortController();
    let cancelled = false;
    const cancel = () => {
      cancelled = true;
      abort.abort();
    };
    const onNavigation = (
      _event: Electron.Event,
      _url: string,
      _isInPlace: boolean,
      isMainFrame: boolean
    ) => {
      if (isMainFrame) cancel();
    };
    contents.on("did-start-navigation", onNavigation);
    contents.once("destroyed", cancel);

    try {
      const raw = await this.deps.serverClient.call(
        "browserPermissions",
        "request",
        [
          {
            panelId,
            origin,
            topLevelUrl,
            sessionEpoch: this.sessionEpoch,
            capabilities,
            deviceLabel: capabilities.map(capabilityLabel).join(" and "),
          },
        ],
        { signal: abort.signal }
      );
      const result = browserPermissionsMethods.request.returns.parse(raw);
      const currentOrigin = browserSecurityOrigin(
        contents.getURL(),
        `contents:${contents.id}:top-level`
      );
      if (
        cancelled ||
        this.stopped ||
        contents.isDestroyed() ||
        currentOrigin.kind !== "tuple" ||
        currentOrigin.serialized !== origin
      ) {
        return false;
      }
      this.replaceProjection(result.grants);
      if (!result.granted) this.notifyDenied(panelId, capabilities);
      return result.granted;
    } catch (error) {
      if (!cancelled) {
        this.notifyDenied(
          panelId,
          capabilities,
          error instanceof Error ? error.message : String(error)
        );
      }
      return false;
    } finally {
      if (!contents.isDestroyed()) {
        contents.off("did-start-navigation", onNavigation);
        contents.off("destroyed", cancel);
      }
    }
  }

  private replaceProjection(grants: PermissionGrant[]): void {
    this.grants.clear();
    for (const grant of grants) {
      this.grants.set(grantKey(grant.origin, grant.capability), { ...grant });
    }
  }

  private isBrowserPanel(contents: WebContents | null): boolean {
    if (!contents || contents.isDestroyed()) return false;
    const manager = this.deps.getViewManager();
    const panelId = manager?.findViewIdByWebContentsId(contents.id);
    return Boolean(
      panelId &&
      this.browserPartition &&
      manager?.getViewPartition(panelId) === this.browserPartition
    );
  }

  private mayRequest(
    contents: WebContents,
    capabilities: BrowserPermissionCapability[],
    resourceKey: string
  ): boolean {
    if (this.isBrowserPanel(contents)) return true;
    const manager = this.deps.getViewManager();
    const panelId = manager?.findViewIdByWebContentsId(contents.id);
    const info = panelId ? manager?.getViewInfo(panelId) : null;
    return viewMayRequestPeripheral(info, capabilities, resourceKey);
  }

  private hasApprovedUnitCapability(
    contents: WebContents,
    capabilities: BrowserPermissionCapability[],
    resourceKey: string
  ): boolean {
    if (this.isBrowserPanel(contents)) return false;
    const manager = this.deps.getViewManager();
    const viewId = manager?.findViewIdByWebContentsId(contents.id);
    return viewMayRequestPeripheral(
      viewId ? manager?.getViewInfo(viewId) : null,
      capabilities,
      resourceKey
    );
  }

  private isAutomationTainted(contents: WebContents, panelId: string): boolean {
    if (this.deps.isTargetUnderAutomation(panelId)) this.automationTaint.add(contents.id);
    return this.automationTaint.has(contents.id);
  }

  private notifyDenied(
    panelId: string | null,
    capabilities: BrowserPermissionCapability[],
    message?: string
  ): void {
    const label =
      capabilities.length > 0 ? capabilities.map(capabilityLabel).join(" and ") : "Site permission";
    this.deps.eventService.emit("notification:show", {
      id: `permission-blocked:${panelId ?? "unknown"}:${capabilities.join("+") || "unknown"}`,
      type: "warning",
      title: `${label} access blocked`,
      message: message ?? `This site is not allowed to use ${label.toLowerCase()}.`,
      ttl: 8_000,
    });
  }
}

export function viewMayRequestPeripheral(
  view:
    | {
        type: string;
        capabilities: readonly string[];
        codeIdentity?: {
          source?: string;
          effectiveVersion?: string | null;
          executionDigest?: string | null;
          requested?: readonly CapabilityScope[];
        };
      }
    | null
    | undefined,
  capabilities: readonly BrowserPermissionCapability[],
  resourceKey: string
): boolean {
  if (!view || capabilities.length === 0) return false;
  const manifestCapabilities = capabilities.map((capability) =>
    capability === "geolocation" ? "location" : capability
  );
  if (view.type === "app") {
    return manifestCapabilities.every((capability) => view.capabilities.includes(capability));
  }
  if (
    view.type !== "panel" ||
    typeof view.codeIdentity?.source !== "string" ||
    view.codeIdentity.source.length === 0 ||
    typeof view.codeIdentity.effectiveVersion !== "string" ||
    view.codeIdentity.effectiveVersion.length === 0 ||
    typeof view.codeIdentity.executionDigest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(view.codeIdentity.executionDigest) ||
    !Array.isArray(view.codeIdentity.requested)
  ) {
    return false;
  }
  const requested = view.codeIdentity.requested;
  return manifestCapabilities.every((capability) =>
    requested.some(
      (request) =>
        capabilityPatternCovers(request.capability, capability) &&
        scopeCovers(request.resource, resourceKey)
    )
  );
}

export function capabilitiesForRequest(
  permission: string,
  details: PermissionRequest
): BrowserPermissionCapability[] {
  if (permission === "geolocation" || permission === "notifications") return [permission];
  if (permission === "clipboard-read" || permission === "clipboard-sanitized-write") {
    return ["clipboard"];
  }
  const mediaTypes = (details as MediaAccessPermissionRequest).mediaTypes;
  if (permission !== "media" || !mediaTypes?.length) return [];
  return [
    ...new Set<BrowserPermissionCapability>(
      mediaTypes.map((type) => (type === "video" ? "camera" : "microphone"))
    ),
  ];
}

export function capabilitiesForCheck(
  permission: string,
  details: PermissionCheckHandlerHandlerDetails
): BrowserPermissionCapability[] {
  if (permission === "geolocation" || permission === "notifications") return [permission];
  if (permission === "clipboard-read" || permission === "clipboard-sanitized-write") {
    return ["clipboard"];
  }
  if (permission !== "media") return [];
  if (details.mediaType === "video") return ["camera"];
  if (details.mediaType === "audio") return ["microphone"];
  return [];
}

function grantKey(origin: string, capability: BrowserPermissionCapability): string {
  return `${origin}\0${capability}`;
}

export function browserSecurityOrigin(
  value: string | undefined,
  opaqueNonce: string
): BrowserSecurityOrigin {
  if (!value) return { kind: "opaque", nonce: opaqueNonce };
  try {
    const url = new URL(value);
    if (url.origin === "null") return { kind: "opaque", nonce: opaqueNonce };
    const origin = new URL(url.origin);
    if (origin.protocol !== "http:" && origin.protocol !== "https:") {
      return { kind: "opaque", nonce: opaqueNonce };
    }
    return {
      kind: "tuple",
      scheme: origin.protocol.slice(0, -1) as "http" | "https",
      host: origin.hostname,
      port: origin.port || (origin.protocol === "https:" ? "443" : "80"),
      serialized: origin.origin,
    };
  } catch {
    return { kind: "opaque", nonce: opaqueNonce };
  }
}

function capabilityLabel(capability: BrowserPermissionCapability): string {
  switch (capability) {
    case "camera":
      return "Camera";
    case "microphone":
      return "Microphone";
    case "geolocation":
      return "Location";
    case "notifications":
      return "Notifications";
    case "downloads":
      return "Downloads";
    case "clipboard":
      return "Clipboard";
    case "autofill":
      return "Autofill";
    case "popups":
      return "Popups";
  }
}

function osAllows(capability: BrowserPermissionCapability): boolean {
  if (process.platform !== "darwin") return true;
  if (capability !== "camera" && capability !== "microphone") return true;
  const status = systemPreferences.getMediaAccessStatus(capability);
  return status !== "denied" && status !== "restricted";
}

export function deniedPeripheralCapability(
  capabilities: readonly BrowserPermissionCapability[],
  allows: (capability: BrowserPermissionCapability) => boolean = osAllows
): BrowserPermissionCapability | undefined {
  return capabilities.find((capability) => !allows(capability));
}

function once(callback: (value: boolean) => void): (value: boolean) => void {
  let called = false;
  return (value) => {
    if (called) return;
    called = true;
    callback(value);
  };
}
