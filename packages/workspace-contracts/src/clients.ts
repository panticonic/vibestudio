/**
 * Hosts, runtimes and clients (docs/client-hosts-and-clients-plan.md §1–§4).
 *
 * A **host** is trusted native code that ships with a binary release and owns
 * the device, its connection and its operating-system integration. A
 * **client** is a System-workspace unit (`clients/<name>`) that a host
 * downloads, verifies and runs as the top-level program on the device. Each
 * client is built for exactly one **runtime**; each runtime has one versioned
 * **host ABI**, the complete contract a client of that runtime may rely on.
 *
 * This module is the single vocabulary for all of it: the server's ClientHost,
 * every host's `client-host-core`, the manifest validator and the build all
 * read these definitions instead of re-spelling them.
 */

/** Execution environment a client is built for. */
export const CLIENT_RUNTIMES = ["web", "react-native", "terminal"] as const;
export type ClientRuntime = (typeof CLIENT_RUNTIMES)[number];

/** The four trusted native hosts. */
export const HOST_KINDS = ["desktop", "terminal", "android", "ios"] as const;
export type HostKind = (typeof HOST_KINDS)[number];

/** The runtime each host runs. A host runs exactly one client runtime. */
export const HOST_RUNTIME: Readonly<Record<HostKind, ClientRuntime>> = Object.freeze({
  desktop: "web",
  terminal: "terminal",
  android: "react-native",
  ios: "react-native",
});

/**
 * The host ABI this build of every host implements, per runtime. A client
 * declares the ABI it was written against; a host runs it only when it
 * implements exactly that ABI. Bump the version when the contract a client
 * may rely on changes incompatibly.
 */
export const CURRENT_HOST_ABI: Readonly<Record<ClientRuntime, string>> = Object.freeze({
  web: "web-host-1",
  "react-native": "rn-host-6",
  terminal: "terminal-host-1",
});

export function isClientRuntime(value: unknown): value is ClientRuntime {
  return typeof value === "string" && (CLIENT_RUNTIMES as readonly string[]).includes(value);
}

export function isHostKind(value: unknown): value is HostKind {
  return typeof value === "string" && (HOST_KINDS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

interface ClientCapabilityDescriptor {
  /** Hosts that implement this capability. */
  hosts: readonly HostKind[];
  /**
   * Device-level power: it lets a client act as this device or draw surfaces
   * an agent cannot fake. Granted only to clients listed in `trust.clients`
   * of the System manifest, and changing who holds one is a trust change
   * (§4.4.1).
   */
  deviceLevel?: true;
  /** Plain-language description of what holding it means, for review cards. */
  summary: string;
}

/**
 * One catalog owns the manifest vocabulary, which hosts implement each
 * capability, and which capabilities are device-level. A client declares a
 * capability `required` or `optional`; a host that lacks a required one
 * reports the client `unavailable`, and denies optional ones it lacks.
 */
export const CLIENT_CAPABILITY_CATALOG = {
  "device-session": {
    hosts: ["desktop", "terminal", "android", "ios"],
    deviceLevel: true,
    summary: "act as this device in every workspace it is routed to",
  },
  "panel-hosting": {
    hosts: ["desktop", "android", "ios"],
    deviceLevel: true,
    summary: "host panels and render host chrome",
  },
  "terminal-app-hosting": {
    hosts: ["terminal"],
    deviceLevel: true,
    summary: "start terminal apps and shells in workspaces",
  },
  "approval-surface": {
    hosts: ["desktop", "terminal", "android", "ios"],
    deviceLevel: true,
    summary: "show approvals and submit your decisions on them",
  },
  "hub-control": {
    hosts: ["desktop", "terminal", "android", "ios"],
    deviceLevel: true,
    summary: "manage workspaces, members and devices on this hub",
  },
  "native-menus": {
    hosts: ["desktop"],
    summary: "contribute entries to the application menu",
  },
  notifications: {
    hosts: ["desktop", "terminal", "android", "ios"],
    summary: "show notifications",
  },
  "notifications.reply": {
    hosts: ["desktop", "android", "ios"],
    summary: "receive replies typed into notifications",
  },
  tray: { hosts: ["desktop"], summary: "show an icon in the system tray" },
  badge: { hosts: ["desktop"], summary: "show a badge count on the application icon" },
  "global-shortcut": { hosts: ["desktop"], summary: "register a system-wide keyboard shortcut" },
  "local-files": {
    hosts: ["desktop", "terminal"],
    summary: "read and write files on this device that you pick",
  },
  clipboard: {
    hosts: ["desktop", "terminal", "android", "ios"],
    summary: "write to the clipboard",
  },
  dialog: { hosts: ["desktop"], summary: "open native file and message dialogs" },
  "open-external": {
    hosts: ["desktop", "terminal", "android", "ios"],
    summary: "open links in your default browser",
  },
  "browser-import": {
    hosts: ["desktop", "android", "ios"],
    summary: "import bookmarks, history and passwords from other browsers",
  },
  theme: { hosts: ["desktop"], summary: "change the window theme and appearance" },
  devtools: { hosts: ["desktop"], summary: "open developer tools for views it hosts" },
  camera: { hosts: ["desktop", "android", "ios"], summary: "use the camera" },
  microphone: { hosts: ["desktop"], summary: "use the microphone" },
  "screen-capture": { hosts: ["desktop"], summary: "capture the screen" },
  location: { hosts: ["desktop"], summary: "read this device's location" },
  "integration.install": {
    hosts: ["desktop", "terminal", "android", "ios"],
    summary: "ask to add launchers for clients to this device",
  },
} as const satisfies Record<string, ClientCapabilityDescriptor>;

export type ClientCapability = keyof typeof CLIENT_CAPABILITY_CATALOG;

export const CLIENT_CAPABILITIES = Object.freeze(
  Object.keys(CLIENT_CAPABILITY_CATALOG) as ClientCapability[]
);

export const DEVICE_LEVEL_CAPABILITIES: readonly ClientCapability[] = Object.freeze(
  CLIENT_CAPABILITIES.filter(
    (capability) =>
      (CLIENT_CAPABILITY_CATALOG[capability] as ClientCapabilityDescriptor).deviceLevel === true
  )
);

export function isClientCapability(value: unknown): value is ClientCapability {
  return typeof value === "string" && Object.hasOwn(CLIENT_CAPABILITY_CATALOG, value);
}

export function isDeviceLevelCapability(capability: ClientCapability): boolean {
  return (DEVICE_LEVEL_CAPABILITIES as readonly string[]).includes(capability);
}

/** Capabilities a host of this kind implements. */
export function capabilitiesForHost(host: HostKind): readonly ClientCapability[] {
  return CLIENT_CAPABILITIES.filter((capability) =>
    (CLIENT_CAPABILITY_CATALOG[capability].hosts as readonly HostKind[]).includes(host)
  );
}

/** Capabilities some host of this runtime implements: the manifest vocabulary of a runtime. */
export function capabilitiesForRuntime(runtime: ClientRuntime): readonly ClientCapability[] {
  const hosts = HOST_KINDS.filter((host) => HOST_RUNTIME[host] === runtime);
  return CLIENT_CAPABILITIES.filter((capability) =>
    hosts.some((host) =>
      (CLIENT_CAPABILITY_CATALOG[capability].hosts as readonly HostKind[]).includes(host)
    )
  );
}

// ---------------------------------------------------------------------------
// Host descriptor
// ---------------------------------------------------------------------------

/**
 * What a host tells the server about itself when it connects and when it
 * asks to launch a client. The server never infers a host's abilities from
 * its platform; it reads them here.
 */
export interface HostDescriptor {
  host: HostKind;
  /** The host binary's release version. */
  hostVersion: string;
  /** Runtimes this host runs, each with the exact host ABI it implements. */
  runtimes: Partial<Record<ClientRuntime, string>>;
  /** Capabilities this host implements (a subset of `capabilitiesForHost`). */
  capabilities: ClientCapability[];
}

/** The descriptor of this build of a host: every runtime and capability it implements. */
export function currentHostDescriptor(host: HostKind, hostVersion: string): HostDescriptor {
  const runtime = HOST_RUNTIME[host];
  return {
    host,
    hostVersion,
    runtimes: { [runtime]: CURRENT_HOST_ABI[runtime] },
    capabilities: [...capabilitiesForHost(host)],
  };
}

// ---------------------------------------------------------------------------
// The client manifest block (`package.json` → `vibestudio.client`)
// ---------------------------------------------------------------------------

export type ClientIntentKind = "foreground" | "background";

export type ClientIntentParamType = "string" | "text";

export interface ClientIntentDecl {
  /** Intent name, unique within the client. `open` is implicit for every client. */
  name: string;
  kind: ClientIntentKind;
  title?: string;
  params?: Record<string, ClientIntentParamType>;
  /** Service method (`<protocol>#<method>`) listing dynamic entries for this intent. */
  dynamic?: string;
  /** Background intents only: the workspace service method that handles it. */
  handler?: string;
  /** Background intents only: the shape of the handler's result. */
  result?: "text" | "text-stream";
  /** Foreground share-in intents: MIME patterns accepted. */
  accepts?: string[];
}

export interface ClientIntegrationHints {
  desktop?: { width?: number; height?: number; minWidth?: number; minHeight?: number };
  /** Registers `vibestudio <command>` for this client on the terminal host. */
  terminal?: { command?: string };
}

export interface ClientManifestBlock {
  /** Product identity shared by the runtime variants of one client. */
  id: string;
  runtime: ClientRuntime;
  hostAbi: string;
  /** Web: renderer entry; React Native: root component module; terminal: program module. */
  entry: string;
  title?: string;
  capabilities?: {
    required?: ClientCapability[];
    optional?: ClientCapability[];
  };
  intents?: ClientIntentDecl[];
  integration?: ClientIntegrationHints;
}

/** Built-in host commands a client's `integration.terminal.command` may not take. */
export const RESERVED_TERMINAL_COMMANDS: readonly string[] = Object.freeze([
  "agent",
  "approvals",
  "channel",
  "clients",
  "context",
  "help",
  "login",
  "logout",
  "model",
  "models",
  "open",
  "pair",
  "panel",
  "panels",
  "server",
  "storage",
  "system-test",
  "templates",
  "terminal",
  "version",
  "workspace",
  "workspaces",
]);

const CLIENT_ID_PATTERN = /^[a-z][a-z0-9-]{0,62}$/u;
const INTENT_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/u;

export function isValidClientId(value: unknown): value is string {
  return typeof value === "string" && CLIENT_ID_PATTERN.test(value);
}

export function isValidIntentName(value: unknown): value is string {
  return typeof value === "string" && INTENT_NAME_PATTERN.test(value);
}

/** The intents a client exposes, with the implicit `open` first. */
export function clientIntents(block: Pick<ClientManifestBlock, "intents">): ClientIntentDecl[] {
  const declared = block.intents ?? [];
  return declared.some((intent) => intent.name === "open")
    ? declared
    : [{ name: "open", kind: "foreground" }, ...declared];
}

// ---------------------------------------------------------------------------
// Principals
// ---------------------------------------------------------------------------

/** The principal of one running client instance on one device. */
export function clientPrincipalId(id: string, runtime: ClientRuntime, deviceId: string): string {
  return `client:${id}:${runtime}:${deviceId}`;
}

export function parseClientPrincipalId(
  principalId: string
): { id: string; runtime: ClientRuntime; deviceId: string } | null {
  const match = /^client:([a-z][a-z0-9-]*):(web|react-native|terminal):(.+)$/u.exec(principalId);
  if (!match) return null;
  return { id: match[1]!, runtime: match[2] as ClientRuntime, deviceId: match[3]! };
}

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

/** Which client a host asks to launch. */
export type ClientSelection =
  | { default: true }
  | { id: string; intent?: string; params?: Record<string, string> }
  | { source: string };

export interface ClientArtifactDescriptor {
  path: string;
  role: string;
  contentType: string;
  platform?: string;
  /** `sha256-<hex>` of the artifact bytes; every client artifact has one. */
  integrity: string;
}

export interface ReadyClient {
  source: string;
  id: string;
  runtime: ClientRuntime;
  title: string;
  icon?: string;
  buildKey: string;
  executionDigest: string;
  effectiveVersion: string;
  hostAbi: string;
  artifacts: ClientArtifactDescriptor[];
  grantedCapabilities: ClientCapability[];
  deniedOptional: ClientCapability[];
  intent?: { name: string; params: Record<string, string> };
}

export type ClientLaunchProgressPhase = "resolve" | "extensions" | "build";

export type ClientLaunchResult =
  | { state: "approval-required"; approvals: unknown[] }
  | { state: "preparing"; phase: ClientLaunchProgressPhase; reason: string }
  | { state: "ready"; client: ReadyClient }
  | {
      state: "unavailable";
      reason: string;
      missing?: { capabilities?: string[]; hostAbi?: string };
    };

/** A client listed for a host: what a launcher, a client list or a terminal command table shows. */
export interface ClientListing {
  source: string;
  id: string;
  runtime: ClientRuntime;
  title: string;
  icon?: string;
  hostAbi: string;
  status:
    | "not-built"
    | "pending-approval"
    | "building"
    | "available"
    | "running"
    | "stopped"
    | "error";
  isDefault: boolean;
  trusted: boolean;
  /** Why this host cannot run it, when it cannot. */
  unavailableReason?: string;
  intents: ClientIntentDecl[];
  terminalCommand?: string;
  activeBuildKey: string | null;
  canRollback: boolean;
}
