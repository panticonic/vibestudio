import * as path from "node:path";
import * as fsp from "node:fs/promises";
import * as crypto from "node:crypto";
import * as ts from "typescript/unstable/ast";
import type { CompilerOptions, Program, Project } from "typescript/unstable/sync";
import { sha256Canonical } from "@vibestudio/shared/authority/invocationSnapshot";
import {
  TypeCheckService,
  createDiskFileSource,
  loadSourceFiles,
  type WorkspaceContext,
  type WorkspacePackageInfo,
} from "@vibestudio/typecheck";
import {
  analyzeWorkspaceServiceCalls,
  type AuthorityFoldUnit,
  type WorkspaceServiceCallFact,
} from "./userlandAuthorityAnalyzer.js";
import { consumerAuthorityFacts } from "./authorityEffectBoundary.js";
import type { AuthorityCompilerDependency } from "./authorityAnalysisCache.js";

export type AuthorityCompilerSnapshotUnit = AuthorityFoldUnit;

export interface AuthorityCompilerGroup {
  fingerprint: string;
  units: readonly AuthorityCompilerSnapshotUnit[];
}

export interface AuthorityCompilerSnapshot {
  /** Consumers compiled under exact, normalized compiler-option groups. */
  groups: readonly AuthorityCompilerGroup[];
  /** Provider-independent facts composed from each consumer's reachable files. */
  factsByConsumer: ReadonlyMap<string, readonly WorkspaceServiceCallFact[]>;
  /** Exact non-workspace compiler/configuration inputs for cache revalidation. */
  dependenciesByConsumer: ReadonlyMap<string, readonly AuthorityCompilerDependency[]>;
  /** Exact workspace-source import edges used for consumer composition. */
  importsByFile: ReadonlyMap<string, ReadonlySet<string>>;
  timings: {
    sourceLoadMs: number;
    programMs: number;
    maxProgramMs: number;
    importGraphMs: number;
    analyzerMs: number;
    compositionMs: number;
    native: {
      requestCount: number;
      roundTripMs: number;
      serverTimeMs: number;
      transportOverheadMs: number;
      bytesSent: number;
      bytesReceived: number;
      sourceFilesFetched: number;
      nodesFetched: number;
      nodesMaterialized: number;
    };
  };
}

export interface CreateAuthorityCompilerSnapshotInput {
  sourceRoot: string;
  /** Units which need facts; remaining units are resolution-only dependencies. */
  consumerNames?: ReadonlySet<string>;
  units: readonly AuthorityCompilerSnapshotUnit[];
  nodeModulesPaths: readonly string[];
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

const CHECK_IRRELEVANT_COMPILER_OPTIONS = new Set([
  "configFile",
  "configFilePath",
  "outDir",
  "outFile",
  "declarationDir",
  "tsBuildInfoFile",
  "sourceRoot",
  "mapRoot",
  "pathsBasePath",
]);

async function hasOwnTsconfig(sourceRoot: string, unit: AuthorityCompilerSnapshotUnit) {
  try {
    const stats = await fsp.stat(path.join(sourceRoot, unit.relativePath, "tsconfig.json"));
    return stats.isFile();
  } catch {
    return false;
  }
}

function canonicalCompilerValue(value: unknown, sourceRoot: string): unknown {
  if (typeof value === "string") {
    return path.isAbsolute(value) ? path.relative(sourceRoot, value).replace(/\\/gu, "/") : value;
  }
  if (Array.isArray(value)) return value.map((child) => canonicalCompilerValue(child, sourceRoot));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key, child]) => !CHECK_IRRELEVANT_COMPILER_OPTIONS.has(key) && child !== undefined
        )
        .map(([key, child]) => [key, canonicalCompilerValue(child, sourceRoot)])
    );
  }
  return value;
}

function compilerFingerprint(options: Readonly<CompilerOptions>, sourceRoot: string): string {
  return sha256Canonical({ version: 1, options: canonicalCompilerValue(options, sourceRoot) });
}

async function packageInfo(
  sourceRoot: string,
  unit: AuthorityCompilerSnapshotUnit
): Promise<WorkspacePackageInfo> {
  const dir = path.resolve(sourceRoot, unit.relativePath);
  let packageJson: WorkspacePackageInfo["packageJson"] = { name: unit.name };
  try {
    packageJson = JSON.parse(await fsp.readFile(path.join(dir, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    // The exact graph identity still supplies the package name. A malformed or
    // missing package manifest remains the caller's graph/build diagnostic.
  }
  return { name: unit.name, dir, packageJson };
}

function programSourceFiles(program: Program): ts.SourceFile[] {
  return program.getSourceFileNames().flatMap((fileName) => {
    if (fileName.startsWith("/@typescript/lib/")) return [];
    const sourceFile = program.getSourceFile(fileName);
    return sourceFile ? [sourceFile] : [];
  });
}

function resolvedImportGraphs(
  project: Project,
  sourceFiles: readonly ts.SourceFile[],
  workspaceFiles: ReadonlySet<string>
): {
  workspace: Map<string, ReadonlySet<string>>;
  all: Map<string, ReadonlySet<string>>;
} {
  const checker = project.checker;
  const workspace = new Map<string, ReadonlySet<string>>();
  const all = new Map<string, ReadonlySet<string>>();
  for (const sourceFile of sourceFiles) {
    const source = path.resolve(sourceFile.fileName);
    const imports = new Set<string>();
    const workspaceImports = new Set<string>();
    // TypeScript already records every static import, re-export, import-equals,
    // require(), and dynamic import on SourceFile. Reading that compact index
    // avoids walking and materializing the full remote AST. Resolving the
    // indexed nodes also preserves the compiler's exact module semantics.
    const symbols = checker.getSymbolAtLocation(sourceFile.imports);
    for (const symbol of symbols) {
      for (const declaration of symbol?.declarations ?? []) {
        const target = path.resolve(declaration.path);
        imports.add(target);
        if (workspaceFiles.has(target)) workspaceImports.add(target);
      }
    }
    all.set(source, imports);
    if (workspaceFiles.has(source)) workspace.set(source, workspaceImports);
  }
  return { workspace, all };
}

function contentHash(content: string | Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

async function nearestPackageManifest(file: string): Promise<string | null> {
  let directory = path.dirname(file);
  for (;;) {
    const candidate = path.join(directory, "package.json");
    try {
      if ((await fsp.stat(candidate)).isFile()) return candidate;
    } catch {
      // Keep walking toward the filesystem root.
    }
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

async function compilerDependencies(
  sourceFiles: readonly ts.SourceFile[],
  reachable: ReadonlySet<string>,
  sourceRoot: string,
  configFiles: readonly string[],
  cache: Map<string, readonly AuthorityCompilerDependency[]>
): Promise<AuthorityCompilerDependency[]> {
  const contents = new Map<string, string>();
  for (const sourceFile of sourceFiles) {
    const file = path.resolve(sourceFile.fileName);
    if (!reachable.has(file) || isWithin(sourceRoot, file) || file.startsWith("/@typescript/lib/"))
      continue;
    let dependencies = cache.get(file);
    if (!dependencies) {
      const discovered: AuthorityCompilerDependency[] = [
        { path: file, contentHash: contentHash(sourceFile.text) },
      ];
      const manifest = await nearestPackageManifest(file);
      if (manifest && !isWithin(sourceRoot, manifest)) {
        try {
          discovered.push({
            path: manifest,
            contentHash: contentHash(await fsp.readFile(manifest)),
          });
        } catch {
          throw new Error(`Authority compiler dependency disappeared: ${manifest}`);
        }
      }
      dependencies = discovered;
      cache.set(file, dependencies);
    }
    for (const dependency of dependencies) contents.set(dependency.path, dependency.contentHash);
  }
  for (const configFile of configFiles) {
    const file = path.resolve(configFile);
    if (isWithin(sourceRoot, file)) continue;
    let dependencies = cache.get(file);
    if (!dependencies) {
      dependencies = [{ path: file, contentHash: contentHash(await fsp.readFile(file)) }];
      cache.set(file, dependencies);
    }
    for (const dependency of dependencies) contents.set(dependency.path, dependency.contentHash);
  }
  return [...contents]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dependencyPath, hash]) => ({ path: dependencyPath, contentHash: hash }));
}

function reachableFiles(
  roots: readonly string[],
  importsByFile: ReadonlyMap<string, ReadonlySet<string>>
): Set<string> {
  const reachable = new Set<string>();
  const pending = [...roots];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (reachable.has(file)) continue;
    reachable.add(file);
    pending.push(...(importsByFile.get(file) ?? []));
  }
  return reachable;
}

function factsForConsumer(
  facts: readonly WorkspaceServiceCallFact[],
  reachable: ReadonlySet<string>,
  sourceRoot: string,
  consumerName: string
): WorkspaceServiceCallFact[] {
  return consumerAuthorityFacts(facts)
    .filter((fact) => reachable.has(path.resolve(sourceRoot, fact.origin.file)))
    .map((fact) => {
      if (fact.origin.unitName !== consumerName || !fact.origin.package) return fact;
      const { package: _rootPackage, ...origin } = fact.origin;
      return { ...fact, origin };
    });
}

/**
 * Build exact compiler snapshots grouped by normalized compiler semantics.
 *
 * Units with identical effective compiler options share one TypeScript Program,
 * regardless of whether those options came from service defaults or an own
 * tsconfig. This retains consumer compiler semantics without paying one Program
 * construction per unit.
 */
export async function createAuthorityCompilerSnapshot(
  input: CreateAuthorityCompilerSnapshotInput
): Promise<AuthorityCompilerSnapshot> {
  const sourceRoot = path.resolve(input.sourceRoot);
  const sourceLoadStartedAt = Date.now();
  const infos = await Promise.all(input.units.map((unit) => packageInfo(sourceRoot, unit)));
  const workspaceContext: WorkspaceContext = {
    monorepoRoot: sourceRoot,
    packages: new Map(infos.map((info) => [info.name, info])),
  };
  const rootsByUnit = new Map<string, string[]>();
  const contentsByFile = new Map<string, string>();
  for (const unit of input.units) {
    const unitDir = path.resolve(sourceRoot, unit.relativePath);
    const files = await loadSourceFiles(createDiskFileSource(unitDir), ".");
    const roots: string[] = [];
    for (const [relativePath, content] of files) {
      const absolute = path.resolve(unitDir, relativePath);
      if (!isWithin(unitDir, absolute)) continue;
      contentsByFile.set(absolute, content);
      roots.push(absolute);
    }
    rootsByUnit.set(unit.name, roots);
  }
  const sourceLoadMs = Date.now() - sourceLoadStartedAt;
  const defaultService = new TypeCheckService({
    panelPath: sourceRoot,
    workspaceContext,
    nodeModulesPaths: [...input.nodeModulesPaths],
    disableTsconfigDiscovery: true,
  });
  const defaultOptions = defaultService.getEffectiveCompilerOptions();
  defaultService.dispose();
  const consumers = input.consumerNames
    ? input.units.filter((unit) => input.consumerNames?.has(unit.name))
    : input.units;
  const profiles = await Promise.all(
    consumers.map(async (unit) => {
      if (!(await hasOwnTsconfig(sourceRoot, unit))) {
        return {
          unit,
          options: defaultOptions,
          configFiles: [] as readonly string[],
          tsconfigPath: null,
        };
      }
      const unitDir = path.resolve(sourceRoot, unit.relativePath);
      const service = new TypeCheckService({
        panelPath: unitDir,
        workspaceContext,
        nodeModulesPaths: [...input.nodeModulesPaths],
        tsconfigSearchBoundary: unitDir,
      });
      try {
        return {
          unit,
          options: service.getEffectiveCompilerOptions(),
          configFiles: service.getCompilerOptionDependencies(),
          tsconfigPath: path.join(unitDir, "tsconfig.json"),
        };
      } finally {
        service.dispose();
      }
    })
  );
  const grouped = new Map<
    string,
    {
      options: Readonly<CompilerOptions>;
      units: AuthorityCompilerSnapshotUnit[];
      configFiles: Set<string>;
      tsconfigPath: string | null;
    }
  >();
  for (const profile of profiles) {
    const fingerprint = compilerFingerprint(profile.options, sourceRoot);
    const group = grouped.get(fingerprint);
    if (group) {
      group.units.push(profile.unit);
      for (const file of profile.configFiles) group.configFiles.add(file);
    } else {
      grouped.set(fingerprint, {
        options: profile.options,
        units: [profile.unit],
        configFiles: new Set(profile.configFiles),
        tsconfigPath: profile.tsconfigPath,
      });
    }
  }

  let programMs = 0;
  let maxProgramMs = 0;
  let importGraphMs = 0;
  let analyzerMs = 0;
  let compositionMs = 0;
  const native = {
    requestCount: 0,
    roundTripMs: 0,
    serverTimeMs: 0,
    transportOverheadMs: 0,
    bytesSent: 0,
    bytesReceived: 0,
    sourceFilesFetched: 0,
    nodesFetched: 0,
    nodesMaterialized: 0,
  };
  const importsByFile = new Map<string, ReadonlySet<string>>();
  const factsByConsumer = new Map<string, readonly WorkspaceServiceCallFact[]>();
  const dependenciesByConsumer = new Map<string, readonly AuthorityCompilerDependency[]>();
  const groups: AuthorityCompilerGroup[] = [];
  for (const [fingerprint, group] of [...grouped].sort(([a], [b]) => a.localeCompare(b))) {
    const service = new TypeCheckService({
      panelPath: sourceRoot,
      workspaceContext,
      nodeModulesPaths: [...input.nodeModulesPaths],
      ...(group.tsconfigPath
        ? { tsconfigPath: group.tsconfigPath }
        : { disableTsconfigDiscovery: true }),
      collectTiming: true,
    });
    for (const unit of group.units) {
      for (const file of rootsByUnit.get(unit.name) ?? []) {
        const content = contentsByFile.get(file);
        if (content !== undefined) service.updateFile(file, content);
      }
    }
    try {
      const programStartedAt = Date.now();
      const project = service.getProject();
      const program = project.program;
      const groupProgramMs = Date.now() - programStartedAt;
      programMs += groupProgramMs;
      maxProgramMs = Math.max(maxProgramMs, groupProgramMs);
      const importGraphStartedAt = Date.now();
      const groupSourceFiles = programSourceFiles(program);
      const groupWorkspaceFiles = new Set(
        groupSourceFiles
          .map((sourceFile) => path.resolve(sourceFile.fileName))
          .filter((file) => isWithin(sourceRoot, file))
      );
      const importGraphs = resolvedImportGraphs(project, groupSourceFiles, groupWorkspaceFiles);
      importGraphMs += Date.now() - importGraphStartedAt;
      const groupImports = importGraphs.workspace;
      const allImports = importGraphs.all;
      const externalFiles = new Set(
        groupSourceFiles
          .map((sourceFile) => path.resolve(sourceFile.fileName))
          .filter((file) => !isWithin(sourceRoot, file))
      );
      const importedTargets = new Set([...allImports.values()].flatMap((imports) => [...imports]));
      const ambientExternalFiles = new Set(
        [...externalFiles].filter((file) => !importedTargets.has(file))
      );
      const dependencyCache = new Map<string, readonly AuthorityCompilerDependency[]>();
      for (const [file, imports] of groupImports) importsByFile.set(file, imports);
      const analyzerStartedAt = Date.now();
      const allFacts = analyzeWorkspaceServiceCalls({
        project,
        sourceRoot,
        unitRelativePath: `.authority-compiler-group/${fingerprint}`,
        units: input.units,
      });
      analyzerMs += Date.now() - analyzerStartedAt;
      const compositionStartedAt = Date.now();
      for (const consumer of group.units) {
        const reachable = reachableFiles(rootsByUnit.get(consumer.name) ?? [], groupImports);
        factsByConsumer.set(
          consumer.name,
          factsForConsumer(allFacts, reachable, sourceRoot, consumer.name)
        );
        const compilerReachable = reachableFiles(rootsByUnit.get(consumer.name) ?? [], allImports);
        for (const ambient of ambientExternalFiles) compilerReachable.add(ambient);
        dependenciesByConsumer.set(
          consumer.name,
          await compilerDependencies(
            groupSourceFiles,
            compilerReachable,
            sourceRoot,
            [...group.configFiles],
            dependencyCache
          )
        );
      }
      compositionMs += Date.now() - compositionStartedAt;
      groups.push({ fingerprint, units: group.units });
    } finally {
      const totals = service.getTimingInfo().totals;
      for (const key of Object.keys(native) as (keyof typeof native)[]) {
        native[key] += totals[key];
      }
      service.dispose();
    }
  }

  return {
    groups,
    factsByConsumer,
    dependenciesByConsumer,
    importsByFile,
    timings: {
      sourceLoadMs,
      programMs,
      maxProgramMs,
      importGraphMs,
      analyzerMs,
      compositionMs,
      native,
    },
  };
}
