import { createHash } from "node:crypto";

/** Local host identity or the authenticated Iroh public endpoint, plus this paired device. */
export function nativeStorageScope(
  transport: "local" | "iroh",
  host: string,
  deviceId: string
): string {
  if (!host || !deviceId)
    throw new Error("Native storage requires an authenticated host and device");
  return createHash("sha256")
    .update(JSON.stringify([transport, host, deviceId]))
    .digest("hex");
}

/** A server-selected environment/context key never names a native profile on its own. */
export function scopedNativePartition(scope: string, partition: string): string {
  if (!scope || !partition) throw new Error("Native partition requires an authenticated scope");
  return `persist:workspace:${createHash("sha256")
    .update(JSON.stringify([scope, partition]))
    .digest("hex")}`;
}
