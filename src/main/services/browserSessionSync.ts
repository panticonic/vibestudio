import { session } from "electron";
import { createDevLogger } from "@vibestudio/dev-log";
import type { BrowserDataClient, StoredCookie } from "@vibestudio/browser-data";
import type { ManagedService } from "@vibestudio/shared/managedService";
import { BROWSER_SESSION_PARTITION } from "@vibestudio/shared/panelInterfaces";
import type { EventName } from "@vibestudio/shared/events";
import { EventsClient } from "@vibestudio/service-schemas/clients/eventsClient";
import { workspaceProviderExtensionPackageName } from "@vibestudio/workspace/configParser";
import type { WorkspaceConfig } from "@vibestudio/workspace-contracts/types";
import type { ServerClient } from "../serverClient.js";

const log = createDevLogger("BrowserSessionSync");
export function createBrowserSessionSyncService(deps: {
  serverClient: ServerClient;
  browserDataClient: BrowserDataClient;
}): ManagedService {
  /** Set at start() from the manifest-declared broker; null ⇒ sync disabled. */
  let importEventName: string | null = null;

  const syncCookies = async () => {
    try {
      const cookies = await deps.browserDataClient.getCookies();
      const browserSession = session.fromPartition(BROWSER_SESSION_PARTITION);
      for (const cookie of cookies) {
        await browserSession.cookies.set(toElectronCookie(cookie));
      }
      log.info(`Synced ${cookies.length} imported cookie(s) into browser session`);
    } catch (err) {
      log.warn(`Cookie session sync failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const events = new EventsClient({
    stream(targetId, method, args, options) {
      if (targetId !== "main") throw new Error(`Unexpected browser sync target: ${targetId}`);
      const dot = method.indexOf(".");
      return deps.serverClient.stream(method.slice(0, dot), method.slice(dot + 1), args, options);
    },
  });
  let stopListening: (() => void) | null = null;
  const handleImportComplete = (payload: unknown) => {
    const results = Array.isArray(payload) ? payload : [];
    if (!results.some((r) => isCookieImportSuccess(r))) return;
    void syncCookies();
  };

  return {
    name: "browser-session-sync",
    async start() {
      // Browser-data import-complete is emitted by the manifest-declared
      // broker extension (meta/vibestudio.yml providers.browserData.extension).
      // Extension events are namespaced as `extensions:<name>::<event>` on the
      // wire. No broker declared ⇒ cookie session sync stays disabled.
      try {
        const config = (await deps.serverClient.call(
          "workspace",
          "getConfig",
          []
        )) as WorkspaceConfig | null;
        const broker = config ? workspaceProviderExtensionPackageName(config, "browserData") : null;
        importEventName = broker ? `extensions:${broker}::import-complete` : null;
      } catch (err) {
        log.warn(
          `Failed to resolve browser-data broker from workspace manifest: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        importEventName = null;
      }
      if (!importEventName) {
        log.info(
          "No browser-data broker declared (meta/vibestudio.yml providers.browserData) — cookie session sync disabled"
        );
        return { syncCookies };
      }
      const eventName = importEventName as EventName;
      stopListening = events.on(eventName, handleImportComplete);
      await events.subscribe(eventName).catch((err: unknown) => {
        log.warn(
          `Server event subscribe failed: ${err instanceof Error ? err.message : String(err)}`
        );
      });
      return { syncCookies };
    },
    async stop() {
      stopListening?.();
      stopListening = null;
      await events.unsubscribeAll().catch(() => {});
    },
  };
}

function isCookieImportSuccess(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record["dataType"] === "cookies" && record["success"] === true;
}

export function toElectronCookie(cookie: StoredCookie): Electron.CookiesSetDetails {
  const details: Electron.CookiesSetDetails = {
    url: deriveCookieUrl(cookie),
    name: cookie.name,
    value: cookie.value,
    path: cookie.path,
    secure: cookie.secure === 1,
    httpOnly: cookie.http_only === 1,
    expirationDate: cookie.expiration_date ?? undefined,
    sameSite: toElectronSameSite(cookie.same_site),
  };
  if (cookie.host_only !== 1) details.domain = cookie.domain;
  return details;
}

function deriveCookieUrl(cookie: StoredCookie): string {
  const scheme = cookie.secure === 1 ? "https" : "http";
  const host = cookie.domain.replace(/^\./, "");
  return `${scheme}://${host}${cookie.path || "/"}`;
}

function toElectronSameSite(value: string): Electron.CookiesSetDetails["sameSite"] {
  if (value === "no_restriction" || value === "lax" || value === "strict") return value;
  return "unspecified";
}
