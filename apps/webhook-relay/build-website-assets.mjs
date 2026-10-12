import { tsImport } from "tsx/esm/api";
import { copyFile, cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { runOwnedCleanupSteps, runWithOwnedCleanup } from "../../scripts/lib/owned-cleanup.mjs";

const appRoot = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(appRoot, "../..");
export async function buildWebsiteAssets(outDir = path.join(root, "dist/apex-website-assets")) {
  const assetOutput = path.resolve(outDir);
  const runtimeOutput = await mkdtemp(path.join(os.tmpdir(), "vibestudio-website-runtime-"));
  await runWithOwnedCleanup(
    async () => {
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
      await cp(path.join(appRoot, "site"), path.join(assetOutput, "site"), { recursive: true });
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
    },
    async () => {
      await runOwnedCleanupSteps(
        [() => rm(runtimeOutput, { recursive: true, force: true })],
        "Website asset cleanup failed"
      );
    },
    "Website asset build and cleanup failed"
  );
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { "out-dir": { type: "string" } } });
  const { retireUserlandProjectionProcess } = await tsImport(
    "../../scripts/lib/userland-projection-process-owner.ts",
    import.meta.url
  );
  await runWithOwnedCleanup(
    () => buildWebsiteAssets(values["out-dir"]),
    () => retireUserlandProjectionProcess(),
    "Website asset process cleanup failed"
  );
}
