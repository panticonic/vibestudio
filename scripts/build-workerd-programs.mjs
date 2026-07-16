import * as esbuild from "esbuild";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const entries = {
  router: "src/server/workerdPrograms/router.ts",
  "worker-host": "src/server/workerdPrograms/workerHost.ts",
  "universal-do": "src/server/workerdPrograms/universalDo.ts",
};

const outputNames = {
  router: "router.mjs",
  workerHost: "worker-host.mjs",
  universalDo: "universal-do.mjs",
};

/**
 * Compile the three host-managed workerd programs from their canonical typed
 * source modules. The same function serves production builds and focused
 * workerd integration tests, so compiler options cannot drift.
 */
export async function buildWorkerdPrograms(options = {}) {
  const outdir = options.outdir ?? "dist/workerd-programs";
  const write = options.write ?? true;
  const result = await esbuild.build({
    entryPoints: entries,
    bundle: true,
    platform: "browser",
    target: "es2022",
    format: "esm",
    outdir,
    entryNames: "[name]",
    outExtension: { ".js": ".mjs" },
    conditions: ["worker", "browser"],
    external: ["cloudflare:workers"],
    sourcemap: false,
    minify: options.minify ?? false,
    logOverride: options.logOverride,
    write,
  });

  if (write) {
    return {
      router: fs.readFileSync(path.join(outdir, outputNames.router), "utf8"),
      workerHost: fs.readFileSync(path.join(outdir, outputNames.workerHost), "utf8"),
      universalDo: fs.readFileSync(path.join(outdir, outputNames.universalDo), "utf8"),
    };
  }

  const outputs = new Map(
    (result.outputFiles ?? []).map((file) => [path.basename(file.path), file.text])
  );
  const readOutput = (name) => {
    const source = outputs.get(name);
    if (typeof source !== "string") throw new Error(`Missing compiled workerd program: ${name}`);
    return source;
  };
  return {
    router: readOutput(outputNames.router),
    workerHost: readOutput(outputNames.workerHost),
    universalDo: readOutput(outputNames.universalDo),
  };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  await buildWorkerdPrograms();
}
