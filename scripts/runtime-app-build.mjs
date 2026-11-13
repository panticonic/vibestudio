import path from "node:path";
import { runtimeAppEntrypointSource } from "./lib/runtime-app.mjs";

/** One compiler recipe for the host producer and owned native fixtures. */
export function runtimeAppBuildOptions({ cwd = process.cwd(), minify = false, sourcemap = false } = {}) {
  return {
    absWorkingDir: cwd,
    entryPoints: [{ in: "runtime-app:entry", out: "runtime-app" }],
    tsconfig: "tsconfig.json",
    bundle: true,
    platform: "browser",
    target: "es2022",
    format: "esm",
    outdir: "dist/runtime-app",
    outExtension: { ".js": ".mjs" },
    write: false,
    metafile: true,
    conditions: ["worker", "browser"],
    external: ["node:*", "cloudflare:*", "electron"],
    minify,
    sourcemap,
    plugins: [
      {
        name: "runtime-app-entrypoint",
        setup(build) {
          build.onResolve({ filter: /^runtime-app:/ }, ({ path: entry }) => ({
            path: entry,
            namespace: "runtime-app-entry",
          }));
          build.onLoad({ filter: /.*/, namespace: "runtime-app-entry" }, () => ({
            contents: runtimeAppEntrypointSource(),
            loader: "ts",
            resolveDir: path.resolve(cwd, "src/server/workerdPrograms"),
          }));
        },
      },
    ],
  };
}

export function runtimeAppCompilerOutput(result, cwd = process.cwd()) {
  const output = (result.outputFiles ?? []).find((file) => file.path.endsWith(".mjs"));
  if (!output) throw new Error("Missing runtime app compiler output");
  const coordinate = path.relative(cwd, output.path).split(path.sep).join("/");
  const metadata = result.metafile?.outputs[coordinate];
  if (!metadata) throw new Error("Missing runtime app compiler metadata");
  return { bundle: output.text, exports: metadata.exports };
}
