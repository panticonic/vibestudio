import { assertSingleInfrastructureModuleTree } from "../../scripts/lib/bundle-module-identity.mjs";
import path from "node:path";
// Bundle the headless host with esbuild: workspace packages (@vibestudio/*)
// are TS-source exports, so they get bundled; real npm deps stay external.
import * as esbuild from "esbuild";
import * as fs from "node:fs";

const isDev = process.env.NODE_ENV === "development";

// This package owns its dist tree. Cleaning it prevents a production build
// from copying development-only maps or removed entry points into the host.
fs.rmSync("dist", { recursive: true, force: true });

const shared = {
  bundle: true,
  tsconfig: "tsconfig.json",
  metafile: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: isDev,
  external: ["ws", "@puppeteer/browsers", "zod"],
  banner: {
    // Some transitive CJS deps probe require(); provide it under ESM output.
    js: "import { createRequire as __vibestudioCreateRequire } from 'node:module'; const require = __vibestudioCreateRequire(import.meta.url);",
  },
};

const mainBuild = await esbuild.build({
  ...shared,
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.js",
});

const indexBuild = await esbuild.build({
  ...shared,
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
});

for (const result of [mainBuild, indexBuild])
  assertSingleInfrastructureModuleTree(result.metafile, path.resolve("../.."), process.cwd());

console.log("headless-host build complete");
