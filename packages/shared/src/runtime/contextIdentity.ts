import { sha256HexSyncText } from "@vibestudio/content-addressing";

/** The resource identity is known before an uncertain provisioning reply. */
export function contextIdForTargetKey(targetKey: string): string {
  if (!targetKey) throw new Error("Context provisioning requires an operation key");
  return `ctx-${sha256HexSyncText(targetKey).slice(0, 32)}`;
}
