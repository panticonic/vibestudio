import * as path from "node:path";
import * as esbuild from "esbuild";

// Separate calls each parse the same dependency graph. Compatible entrypoints
// belong to one compiler invocation; independent compiler realms can run concurrently.
export function groupBuildArtifacts(configs) {
  const identities = new Map();
  const identity = (value) => {
    if (typeof value === "function") {
      if (!identities.has(value)) identities.set(value, identities.size);
      return { functionIdentity: identities.get(value) };
    }
    if (Array.isArray(value)) return value.map(identity);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, identity(value[key])])
      );
    return value;
  };
  const groups = new Map();
  for (const config of configs) {
    const { entryPoints, outfile, outdir: configuredOutdir, ...options } = config;
    const outdir = configuredOutdir ?? (outfile ? path.dirname(outfile) : undefined);
    if (!outdir || !entryPoints?.length)
      throw new Error("Host artifacts require explicit entries and an output directory");
    const extension = outfile ? path.extname(outfile) : (options.outExtension?.[".js"] ?? ".js");
    const normalizedOptions = {
      ...options,
      outdir,
      outExtension: { ...options.outExtension, ".js": extension },
    };
    const key = JSON.stringify(identity(normalizedOptions));
    let group = groups.get(key);
    if (!group) {
      group = { ...normalizedOptions, entryPoints: [] };
      groups.set(key, group);
    }
    if (outfile) {
      if (entryPoints.length !== 1) throw new Error("An outfile owns exactly one entrypoint");
      group.entryPoints.push({ in: entryPoints[0], out: path.basename(outfile, extension) });
    } else group.entryPoints.push(...entryPoints);
  }
  return [...groups.values()];
}

export async function buildArtifactGroups(configs, build = esbuild.build) {
  const outcomes = await Promise.allSettled(
    groupBuildArtifacts(configs).map(async (group) => build({ ...group, metafile: true }))
  );
  const failures = outcomes.flatMap((outcome) =>
    outcome.status === "rejected" ? [outcome.reason] : []
  );
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Host compiler realms failed");
  return outcomes.map((outcome) => outcome.value);
}
