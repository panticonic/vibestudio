import { session } from "electron";
import { createDevLogger } from "@vibez1/dev-log";
import type { BrowserDataClient, StoredCookie } from "@vibez1/browser-data";
import type { ManagedService } from "@vibez1/shared/managedService";
import { BROWSER_SESSION_PARTITION } from "@vibez1/shared/panelInterfaces";
import type { EventService, Subscriber } from "@vibez1/shared/eventsService";
import { browserDataBrokerPackageName } from "@vibez1/shared/workspace/configParser";
import type { WorkspaceConfig } from "@vibez1/shared/workspace/types";
import type { ServerClient } from "../serverClient.js";

const log = createDevLogger("BrowserSessionSync");
const SUBSCRIBER_ID = "browser-session-sync";

export function createBrowserSessionSyncService(deps: {
  eventService: EventService;
  serverClient: ServerClient;
  browserDataClient: BrowserDataClient;
}): ManagedService {
  let destroyed = false;
  /** Set at start() from the manifest-declared broker; null ⇒ sync disabled. */
  let importEventName: string | null = null;

  const syncCookies = async () => {
    try {
      const cookies = await deps.browserDataClient.cookies.getByDomain();
      const browserSession = session.fromPartition(BROWSER_SESSION_PARTITION);
      for (const cookie of cookies) {
        await browserSession.cookies.set(toElectronCookie(cookie));
      }
      log.info(`Synced ${cookies.length} imported cookie(s) into browser session`);
    } catch (err) {
      log.warn(`Cookie session sync failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const subscriber: Subscriber = {
    callerKind: "server",
    get isAlive() {
      return !destroyed;
    },
    send(channel, payload) {
      if (!importEventName || channel !== `event:${importEventName}`) return;
      const results = Array.isArray(payload) ? payload : [];
      if (!results.some((r) => isCookieImportSuccess(r))) return;
      void syncCookies();
    },
    isBoundTo: () => false,
    onDestroyed: () => {},
  };

  return {
    name: "browser-session-sync",
    async start() {
      // Browser-data import-complete is emitted by the manifest-declared
      // broker extension (meta/vibez1.yml providers.browserData.extension).
      // Extension events are namespaced as `extensions:<name>::<event>` on the
      // wire. No broker declared ⇒ cookie session sync stays disabled.
      try {
        const config = (await deps.serverClient.call(
          "workspace",
          "getConfig",
          []
        )) as WorkspaceConfig | null;
        const broker = config ? browserDataBrokerPackageName(config) : null;
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
          "No browser-data broker declared (meta/vibez1.yml providers.browserData) — cookie session sync disabled"
        );
        return { syncCookies };
      }
      deps.eventService.subscribe(importEventName as never, SUBSCRIBER_ID, subscriber);
      await deps.serverClient
        .call("events", "subscribe", [importEventName])
        .catch((err: unknown) => {
          log.warn(
            `Server event subscribe failed: ${err instanceof Error ? err.message : String(err)}`
          );
        });
      return { syncCookies };
    },
    async stop() {
      destroyed = true;
      if (!importEventName) return;
      deps.eventService.unsubscribe(importEventName as never, SUBSCRIBER_ID);
      await deps.serverClient.call("events", "unsubscribe", [importEventName]).catch(() => {});
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
