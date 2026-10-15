import path from "node:path";
import {
  INTERNAL_DO_PROGRAM_ENTRIES,
  internalDoEntrypointSource,
} from "./lib/internal-do-programs.mjs";

/** One compiler recipe for both the host producer and owned native fixtures. */
export function internalDoBuildOptions({
  cwd = process.cwd(),
  minify = false,
  sourcemap = false,
} = {}) {
  return {
    absWorkingDir: cwd,
    entryPoints: INTERNAL_DO_PROGRAM_ENTRIES.map(({ className }) => ({
      in: `internal-do:${className}`,
      out: className,
    })),
    bundle: true,
    platform: "browser",
    target: "es2022",
    format: "esm",
    outdir: "dist/internal-do-programs",
    outExtension: { ".js": ".mjs" },
    write: false,
    metafile: true,
    conditions: ["worker", "browser"],
    external: ["node:*", "electron"],
    minify,
    sourcemap,
    plugins: [
      {
        name: "product-internal-do-entrypoints",
        setup(build) {
          build.onResolve({ filter: /^internal-do:/ }, ({ path: entry }) => ({
            path: entry.slice("internal-do:".length),
            namespace: "internal-do-entry",
          }));
          build.onLoad({ filter: /.*/, namespace: "internal-do-entry" }, ({ path: className }) => ({
            contents: internalDoEntrypointSource(className),
            loader: "ts",
            resolveDir: path.resolve(cwd, "src/server/internalDOs"),
          }));
        },
      },
    ],
  };
}

export function internalDoCompilerOutputs(result, cwd = process.cwd()) {
  const compiled = {};
  for (const output of result.outputFiles ?? []) {
    if (!output.path.endsWith(".mjs")) continue;
    const className = path.basename(output.path, ".mjs");
    const coordinate = path.relative(cwd, output.path).split(path.sep).join("/");
    const metadata = result.metafile?.outputs[coordinate];
    if (!metadata) throw new Error(`Missing internal DO compiler metadata: ${className}`);
    compiled[className] = { bundle: output.text, exports: metadata.exports };
  }
  return compiled;
}
