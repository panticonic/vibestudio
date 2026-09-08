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
