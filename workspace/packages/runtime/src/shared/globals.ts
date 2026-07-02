/**
 * Unified injected globals for panels and workers.
 *
 * Both environments receive the same global names.
 */

import type { PanelEntityId, PanelSlotId } from "@vibez1/shared/panel/ids";

export interface GatewayConfig {
  serverUrl: string;
  token: string;
  aliases?: readonly string[];
}

/**
 * Injected globals available in both panel and worker environments.
 */
declare global {
  /** Runtime entity ID for this panel or worker */
  var __vibez1EntityId: string | undefined;
  /** Stable workspace slot id for panel tree operations. */
  var __vibez1SlotId: string | undefined;
  /** Context ID for storage partition (format: {mode}_{type}_{identifier}) */
  var __vibez1ContextId: string | undefined;
  /** Environment kind: "panel" or "shell" */
  var __vibez1Kind: "panel" | "shell" | undefined;
  /** Parent panel ID if this is a child panel/worker */
  var __vibez1ParentId: string | null | undefined;
  /** Runtime entity ID for the parent panel, used for child-to-parent RPC. */
  var __vibez1ParentEntityId: string | null | undefined;
  /** Initial theme appearance */
  var __vibez1InitialTheme: "light" | "dark" | undefined;
  /** Single gateway configuration for HTTP and RPC-derived clients. */
  var __vibez1GatewayConfig: GatewayConfig | undefined;
  /** Source repo path for this endpoint */
  var __vibez1SourceRepo: string | undefined;
  /** Exact effective version for the source currently running. */
  var __vibez1EffectiveVersion: string | null | undefined;
  /** Environment variables */
  var __vibez1Env: Record<string, string> | undefined;
}

export interface InjectedConfig {
  entityId: PanelEntityId;
  slotId?: PanelSlotId;
  contextId: string;
  kind: "panel" | "shell";
  parentId: PanelSlotId | null;
  parentEntityId: PanelEntityId | null;
  initialTheme: "light" | "dark";
  gatewayConfig: GatewayConfig;
  env: Record<string, string>;
  effectiveVersion: string | null;
}

// Access globals via globalThis to support VM sandbox environments
// where globals are set on the context object
const g = globalThis as unknown as {
  __vibez1EntityId?: string;
  __vibez1SlotId?: string;
  __vibez1ContextId?: string;
  __vibez1Kind?: "panel" | "shell";
  __vibez1ParentId?: string | null;
  __vibez1ParentEntityId?: string | null;
  __vibez1InitialTheme?: "light" | "dark";
  __vibez1GatewayConfig?: GatewayConfig;
  __vibez1SourceRepo?: string;
  __vibez1EffectiveVersion?: string | null;
  __vibez1Env?: Record<string, string>;
};

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

function normalizeGatewayConfigForBrowser(config: GatewayConfig): GatewayConfig {
  const location = (globalThis as { location?: { origin?: string } }).location;
  if (!location?.origin) return config;

  try {
    const injectedUrl = new URL(config.serverUrl);
    const pageUrl = new URL(location.origin);
    const sameLoopbackPort =
      injectedUrl.protocol === pageUrl.protocol &&
      injectedUrl.port === pageUrl.port &&
      LOOPBACK_HOSTS.has(injectedUrl.hostname) &&
      LOOPBACK_HOSTS.has(pageUrl.hostname);
    if (!sameLoopbackPort || injectedUrl.origin === pageUrl.origin) return config;

    const rewritten = new URL(config.serverUrl);
    rewritten.protocol = pageUrl.protocol;
    rewritten.host = pageUrl.host;
    const aliases = Array.from(new Set([...(config.aliases ?? []), config.serverUrl]));
    return { ...config, serverUrl: rewritten.toString().replace(/\/$/, ""), aliases };
  } catch {
    return config;
  }
}

/**
 * Get the injected configuration from globals.
 */
export function getInjectedConfig(): InjectedConfig {
  const entityId = g.__vibez1EntityId;
  if (typeof entityId === "undefined" || !entityId) {
    throw new Error(
      "Vibez1 runtime globals not found. Expected __vibez1EntityId to be defined."
    );
  }
  if (!g.__vibez1GatewayConfig?.serverUrl || !g.__vibez1GatewayConfig?.token) {
    throw new Error(
      "Vibez1 runtime globals not found. Expected __vibez1GatewayConfig with serverUrl and token."
    );
  }

  const effectiveVersion =
    g.__vibez1EffectiveVersion ?? g.__vibez1Env?.["__VIBEZ1_EFFECTIVE_VERSION"] ?? null;
  const gatewayConfig = normalizeGatewayConfigForBrowser(g.__vibez1GatewayConfig);

  return {
    entityId: entityId as PanelEntityId,
    slotId: g.__vibez1SlotId as PanelSlotId | undefined,
    contextId: g.__vibez1ContextId ?? "",
    kind: g.__vibez1Kind ?? "panel",
    parentId:
      typeof g.__vibez1ParentId === "string" && g.__vibez1ParentId.length > 0
        ? (g.__vibez1ParentId as PanelSlotId)
        : null,
    parentEntityId:
      typeof g.__vibez1ParentEntityId === "string" && g.__vibez1ParentEntityId.length > 0
        ? (g.__vibez1ParentEntityId as PanelEntityId)
        : null,
    initialTheme: g.__vibez1InitialTheme === "dark" ? "dark" : "light",
    gatewayConfig,
    env: g.__vibez1Env ?? {},
    effectiveVersion,
  };
}
