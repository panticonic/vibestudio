import { tsImport } from "tsx/esm/api";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const appRoot = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(appRoot, "../..");
export async function buildWebsiteAssets(outDir = path.join(root, "dist/apex-website-assets")) {
  const assetOutput = path.resolve(outDir);
  const runtimeOutput = await mkdtemp(path.join(os.tmpdir(), "vibestudio-website-runtime-"));
  try {
    const { buildWebsiteRuntime } = await tsImport(
      "../../scripts/build-website-runtime.ts",
      import.meta.url
    );
    await buildWebsiteRuntime({ outDir: runtimeOutput });

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
      await copyFile(
        path.join(root, "build-resources/brand", asset),
        path.join(brandOutput, asset)
      );
    }

    console.log(`Built Vibestudio website assets in ${assetOutput}`);
  } finally {
    await rm(runtimeOutput, { recursive: true, force: true });
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { "out-dir": { type: "string" } } });
  await buildWebsiteAssets(values["out-dir"]);
}
