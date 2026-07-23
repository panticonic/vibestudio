import {
  systemPreferences,
  type MediaAccessPermissionRequest,
  type PermissionCheckHandlerHandlerDetails,
  type PermissionRequest,
  type Session,
  type WebContents,
} from "electron";
import { browserPermissionsMethods } from "@vibestudio/service-schemas/browserPermissions";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import type { EventService } from "@vibestudio/shared/eventsService";
import type { ServerClient } from "../serverClient.js";
import type { ViewManager } from "../viewManager.js";

export type BrowserPermissionCapability = "camera" | "microphone" | "geolocation" | "notifications";

type PermissionGrant = {
  origin: string;
  capability: BrowserPermissionCapability;
  decision: "allow" | "block";
  scope: "session" | "always" | "block";
  updatedAt: number;
};

const SENSITIVE_PERMISSIONS = new Set(["geolocation", "notifications", "media"]);

/**
 * Connects one canonical browser environment to Electron's permission hooks.
 *
 * The server remains the policy authority. This controller retains only the
 * projection required by Electron's synchronous permission-check callback.
 */
export class BrowserPermissionController {
  private readonly grants = new Map<string, PermissionGrant>();
  private readonly client;
  private stopped = false;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly deps: {
      partition: string;
      serverClient: ServerClient;
      eventService: EventService;
      getViewManager(): ViewManager | null;
    }
  ) {
    this.client = createTypedServiceClient(
      "browserPermissions",
      browserPermissionsMethods,
      (service, method, args) => deps.serverClient.call(service, method, args)
    );
  }

  async start(): Promise<void> {
    await this.refresh();
    this.stopped = false;
    this.refreshTimer = setInterval(() => void this.refresh().catch(() => {}), 5_000);
  }

  stop(): void {
    this.stopped = true;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    this.grants.clear();
  }

  async refresh(): Promise<void> {
    const snapshot = await this.client.snapshot();
    this.replaceProjection(snapshot.grants);
  }

  isGranted(origin: string, capability: BrowserPermissionCapability): boolean {
    const normalized = webOrigin(origin);
    return Boolean(
      normalized && this.grants.get(grantKey(normalized, capability))?.decision === "allow"
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

    const topLevelOrigin = webOrigin(contents.getURL());
    const origin = webOrigin(details.securityOrigin ?? details.requestingUrl ?? requestingOrigin);
    if (!origin || origin !== topLevelOrigin) return false;

    const capabilities = capabilitiesForCheck(permission, details);
    if (!this.mayRequest(contents, capabilities)) return false;
    return (
      capabilities.length > 0 &&
      capabilities.every(
        (capability) => this.grants.get(grantKey(origin, capability))?.decision === "allow"
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
    const topLevelOrigin = webOrigin(topLevelUrl);
    const mediaDetails = details as MediaAccessPermissionRequest;
    const origin = webOrigin(mediaDetails.securityOrigin ?? details.requestingUrl);
    const capabilities = capabilitiesForRequest(permission, details);
    if (
      !panelId ||
      !origin ||
      origin !== topLevelOrigin ||
      capabilities.length === 0 ||
      !this.mayRequest(contents, capabilities)
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

    const abort = new AbortController();
    const cancel = () => {
      abort.abort();
      finish(false);
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

    void this.deps.serverClient
      .call(
        "browserPermissions",
        "request",
        [
          {
            panelId,
            origin,
            topLevelUrl,
            capabilities,
            deviceLabel: capabilities.map(capabilityLabel).join(" and "),
          },
        ],
        { signal: abort.signal }
      )
      .then((raw) => browserPermissionsMethods.request.returns.parse(raw))
      .then((result) => {
        if (
          abort.signal.aborted ||
          this.stopped ||
          contents.isDestroyed() ||
          webOrigin(contents.getURL()) !== origin
        ) {
          finish(false);
          return;
        }
        this.replaceProjection(result.grants);
        if (!result.granted) {
          this.notifyDenied(panelId, capabilities);
        }
        finish(result.granted);
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted) {
          this.notifyDenied(
            panelId,
            capabilities,
            error instanceof Error ? error.message : String(error)
          );
        }
        finish(false);
      })
      .finally(() => {
        if (!contents.isDestroyed()) {
          contents.off("did-start-navigation", onNavigation);
          contents.off("destroyed", cancel);
        }
      });
  };

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
  if (permission !== "media") return [];
  if (details.mediaType === "video") return ["camera"];
  if (details.mediaType === "audio") return ["microphone"];
  return [];
}

function grantKey(origin: string, capability: BrowserPermissionCapability): string {
  return `${origin}\0${capability}`;
}

function webOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
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
