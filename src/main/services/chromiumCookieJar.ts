import { session, WebContentsView, type Session } from "electron";
import {
  normalizeBrowserCookiePartitionKey,
  normalizeCookieExpirationSeconds,
  type BrowserCookieInput,
  type BrowserCookieKey,
} from "@vibestudio/browser-data";

type CdpSameSite = "Strict" | "Lax" | "None";
type CdpSourceScheme = "Unset" | "NonSecure" | "Secure";

interface CdpCookiePartitionKey {
  topLevelSite: string;
  hasCrossSiteAncestor: boolean;
}

interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  session: boolean;
  sameSite?: CdpSameSite;
  sourceScheme?: CdpSourceScheme;
  sourcePort?: number;
  partitionKey?: CdpCookiePartitionKey;
  partitionKeyOpaque?: boolean;
}

interface CdpCookieParam {
  name: string;
  value: string;
  url: string;
  domain?: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: CdpSameSite;
  expires?: number;
  sourceScheme?: CdpSourceScheme;
  sourcePort?: number;
  partitionKey?: CdpCookiePartitionKey;
}

interface CdpSetCookieResult {
  success: boolean;
}

export interface BrowserCookieJarSnapshot {
  cookies: BrowserCookieInput[];
  unsupportedOpaquePartitions: number;
}

export interface BrowserCookieJar {
  start(onChanged: () => void): Promise<void>;
  snapshot(): Promise<BrowserCookieJarSnapshot>;
  set(cookie: BrowserCookieInput): Promise<void>;
  remove(key: BrowserCookieKey): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Partition-complete cookie access for one persistent Electron session.
 *
 * Electron's public Cookies API intentionally exposes only the legacy cookie
 * key. Chromium's target-scoped Network protocol exposes the complete CHIPS
 * key, so a dedicated unattached WebContents acts as the control plane for
 * exactly one Electron session partition.
 *
 * Do not use the CDP Storage cookie methods here. In Electron they operate on
 * the default browser context even when the debugger target belongs to a
 * partitioned WebContents. Network.getAllCookies/setCookie/deleteCookies are
 * target-scoped and therefore preserve the WebContents' session partition.
 * The public Cookies `changed` event is used only as an invalidation signal.
 */
export class ChromiumCookieJar implements BrowserCookieJar {
  private readonly browserSession: Session;
  private bridge: WebContentsView | null = null;
  private onChanged: (() => void) | null = null;

  constructor(private readonly partition: string) {
    this.browserSession = session.fromPartition(partition);
  }

  async start(onChanged: () => void): Promise<void> {
    if (this.bridge) return;
    this.onChanged = onChanged;
    this.browserSession.cookies.on("changed", this.handleChanged);
    const bridge = new WebContentsView({
      webPreferences: {
        partition: this.partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    try {
      bridge.webContents.debugger.attach();
      // Capability probe against the bundled Chromium, not a guessed Electron
      // version. Failure keeps the browser environment unavailable rather than
      // silently degrading partitioned cookies.
      await bridge.webContents.debugger.sendCommand("Network.getAllCookies");
      this.bridge = bridge;
    } catch (error) {
      this.browserSession.cookies.off("changed", this.handleChanged);
      if (bridge.webContents.debugger.isAttached()) bridge.webContents.debugger.detach();
      bridge.webContents.close();
      this.onChanged = null;
      throw error;
    }
  }

  async snapshot(): Promise<BrowserCookieJarSnapshot> {
    const result = (await this.send("Network.getAllCookies")) as { cookies?: CdpCookie[] };
    const cookies: BrowserCookieInput[] = [];
    let unsupportedOpaquePartitions = 0;
    for (const cookie of result.cookies ?? []) {
      if (cookie.partitionKeyOpaque) {
        unsupportedOpaquePartitions += 1;
        continue;
      }
      cookies.push(fromCdpCookie(cookie));
    }
    return { cookies, unsupportedOpaquePartitions };
  }

  async set(cookie: BrowserCookieInput): Promise<void> {
    const result = (await this.send(
      "Network.setCookie",
      toCdpCookie(cookie)
    )) as CdpSetCookieResult;
    if (!result.success) {
      throw new Error(`Chromium rejected cookie ${cookie.name} for ${cookie.domain}`);
    }
  }

  async remove(key: BrowserCookieKey): Promise<void> {
    await this.send("Network.deleteCookies", {
      name: key.name,
      domain: key.domain,
      path: key.path || "/",
      ...(key.partitionKey ? { partitionKey: key.partitionKey } : {}),
    });
  }

  async stop(): Promise<void> {
    this.browserSession.cookies.off("changed", this.handleChanged);
    this.onChanged = null;
    const bridge = this.bridge;
    this.bridge = null;
    if (!bridge) return;
    if (bridge.webContents.debugger.isAttached()) bridge.webContents.debugger.detach();
    bridge.webContents.close();
    await this.browserSession.cookies.flushStore();
  }

  private readonly handleChanged = (): void => {
    this.onChanged?.();
  };

  private async send(method: string, params?: object): Promise<unknown> {
    const bridge = this.bridge;
    if (!bridge || bridge.webContents.isDestroyed()) {
      throw new Error("Chromium cookie bridge is not active");
    }
    return bridge.webContents.debugger.sendCommand(method, params);
  }
}

export function fromCdpCookie(cookie: CdpCookie): BrowserCookieInput {
  const expirationDate = normalizeCookieExpirationSeconds(
    cookie.session || cookie.expires < 0 ? undefined : cookie.expires
  );
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain.toLocaleLowerCase(),
    hostOnly: !cookie.domain.startsWith("."),
    path: cookie.path || "/",
    ...(cookie.partitionKey
      ? {
          partitionKey: normalizeBrowserCookiePartitionKey({
            topLevelSite: cookie.partitionKey.topLevelSite,
            hasCrossSiteAncestor: cookie.partitionKey.hasCrossSiteAncestor,
          }),
        }
      : {}),
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: fromCdpSameSite(cookie.sameSite),
    ...(expirationDate === undefined ? {} : { expirationDate }),
    sourceScheme: fromCdpSourceScheme(cookie.sourceScheme, cookie.secure),
    sourcePort: cookie.sourcePort ?? (cookie.secure ? 443 : 80),
  };
}

export function toCdpCookie(cookie: BrowserCookieInput): CdpCookieParam {
  const expirationDate = normalizeCookieExpirationSeconds(cookie.expirationDate);
  const sameSite = toCdpSameSite(cookie.sameSite);
  return {
    url: cookieUrl(cookie),
    name: cookie.name,
    value: cookie.value,
    ...(cookie.hostOnly ? {} : { domain: cookie.domain }),
    path: cookie.path || "/",
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    ...(sameSite ? { sameSite } : {}),
    ...(expirationDate === undefined ? {} : { expires: expirationDate }),
    ...(cookie.sourceScheme ? { sourceScheme: toCdpSourceScheme(cookie.sourceScheme) } : {}),
    ...(cookie.sourcePort === undefined ? {} : { sourcePort: cookie.sourcePort }),
    ...(cookie.partitionKey
      ? { partitionKey: normalizeBrowserCookiePartitionKey(cookie.partitionKey) }
      : {}),
  };
}

function cookieUrl(cookie: Pick<BrowserCookieInput, "domain" | "path" | "secure">): string {
  return `${cookie.secure ? "https" : "http"}://${cookie.domain.replace(/^\./, "")}${
    cookie.path || "/"
  }`;
}

function fromCdpSameSite(value: CdpSameSite | undefined): BrowserCookieInput["sameSite"] {
  switch (value) {
    case "Strict":
      return "strict";
    case "Lax":
      return "lax";
    case "None":
      return "no_restriction";
    default:
      return "unspecified";
  }
}

function toCdpSameSite(value: BrowserCookieInput["sameSite"]): CdpSameSite | undefined {
  switch (value) {
    case "strict":
      return "Strict";
    case "lax":
      return "Lax";
    case "no_restriction":
      return "None";
    default:
      return undefined;
  }
}

function fromCdpSourceScheme(value: CdpSourceScheme | undefined, secure: boolean): string {
  switch (value) {
    case "Secure":
      return "secure";
    case "NonSecure":
      return "non_secure";
    case "Unset":
      return "unset";
    default:
      return secure ? "secure" : "non_secure";
  }
}

function toCdpSourceScheme(value: string): CdpSourceScheme {
  switch (value) {
    case "secure":
      return "Secure";
    case "non_secure":
      return "NonSecure";
    default:
      return "Unset";
  }
}
