import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import { buildMethods, type BuildUnitCatalogEntry } from "@vibestudio/service-schemas/build";
import { BUILDABLE_UNIT_DIRS } from "@vibestudio/workspace-contracts/sourceDirs";
import type { BuildSystemV2 } from "../buildV2/index.js";
import { computeBuildKey } from "../buildV2/effectiveVersion.js";
import { diagnosticsForBuildKey, diagnosticsForUnit } from "../buildV2/diagnosticsStore.js";

const SKILLS_PACKAGE_SCOPE = (() => {
  const scope = BUILDABLE_UNIT_DIRS.find((d) => d.dir === "skills")?.scope;
  if (!scope) throw new Error("BUILDABLE_UNIT_DIRS is missing the skills scope");
  return scope;
})();

export function createBuildService(deps: {
  buildSystem: BuildSystemV2;
  listUnits: () => BuildUnitCatalogEntry[];
}): ServiceDefinition {
  return {
    name: "build",
    description: "Build system (getBuild, getBuildNpm, recompute, gc, getAboutPages)",
    authority: { principals: ["code", "user", "host"] },
    methods: buildMethods,
    handler: defineServiceHandler("build", buildMethods, {
      listUnits: () => deps.listUnits(),
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
      getBuildMetadata: (_ctx, [key, options]) => {
        const bs = deps.buildSystem;
        const build = bs.getBuildByKey(key);
        if (!build) return null;
        const metadata =
          options?.includeExecutableModules === false
            ? (({ executableModules: _executableModules, ...compact }) => compact)(build.metadata)
            : build.metadata;
        const diagnostics =
          diagnosticsForBuildKey(key) ?? diagnosticsForUnit(build.metadata.name) ?? undefined;
        return diagnostics && diagnostics.length > 0 ? { ...metadata, diagnostics } : metadata;
      },
      getBuildReport: (_ctx, [unit, ref]) => deps.buildSystem.getBuildReport(unit, ref),
      getPerformanceProfile: async (_ctx, [unit, ref, options]) => {
        const startedAt = Date.now();
        const firstStartedAt = performance.now();
        const report = await deps.buildSystem.getBuildReport(unit, ref);
        const firstElapsedMs = performance.now() - firstStartedAt;
        const targets = report.builds.flatMap((target) => {
          if (!target.buildKey) return [];
          const build = deps.buildSystem.getBuildByKey(target.buildKey);
          if (!build) return [];
          const artifacts = build.artifacts
            .map((artifact) => {
              const bytes =
                artifact.byteLength ??
                (artifact.encoding === "base64"
                  ? Buffer.from(artifact.content, "base64").byteLength
                  : Buffer.byteLength(artifact.content));
              return { path: artifact.path, role: artifact.role, bytes };
            })
            .sort((left, right) => right.bytes - left.bytes);
          const executableModules = build.metadata.executableModules ?? [];
          return [
            {
              target: target.target,
              buildKey: target.buildKey,
              builtAt: build.metadata.builtAt,
              artifactCount: artifacts.length,
              artifactBytes: artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0),
              largestArtifacts: artifacts.slice(0, 20),
              executableModuleCount: executableModules.length,
              executableSourceBytes: executableModules.reduce(
                (sum, module) => sum + Buffer.byteLength(module.source),
                0
              ),
              ...(build.metadata.bundleReport ? { bundleReport: build.metadata.bundleReport } : {}),
            },
          ];
        });
        const builtTimes = targets
          .map((target) => Date.parse(target.builtAt))
          .filter(Number.isFinite);
        const cacheState =
          targets.length === 0 || builtTimes.length === 0
            ? "unknown"
            : builtTimes.some((builtAt) => builtAt >= startedAt)
              ? "built-during-profile"
              : "preexisting";
        let verifiedCacheRun: { elapsedMs: number; sameBuildKeys: boolean } | undefined;
        if (options?.verifyCache !== false && report.status === "ok") {
          const warmStartedAt = performance.now();
          const cached = await deps.buildSystem.getBuildReport(unit, ref);
          const firstKeys = report.builds.map((build) => build.buildKey ?? null);
          const cachedKeys = cached.builds.map((build) => build.buildKey ?? null);
          verifiedCacheRun = {
            elapsedMs: performance.now() - warmStartedAt,
            sameBuildKeys:
              firstKeys.length === cachedKeys.length &&
              firstKeys.every((key, index) => key === cachedKeys[index]),
          };
        }
        return {
          version: 1 as const,
          source: unit,
          ...(ref ? { ref } : {}),
          startedAt,
          firstRun: { elapsedMs: firstElapsedMs, cacheState },
          ...(verifiedCacheRun ? { verifiedCacheRun } : {}),
          report,
          targets,
        };
      },
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
      recompute: () => deps.buildSystem.recompute(),
      gc: () => deps.buildSystem.gc(),
      inspectExecution: (_ctx, [executionDigest]) =>
        deps.buildSystem.inspectExecution(executionDigest),
      getAboutPages: () => deps.buildSystem.getAboutPages(),
      hasUnit: (_ctx, [unit]) => deps.buildSystem.hasUnit(unit),
      getPanelMetadata: async (_ctx, [unit, ref]) => {
        const node = (await deps.buildSystem.listBuildUnits(ref, ["panel"])).find(
          (candidate) => candidate.unitName === unit || candidate.unitPath === unit
        );
        if (!node) return null;
        const declaredIcon = node.manifest.icon;
        const resolvedIcon = declaredIcon?.startsWith("./")
          ? await deps.buildSystem.getUnitIcon(node.unitPath, declaredIcon.slice(2))
          : null;
        return {
          source: node.unitPath,
          title: node.manifest.title ?? node.unitName,
          icon: resolvedIcon
            ? `data:${resolvedIcon.contentType};base64,${resolvedIcon.body.toString("base64")}`
            : declaredIcon,
          description: node.manifest.description,
          hiddenInLauncher: node.manifest.hiddenInLauncher ?? false,
          stateArgs: node.manifest.stateArgs,
          autoArchiveWhenEmpty: node.manifest.autoArchiveWhenEmpty,
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
