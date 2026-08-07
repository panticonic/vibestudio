import * as path from "node:path";
import * as fsp from "node:fs/promises";
import * as crypto from "node:crypto";
import * as ts from "typescript/unstable/ast";
import type {
  CompilerOptions,
  Program,
  Project,
  Symbol as TypeScriptSymbol,
} from "typescript/unstable/sync";
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
    analyzerMs: number;
    compositionMs: number;
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
        .filter(([key, child]) => key !== "configFile" && child !== undefined)
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

function moduleSpecifiers(sourceFile: ts.SourceFile): ts.StringLiteralLikeNode[] {
  const result: ts.StringLiteralLikeNode[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLikeNode(node.moduleSpecifier)
    ) {
      result.push(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLikeNode(node.moduleReference.expression)
    ) {
      result.push(node.moduleReference.expression);
    } else if (
      ts.isCallExpression(node) &&
      node.arguments[0] &&
      ts.isStringLiteralLikeNode(node.arguments[0]) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      result.push(node.arguments[0]);
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
  return result;
}

function sourceFiles(program: Program): ts.SourceFile[] {
  return program.getSourceFileNames().flatMap((fileName) => {
    const sourceFile = program.getSourceFile(fileName);
    return sourceFile ? [sourceFile] : [];
  });
}

function symbolDeclarations(project: Project, symbol: TypeScriptSymbol | undefined): ts.Node[] {
  return (
    symbol?.declarations.flatMap((handle) => {
      const declaration = handle.resolve(project);
      return declaration ? [declaration] : [];
    }) ?? []
  );
}

function resolvedWorkspaceImports(
  project: Project,
  workspaceFiles: ReadonlySet<string>
): Map<string, ReadonlySet<string>> {
  const checker = project.checker;
  const graph = new Map<string, ReadonlySet<string>>();
  for (const sourceFile of sourceFiles(project.program)) {
    const source = path.resolve(sourceFile.fileName);
    if (!workspaceFiles.has(source)) continue;
    const imports = new Set<string>();
    for (const specifier of moduleSpecifiers(sourceFile)) {
      const symbol = checker.getSymbolAtLocation(specifier);
      for (const declaration of symbolDeclarations(project, symbol)) {
        const target = path.resolve(declaration.getSourceFile().fileName);
        if (workspaceFiles.has(target)) imports.add(target);
      }
    }
    graph.set(source, imports);
  }
  return graph;
}

function resolvedImports(project: Project): Map<string, ReadonlySet<string>> {
  const checker = project.checker;
  const graph = new Map<string, ReadonlySet<string>>();
  for (const sourceFile of sourceFiles(project.program)) {
    const source = path.resolve(sourceFile.fileName);
    const imports = new Set<string>();
    for (const specifier of moduleSpecifiers(sourceFile)) {
      const symbol = checker.getSymbolAtLocation(specifier);
      for (const declaration of symbolDeclarations(project, symbol)) {
        imports.add(path.resolve(declaration.getSourceFile().fileName));
      }
    }
    graph.set(source, imports);
  }
  return graph;
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
  program: Program,
  reachable: ReadonlySet<string>,
  sourceRoot: string,
  configFiles: readonly string[],
  cache: Map<string, readonly AuthorityCompilerDependency[]>
): Promise<AuthorityCompilerDependency[]> {
  const contents = new Map<string, string>();
  for (const sourceFile of sourceFiles(program)) {
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
  let analyzerMs = 0;
  let compositionMs = 0;
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
      const groupWorkspaceFiles = new Set(
        sourceFiles(program)
          .map((sourceFile) => path.resolve(sourceFile.fileName))
          .filter((file) => isWithin(sourceRoot, file))
      );
      const groupImports = resolvedWorkspaceImports(project, groupWorkspaceFiles);
      const allImports = resolvedImports(project);
      const externalFiles = new Set(
        sourceFiles(program)
          .map((sourceFile) => path.resolve(sourceFile.fileName))
          .filter((file) => !isWithin(sourceRoot, file) && !file.startsWith("/@typescript/lib/"))
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
            program,
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
      service.dispose();
    }
  }

  return {
    groups,
    factsByConsumer,
    dependenciesByConsumer,
    importsByFile,
    timings: { sourceLoadMs, programMs, maxProgramMs, analyzerMs, compositionMs },
  };
}
