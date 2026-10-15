import type { BuildOptions, BuildResult } from "esbuild";
import type { CompiledInternalDoProgram } from "./lib/internal-do-programs.mjs";
export function internalDoBuildOptions(options?: {
  cwd?: string;
  minify?: boolean;
  sourcemap?: boolean | "inline";
}): BuildOptions;
export function internalDoCompilerOutputs(
  result: BuildResult,
  cwd?: string
): Record<string, CompiledInternalDoProgram>;
