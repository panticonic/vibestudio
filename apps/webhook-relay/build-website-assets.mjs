import { execFileSync } from "node:child_process";
import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(appRoot, "../..");
const runtimeOutput = path.join(root, "dist/apex-website-runtime");
const assetOutput = path.join(root, "dist/apex-website-assets");

execFileSync(
  process.execPath,
  [
    path.join(root, "node_modules/tsx/dist/cli.mjs"),
    path.join(root, "scripts/build-website-runtime.ts"),
    "--out-dir",
    runtimeOutput,
  ],
  { cwd: root, stdio: "inherit" }
);

await rm(assetOutput, { recursive: true, force: true });
await mkdir(assetOutput, { recursive: true });
const brandOutput = path.join(assetOutput, "brand");
await mkdir(brandOutput, { recursive: true });
await copyFile(path.join(runtimeOutput, "index.js"), path.join(assetOutput, "runtime.js"));
await copyFile(path.join(appRoot, "src/connect.js"), path.join(assetOutput, "connect.js"));
await copyFile(
  path.join(appRoot, "design/regatta-palettes.html"),
  path.join(assetOutput, "regatta-palettes.html")
);
for (const asset of [
  "favicon.svg",
  "vibestudio-symbol.svg",
  "vibestudio-symbol-dark.svg",
  "vibestudio-logo.svg",
]) {
  await copyFile(path.join(root, "build-resources/brand", asset), path.join(brandOutput, asset));
}

console.log(`Built Vibestudio website assets in ${assetOutput}`);
