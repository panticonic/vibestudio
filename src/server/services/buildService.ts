import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import { buildMethods } from "@vibestudio/service-schemas/build";
import { BUILDABLE_UNIT_DIRS } from "@vibestudio/workspace-contracts/sourceDirs";
import type { BuildSystemV2 } from "../buildV2/index.js";
import { computeBuildKey } from "../buildV2/effectiveVersion.js";
import { diagnosticsForBuildKey, diagnosticsForUnit } from "../buildV2/diagnosticsStore.js";

const SKILLS_PACKAGE_SCOPE = (() => {
  const scope = BUILDABLE_UNIT_DIRS.find((d) => d.dir === "skills")?.scope;
  if (!scope) throw new Error("BUILDABLE_UNIT_DIRS is missing the skills scope");
  return scope;
})();

export function createBuildService(deps: { buildSystem: BuildSystemV2 }): ServiceDefinition {
  return {
    name: "build",
    description: "Build system (getBuild, getBuildNpm, recompute, gc, getAboutPages)",
    authority: { principals: ["code", "user", "host"] },
    methods: buildMethods,
    handler: defineServiceHandler("build", buildMethods, {
      getBuild: (_ctx, [unit, ref, options]) => {
        const bs = deps.buildSystem;
        return options?.library
          ? bs.getBuild(unit, ref, {
              ...options,
              library: true,
            })
          : bs.getBuild(unit, ref, {
              ...options,
              library: false,
            });
      },
      getBuildNpm: (_ctx, [specifier, version, externals]) =>
        deps.buildSystem.getBuildNpm(specifier, version, externals),
      getBuildMetadata: (_ctx, [key]) => {
        const bs = deps.buildSystem;
        const build = bs.getBuildByKey(key);
        if (!build) return null;
        const diagnostics =
          diagnosticsForBuildKey(key) ?? diagnosticsForUnit(build.metadata.name) ?? undefined;
        return diagnostics && diagnostics.length > 0
          ? { ...build.metadata, diagnostics }
          : build.metadata;
      },
      getBuildReport: (_ctx, [unit, ref]) => deps.buildSystem.getBuildReport(unit, ref),
      getEffectiveVersion: (_ctx, [unit]) => deps.buildSystem.getEffectiveVersion(unit),
      inspectBuildProvenance: (_ctx, [source]) => {
        const bs = deps.buildSystem;
        const graph = bs.getGraph();
        const exactNode =
          graph.tryGet(source) ??
          graph
            .allNodes()
            .find((candidate) => candidate.relativePath === source || candidate.path === source);
        const basenameMatches = exactNode
          ? []
          : graph
              .allNodes()
              .filter((candidate) => candidate.relativePath.split("/").slice(-1)[0] === source);
        const node = exactNode ?? (basenameMatches.length === 1 ? basenameMatches[0] : undefined);
        if (!node && basenameMatches.length > 1) {
          return {
            source,
            found: false,
            ambiguous: true,
            workspaceRoot: bs.getWorkspaceRoot(),
            candidates: basenameMatches.map((candidate) => ({
              name: candidate.name,
              kind: candidate.kind,
              relativePath: candidate.relativePath,
            })),
          };
        }
        if (!node) {
          return {
            source,
            found: false,
            workspaceRoot: bs.getWorkspaceRoot(),
          };
        }
        const effectiveVersion = bs.getEffectiveVersion(node.name);
        const buildKeys = effectiveVersion
          ? {
              sourcemap: computeBuildKey(node.name, effectiveVersion, true),
              production: computeBuildKey(node.name, effectiveVersion, false),
            }
          : { sourcemap: null, production: null };
        const cachedBuilds = Object.fromEntries(
          Object.entries(buildKeys).map(([kind, key]) => {
            const build = key ? bs.getBuildByKey(key) : null;
            return [
              kind,
              {
                key,
                cached: !!build,
                artifactCount: build?.artifacts.length ?? 0,
                metadata: build?.metadata ?? null,
              },
            ];
          })
        );
        return {
          source,
          found: true,
          workspaceRoot: bs.getWorkspaceRoot(),
          unit: {
            name: node.name,
            kind: node.kind,
            relativePath: node.relativePath,
            path: node.path,
          },
          effectiveVersion,
          buildKeys,
          cachedBuilds,
          recentBuildEvents: bs.listRecentBuildEvents(node.name),
          diagnostics: bs.getUnitDiagnostics?.(node.name) ?? undefined,
        };
      },
      listRecentBuildEvents: (_ctx, [unit]) => deps.buildSystem.listRecentBuildEvents(unit),
      doctorExtension: (_ctx, [source]) => deps.buildSystem.doctorExtension(source),
      recompute: () => deps.buildSystem.recompute(),
      gc: (_ctx, [activeUnits]) => deps.buildSystem.gc(activeUnits),
      getAboutPages: () => deps.buildSystem.getAboutPages(),
      hasUnit: (_ctx, [unit]) => deps.buildSystem.hasUnit(unit),
      getPanelMetadata: (_ctx, [unit]) => {
        const node = deps.buildSystem.getGraph().tryGet(unit);
        if (!node || node.kind !== "panel") return null;
        return {
          source: node.relativePath,
          title: node.manifest.title ?? node.name,
          description: node.manifest.description,
          hiddenInLauncher: node.manifest.hiddenInLauncher ?? false,
        };
      },
      listSkills: () =>
        deps.buildSystem
          .getGraph()
          .allNodes()
          .filter((n) => n.name.startsWith(SKILLS_PACKAGE_SCOPE))
          .map((n) => ({
            name: n.name,
            path: n.relativePath,
            description: n.manifest.description,
          })),
    }),
  };
}
