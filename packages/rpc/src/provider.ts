import type { EnvelopeBridge } from "./transports/bridge.js";

/** Public runtime coordinates; credentials and host configuration are never bootstrap data. */
export interface RuntimeConnectionInfo {
  runtimeId: string;
  slotId: string;
  contextId: string;
  parentId: string | null;
  parentEntityId: string | null;
  theme: "light" | "dark";
}

/** A presentation host's document-scoped provider, discoverable without workspace access. */
export interface WorkspaceProvider extends EnvelopeBridge {
  connect(): Promise<{ documentId: string; origin: string; bootstrap: RuntimeConnectionInfo }>;
  disconnect(): Promise<void>;
  onDisconnect(handler: () => void): () => void;
}

/** Select public runtime coordinates; never forward a host's complete bootstrap object. */
export function runtimeConnectionInfoFromBootstrap(
  raw: unknown,
  runtimeId: string
): RuntimeConnectionInfo {
  if (!raw || typeof raw !== "object")
    throw new Error("Browser runtime configuration is unavailable");
  const config = raw as Record<string, unknown>;
  if (config["entityId"] !== runtimeId || typeof config["contextId"] !== "string")
    throw new Error("Browser runtime configuration does not match this document");
  return {
    runtimeId,
    slotId: typeof config["slotId"] === "string" ? config["slotId"] : runtimeId,
    contextId: config["contextId"],
    parentId: typeof config["parentId"] === "string" ? config["parentId"] : null,
    parentEntityId: typeof config["parentEntityId"] === "string" ? config["parentEntityId"] : null,
    theme: config["theme"] === "dark" ? "dark" : "light",
  };
}
