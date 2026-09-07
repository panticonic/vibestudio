import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { BuildProviderInput } from "@vibestudio/shared/buildProvider";

/** Native providers consume one workspace-owned, immutable input closure.
 * Host/shared npm caches and temporary compiler projections are never mounted
 * into the workspace native domain. Keep this lease through artifact reads. */
export async function prepareBuildProviderResources(options: {
  buildsRoot: string;
  sourceRoot: string;
  input: BuildProviderInput;
  materialize(source: string, destination: string): Promise<void>;
}): Promise<{ input: BuildProviderInput; dispose(): Promise<void> }> {
  await mkdir(options.buildsRoot, { recursive: true });
  const buildsRoot = await realpath(options.buildsRoot);
  const inputsRoot = path.join(buildsRoot, ".provider-inputs");
  await mkdir(inputsRoot, { recursive: true });
  if ((await realpath(inputsRoot)) !== inputsRoot) {
    throw new Error("Build provider input anchor must be owned by the host");
  }
  const directory = await mkdtemp(path.join(inputsRoot, "input-"));
  const sourceRoot = path.resolve(options.sourceRoot);
  const projected = new Map<string, string>();
  try {
    const sources = [
      ...new Set(
        [
          options.input.sourcePath,
          ...Object.values(options.input.dependencyProjection.modules),
        ].map((source) => path.resolve(source))
      ),
    ].sort((a, b) => a.length - b.length || a.localeCompare(b));
    for (const source of sources) {
      const parent = [...projected].find(([candidate]) => source.startsWith(candidate + path.sep));
      if (parent) {
        projected.set(source, path.join(parent[1], path.relative(parent[0], source)));
        continue;
      }
      const relative = path.relative(sourceRoot, source);
      const workspaceSource =
        relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
      const destination = workspaceSource
        ? path.join(directory, "workspace", relative)
        : path.join(directory, "platform", createHash("sha256").update(source).digest("hex"));
      await options.materialize(source, destination);
      projected.set(source, destination);
    }
    let nodeModulesPath: string | null = null;
    if (options.input.dependencyProjection.nodeModulesPath) {
      nodeModulesPath = path.join(directory, "node_modules");
      await options.materialize(
        options.input.dependencyProjection.nodeModulesPath,
        nodeModulesPath
      );
    }
    return {
      input: {
        ...options.input,
        sourcePath: projected.get(path.resolve(options.input.sourcePath))!,
        dependencyProjection: {
          nodeModulesPath,
          modules: Object.fromEntries(
            Object.entries(options.input.dependencyProjection.modules).map(([name, source]) => [
              name,
              projected.get(path.resolve(source))!,
            ])
          ),
        },
      },
      dispose: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
