import * as esbuild from "esbuild";
import { isVerbose, logVerbose } from "@vibestudio/dev-log";

type ExactBuildOptions<T extends esbuild.BuildOptions> = T & {
  [Key in Exclude<keyof T, keyof esbuild.BuildOptions>]: never;
};

export type EsbuildRun = <T extends esbuild.BuildOptions>(
  options: ExactBuildOptions<T>
) => Promise<esbuild.BuildResult<T>>;

let nextCompileId = 0;
let activeCompileCount = 0;

function entrypoints(options: esbuild.BuildOptions): string[] {
  const configured = options.entryPoints;
  if (!configured) return [];
  if (Array.isArray(configured)) {
    return configured
      .map((entry) => (typeof entry === "string" ? entry : entry.in))
      .filter(Boolean);
  }
  return Object.values(configured);
}

function outputSummary(result: esbuild.BuildResult | undefined) {
  const metafile = result?.metafile;
  if (!metafile) return {};
  const outputs = Object.values(metafile.outputs);
  return {
    metafileInputCount: Object.keys(metafile.inputs).length,
    metafileOutputCount: outputs.length,
    metafileOutputBytes: outputs.reduce((total, output) => total + output.bytes, 0),
  };
}

function diagnosticLog(message: string, details: Record<string, unknown>): void {
  try {
    logVerbose("CompilerProfile", message, details);
  } catch {
    // Diagnostics must not change the build's result or failure.
  }
}

/** Run one esbuild build while emitting bounded lifecycle diagnostics in verbose mode. */
export async function profileEsbuildBuild<T extends esbuild.BuildOptions>(
  options: ExactBuildOptions<T>,
  run: EsbuildRun = esbuild.build
): Promise<esbuild.BuildResult<T>> {
  const compileId = ++nextCompileId;
  const active = ++activeCompileCount;
  const verbose = isVerbose();
  const startedAt = verbose ? performance.now() : undefined;
  const identity = verbose
    ? {
        compileId,
        pid: process.pid,
        activeCompileCount: active,
        parentRssBytes: process.memoryUsage().rss,
        entrypoints: entrypoints(options),
        cwd: options.absWorkingDir ?? process.cwd(),
        outdir: options.outdir,
      }
    : undefined;
  let result: esbuild.BuildResult<T> | undefined;
  let loadedModules = 0;

  if (verbose && identity) diagnosticLog("compile started", identity);

  try {
    if (!verbose) {
      result = await run<T>(options);
      return result;
    }

    const observer: esbuild.Plugin = {
      name: "vibestudio-compiler-profile",
      setup(build) {
        build.onLoad({ filter: /.*/ }, () => {
          loadedModules += 1;
          if (loadedModules % 1024 === 0) {
            diagnosticLog("compile progress", { ...identity, loadedModules });
          }
          return null;
        });
      },
    };
    const diagnosticOptions = {
      ...options,
      plugins: [observer, ...(options.plugins ?? [])],
    } as ExactBuildOptions<T>;
    result = await run<T>(diagnosticOptions);
    return result;
  } finally {
    activeCompileCount -= 1;
    if (verbose) {
      diagnosticLog("compile finished", {
        ...(identity ?? {}),
        activeCompileCount: activeCompileCount,
        parentRssBytes: process.memoryUsage().rss,
        durationMs: startedAt === undefined ? undefined : performance.now() - startedAt,
        loadedModules,
        state: result ? "succeeded" : "failed",
        ...outputSummary(result),
      });
    }
  }
}
