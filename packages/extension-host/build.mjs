import * as esbuild from "esbuild";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Publish mode (VIBESTUDIO_EXTHOST_PUBLISH=1) emits a fully self-contained bundle
// into dist-publish/ for npm packaging: @vibestudio/extension and
// @vibestudio/process-adapter are inlined too (on top of the always-inlined
// source-only @vibestudio/shared + unit-host), so the published server package can
// vendor *just* this package and resolve on any Node >=20 with no
// workspace:* and no source-.ts imports at runtime. The default (dev/monorepo)
// build keeps those two external to avoid the dual-package hazard for other
// in-repo consumers (and skips the publish-only dist-publish/ output).
const PUBLISH = process.env.VIBESTUDIO_EXTHOST_PUBLISH === "1";
const outdir = PUBLISH ? "dist-publish" : "dist";

fs.rmSync(outdir, { recursive: true, force: true });
fs.mkdirSync(outdir, { recursive: true });

// Bundle JS for the host entry and the forked-child runtime entry. Runtime JS
// must not resolve @vibestudio/shared directly: shared is a source-only package
// whose exports point at .ts files with NodeNext-style .js specifiers.
await esbuild.build({
  entryPoints: ["src/index.ts", "src/childRuntime.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outdir,
  sourcemap: true,
  banner: {
    js: `
import { createRequire as __createRequire } from "node:module";
const require = __createRequire(import.meta.url);
`.trim(),
  },
  // electron is never bundled: process-adapter loads it lazily via createRequire
  // only inside Electron, so it stays a runtime-optional require in both modes.
  external: PUBLISH
    ? ["electron"]
    : ["@vibestudio/extension", "@vibestudio/process-adapter"],
});

if (PUBLISH) {
  console.log("extension-host publish build complete (self-contained → dist-publish/)");
} else {
  // Emit real .d.ts files alongside the bundled JS (dev build only — the npm
  // publish bundle ships runtime JS, not types). Use the project's
  // tsconfig.build.json with --emitDeclarationOnly so tsc doesn't double-write
  // the JavaScript that esbuild already produced.
  const tscBin = require.resolve("typescript/lib/tsc.js");
  execFileSync(
    process.execPath,
    [tscBin, "--project", "tsconfig.build.json", "--emitDeclarationOnly"],
    { stdio: "inherit", cwd: path.dirname(new URL(import.meta.url).pathname) },
  );
}
