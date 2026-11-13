#!/usr/bin/env node
// Stage a celld fork build as this checkout's runtime payload:
//   node scripts/stage-native-celld.mjs --from /path/to/celld [--platform linux --arch x64]
// The binary must be the one native/celld/targets.json names for the target.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nativeCelldTarget, stageNativeCelld } from "./native-celld-artifacts.mjs";

const args = process.argv.slice(2);
const value = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const from = value("--from");
if (!from) {
  console.error("usage: stage-native-celld.mjs --from PATH [--platform P] [--arch A]");
  process.exit(2);
}
const target = nativeCelldTarget(value("--platform"), value("--arch"));
const appRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
console.log(stageNativeCelld(path.resolve(from), appRoot, target));
