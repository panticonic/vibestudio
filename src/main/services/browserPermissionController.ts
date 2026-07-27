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
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import type { EventService } from "@vibestudio/shared/eventsService";
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
 * Connects one canonical browser environment to Electron's permission hooks.
 *
 * The server remains the policy authority. This controller retains only the
 * projection required by Electron's synchronous permission-check callback.
 */
export class BrowserPermissionController {
  private readonly grants = new Map<string, PermissionGrant>();
  private readonly client;
  private readonly sessionEpoch = randomUUID();
  private readonly automationTaint = new Set<number>();
  private environmentKey: string | null = null;
  private stopped = false;
  private releaseGrantEvents: (() => void) | null = null;

  constructor(
    private readonly deps: {
      partition: string;
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

  async start(): Promise<void> {
    this.stopped = false;
    this.releaseGrantEvents = this.deps.serverClient.onDirectEvent(
      "browser-permissions:changed",
      ({ environmentKey, grants }) => {
        if (environmentKey === this.environmentKey) this.replaceProjection(grants);
      }
    );
    try {
      await this.refresh();
    } catch (error) {
      this.releaseGrantEvents();
      this.releaseGrantEvents = null;
      throw error;
    }
  }

  stop(): void {
    this.stopped = true;
    this.releaseGrantEvents?.();
    this.releaseGrantEvents = null;
    this.grants.clear();
    this.automationTaint.clear();
    this.environmentKey = null;
  }

  async refresh(): Promise<void> {
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
    return this.isBrowserPanel(contents) || this.mayRequest(contents, ["notifications"]);
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
    if (!this.mayRequest(contents, capabilities)) return false;
    const panelId = this.deps.getViewManager()?.findViewIdByWebContentsId(contents.id);
    if (!panelId || this.isAutomationTainted(contents, panelId)) return false;
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
      !this.mayRequest(contents, capabilities) ||
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
    const osDenied = capabilities.find((capability) => !osAllows(capability));
    if (osDenied) {
      this.notifyDenied(
        panelId,
        [osDenied],
        `${capabilityLabel(osDenied)} access is disabled in system privacy settings.`
      );
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
    return Boolean(panelId && manager?.getViewPartition(panelId) === this.deps.partition);
  }

  private mayRequest(contents: WebContents, capabilities: BrowserPermissionCapability[]): boolean {
    if (this.isBrowserPanel(contents)) return true;
    const manager = this.deps.getViewManager();
    const panelId = manager?.findViewIdByWebContentsId(contents.id);
    const info = panelId ? manager?.getViewInfo(panelId) : null;
    return viewMayRequestPeripheral(info, capabilities);
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
      }
    | null
    | undefined,
  capabilities: readonly BrowserPermissionCapability[]
): boolean {
  if (view?.type !== "app" || capabilities.length === 0) return false;
  return capabilities.every((capability) => {
    const manifestCapability = capability === "geolocation" ? "location" : capability;
    return view.capabilities.includes(manifestCapability);
  });
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

function once(callback: (value: boolean) => void): (value: boolean) => void {
  let called = false;
  return (value) => {
    if (called) return;
    called = true;
    callback(value);
  };
}
