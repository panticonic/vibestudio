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

await esbuild.build({
  ...shared,
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.js",
});

await esbuild.build({
  ...shared,
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
});

console.log("headless-host build complete");
