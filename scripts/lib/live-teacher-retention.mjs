import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const nativeStorageRetentionEnvironmentKey = "VIBESTUDIO_RETAIN_NATIVE_STORAGE";
/** Only explicit 0 opts out; preserve the rest of the launcher environment. */
export function liveTeacherEnvironment(environment = process.env) {
  return { ...environment, [nativeStorageRetentionEnvironmentKey]: environment[nativeStorageRetentionEnvironmentKey] === "0" ? "0" : "1" };
}
/** Move complete joined supervisor generations, including both custody subtrees. */
export function moveRetainedState({ retained, destination, instance, stopped }) {
  if (!stopped) throw new Error("Retained state requires joined managed shutdown");
  const entries = readdirSync(retained);
  for (const entry of entries) {
    const target = path.join(destination, entry);
    if (existsSync(target)) throw new Error(`Retained state destination already exists: ${target}`);
  }
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const entry of entries) renameSync(path.join(retained, entry), path.join(destination, entry));
  writeFileSync(path.join(destination, "retention.json"), JSON.stringify({ instance, original: retained, stopped, archived: false }) + "\n", { mode: 0o600 });
}
