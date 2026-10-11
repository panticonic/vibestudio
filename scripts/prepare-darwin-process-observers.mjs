#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { prepareDarwinProcessObserver } from "./owned-process-group-observer.mjs";

export function prepareDarwinProcessObservers(cwd) {
  if (process.platform !== "darwin") {
    throw new Error("Preparing both Darwin process observers requires macOS and its SDK");
  }
  return ["arm64", "x64"].map((arch) => prepareDarwinProcessObserver({ cwd, arch }));
}

async function main() {
  const cwd = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  const outputs = prepareDarwinProcessObservers(cwd);
  for (const output of outputs) console.log(`[darwin-observer] verified ${output}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
