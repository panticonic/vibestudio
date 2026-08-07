/**
 * Native TypeScript project service for Vibestudio source graphs.
 *
 * TypeScript 7 owns project construction, module resolution, incremental
 * snapshots, diagnostics, and editor semantics. Vibestudio contributes only a
 * filesystem projection: unsaved source overlays plus workspace/external
 * package mounts for materialized graphs that intentionally have no local
 * node_modules tree.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import {
  API,
  CompletionItemKind,
  DiagnosticCategory,
  SymbolFlags,
  type CompilerOptions,
  type Diagnostic,
  type Program,
  type Project,
  type Snapshot,
  type TimingInfo,
} from "typescript/unstable/sync";
import type { FileSystemEntries } from "typescript/unstable/fs";
import {
  discoverWorkspaceContext,
  type WorkspaceContext,
  type WorkspacePackageInfo,
} from "./lib/index.js";

const require = createRequire(import.meta.url);

export interface BaseDiagnostic {
  file: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  message: string;
  severity: "error" | "warning" | "info";
}

export interface TypeCheckDiagnostic extends BaseDiagnostic {
  code: number;
  category: DiagnosticCategory;
  reportsUnnecessary?: boolean;
  reportsDeprecated?: boolean;
  relatedInformation?: TypeCheckDiagnostic[];
}

export interface TypeCheckResult {
  panelPath: string;
  diagnostics: TypeCheckDiagnostic[];
  timestamp: number;
  checkedFiles: string[];
}

export interface QuickInfo {
  displayParts: string;
  documentation?: string;
  tags?: { name: string; text?: string }[];
}

export interface CompletionInfo {
  isIncomplete: boolean;
  entries: readonly CompletionEntry[];
}

export interface CompletionEntry {
  name: string;
  kind: string;
  sortText?: string;
  insertText?: string;
  filterText?: string;
  detail?: string;
  labelDetails?: { detail?: string; description?: string };
}

export interface DefinitionInfo {
  fileName: string;
  textSpan: { start: number; length: number };
  name: string;
}

export interface ReferenceInfo {
  fileName: string;
  textSpan: { start: number; length: number };
}

export interface TypeCheckServiceConfig {
  /** Root path and compiler working directory for the checked unit. */
  panelPath: string;
  /** External dependency roots projected as node_modules ancestors. */
  nodeModulesPaths?: string[];
  /** Override effective compiler options. Check-only invariants remain enforced. */
  compilerOptions?: Readonly<Record<string, unknown>>;
  /** Pre-discovered workspace package projection. */
  workspaceContext?: WorkspaceContext | null;
  /** Skip suggestion diagnostics. */
  skipSuggestions?: boolean;
  /** Do not discover a parent tsconfig.json. */
  disableTsconfigDiscovery?: boolean;
  /** Inclusive upper boundary for parent tsconfig discovery. */
  tsconfigSearchBoundary?: string;
  /** Use this exact source tsconfig instead of discovery. */
  tsconfigPath?: string;
  /** Collect native compiler request and transport timings. */
  collectTiming?: boolean;
}

interface OverlayFile {
  content: string;
}

/**
 * Stateful TypeScript 7 project backed by one native compiler process.
 *
 * Callers may update several files before asking a question. The next query
 * publishes one immutable native snapshot containing the whole batch.
 */
export class TypeCheckService {
  private readonly config: TypeCheckServiceConfig;
  private readonly panelPath: string;
  private readonly configFilePath: string;
  private readonly workspaceContext: WorkspaceContext | null;
  private readonly nodeModulesPaths: readonly string[];
  private readonly hasNodeTypeDefinitions: boolean;
  private readonly files = new Map<string, OverlayFile>();
  private readonly compilerOptionDependencies = new Set<string>();
  private readonly createdFiles = new Set<string>();
  private readonly changedFiles = new Set<string>();
  private readonly deletedFiles = new Set<string>();
  private readonly api: API;
  private snapshot: Snapshot | null = null;
  private project: Project | null = null;
  private sourceConfigPath: string | null = null;
  private configContent = "";
  private opened = false;
  private disposed = false;

  constructor(config: TypeCheckServiceConfig) {
    this.config = config;
    this.panelPath = path.resolve(config.panelPath);
    this.configFilePath = path.join(this.panelPath, ".vibestudio-typecheck.tsconfig.json");
    this.nodeModulesPaths = (config.nodeModulesPaths ?? []).map((root) => path.resolve(root));
    // The native compiler's automatic @types discovery does not cross the
    // projected filesystem boundary. Opt into Node's ambient declarations when
    // one of the explicitly supplied dependency roots actually provides them.
    // This keeps hermetic browser projects closed-world while making a host
    // package's Node imports type-check the same way as the repository tsconfig.
    this.hasNodeTypeDefinitions = this.nodeModulesPaths.some((root) =>
      fs.existsSync(path.join(root, "@types", "node", "package.json"))
    );
    this.workspaceContext =
      config.workspaceContext === null
        ? null
        : (config.workspaceContext ?? discoverWorkspaceContext(this.panelPath));
    this.sourceConfigPath = this.resolveSourceConfig();
    if (this.sourceConfigPath) this.collectConfigDependencies(this.sourceConfigPath);

    this.api = new API({
      cwd: this.panelPath,
      collectTiming: config.collectTiming,
      fs: {
        readFile: (fileName) => this.readProjectedFile(fileName),
        fileExists: (fileName) => this.projectedFileExists(fileName),
        directoryExists: (directoryName) => this.projectedDirectoryExists(directoryName),
        getAccessibleEntries: (directoryName) => this.getProjectedEntries(directoryName),
        realpath: (fileName) => this.projectedRealpath(fileName),
      },
    });
  }

  updateFile(filePath: string, content: string): void {
    this.assertActive();
    const absolute = path.resolve(filePath);
    const existing = this.files.get(absolute);
    if (existing?.content === content) return;
    this.files.set(absolute, { content });
    this.deletedFiles.delete(absolute);
    if (existing) this.changedFiles.add(absolute);
    else this.createdFiles.add(absolute);
  }

  removeFile(filePath: string): void {
    this.assertActive();
    const absolute = path.resolve(filePath);
    if (!this.files.delete(absolute)) return;
    if (!this.createdFiles.delete(absolute)) this.deletedFiles.add(absolute);
    this.changedFiles.delete(absolute);
  }

  hasFile(filePath: string): boolean {
    return this.files.has(path.resolve(filePath));
  }

  getFileNames(): string[] {
    return [...this.files.keys()];
  }

  getEffectiveCompilerOptions(): Readonly<CompilerOptions> {
    return { ...this.ensureProject().compilerOptions };
  }

  getCompilerOptionDependencies(): readonly string[] {
    return [...this.compilerOptionDependencies].sort();
  }

  check(filePath?: string): TypeCheckResult {
    const project = this.ensureProject();
    const document = filePath ? path.resolve(filePath) : undefined;
    const diagnostics: Diagnostic[] = [
      ...project.program.getConfigFileParsingDiagnostics(),
      ...project.program.getProgramDiagnostics(),
      ...project.program.getGlobalDiagnostics(),
      ...project.program.getSyntacticDiagnostics(document),
      ...project.program.getSemanticDiagnostics(document),
    ];
    if (!this.config.skipSuggestions) {
      diagnostics.push(...project.program.getSuggestionDiagnostics(document));
    }

    return {
      panelPath: this.panelPath,
      diagnostics: diagnostics.map((diagnostic) => this.convertDiagnostic(diagnostic)),
      timestamp: Date.now(),
      checkedFiles: document ? [document] : this.getFileNames(),
    };
  }

  getQuickInfo(filePath: string, line: number, column: number): QuickInfo | null {
    const project = this.ensureProject();
    const position = this.getPosition(project, filePath, line, column);
    if (position === undefined) return null;
    const absolute = path.resolve(filePath);
    const rawSymbol = project.checker.getSymbolAtPosition(absolute, position);
    const symbol =
      rawSymbol && rawSymbol.flags & SymbolFlags.Alias
        ? project.checker.getAliasedSymbol(rawSymbol)
        : rawSymbol;
    const type = project.checker.getTypeAtPosition(absolute, position);
    const semanticSymbol = symbol && !project.checker.isUnknownSymbol(symbol) ? symbol : undefined;
    if (!semanticSymbol && !type) return null;
    const documentation = semanticSymbol?.getDocumentationComment(project.checker) || undefined;
    const tags = semanticSymbol?.getJsDocTags(project.checker).map((tag) => ({
      name: tag.name,
      ...(tag.text ? { text: tag.text } : {}),
    }));
    return {
      displayParts: type ? project.checker.typeToString(type) : (semanticSymbol?.name ?? ""),
      ...(documentation ? { documentation } : {}),
      ...(tags && tags.length > 0 ? { tags } : {}),
    };
  }

  getCompletions(filePath: string, line: number, column: number): CompletionInfo | undefined {
    const project = this.ensureProject();
    const position = this.getPosition(project, filePath, line, column);
    if (position === undefined) return undefined;
    const completions = project.checker.getCompletionsAtPosition(path.resolve(filePath), position);
    if (!completions) return undefined;
    return {
      isIncomplete: completions.isIncomplete,
      entries: completions.entries.map((entry) => ({
        name: entry.name,
        kind:
          entry.kind === undefined
            ? "unknown"
            : (CompletionItemKind[entry.kind] ?? "unknown").toLowerCase(),
        ...(entry.sortText !== undefined ? { sortText: entry.sortText } : {}),
        ...(entry.insertText !== undefined ? { insertText: entry.insertText } : {}),
        ...(entry.filterText !== undefined ? { filterText: entry.filterText } : {}),
        ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
        ...(entry.labelDetails !== undefined ? { labelDetails: { ...entry.labelDetails } } : {}),
      })),
    };
  }

  getDefinition(
    filePath: string,
    line: number,
    column: number
  ): readonly DefinitionInfo[] | undefined {
    const project = this.ensureProject();
    const position = this.getPosition(project, filePath, line, column);
    if (position === undefined) return undefined;
    const symbol = project.checker.getSymbolAtPosition(path.resolve(filePath), position);
    if (!symbol) return undefined;
    const definitionSymbol =
      symbol.flags & SymbolFlags.Alias ? project.checker.getAliasedSymbol(symbol) : symbol;
    if (project.checker.isUnknownSymbol(definitionSymbol)) return undefined;
    const definitions = definitionSymbol.declarations.map((handle) => {
      const node = handle.resolve(project);
      const start = node?.getStart() ?? 0;
      const end = node?.end ?? start;
      return {
        fileName: handle.path,
        textSpan: { start, length: Math.max(0, end - start) },
        name: definitionSymbol.name,
      };
    });
    return definitions.length > 0 ? definitions : undefined;
  }

  getReferences(
    filePath: string,
    line: number,
    column: number
  ): readonly ReferenceInfo[] | undefined {
    const project = this.ensureProject();
    const position = this.getPosition(project, filePath, line, column);
    if (position === undefined) return undefined;
    const rawSymbol = project.checker.getSymbolAtPosition(path.resolve(filePath), position);
    if (!rawSymbol) return undefined;
    const symbol =
      rawSymbol.flags & SymbolFlags.Alias ? project.checker.getAliasedSymbol(rawSymbol) : rawSymbol;
    if (project.checker.isUnknownSymbol(symbol)) return undefined;
    const references = project.program.getSourceFileNames().flatMap((sourceFile) =>
      project.checker.getReferencesToSymbolInFile(sourceFile, symbol).flatMap((handle) => {
        const node = handle.resolve(project);
        if (!node) return [];
        const start = node.getStart();
        return [
          {
            fileName: handle.path,
            textSpan: { start, length: Math.max(0, node.end - start) },
          },
        ];
      })
    );
    return references.length > 0 ? references : undefined;
  }

  getProgram(): Program {
    return this.ensureProject().program;
  }

  /**
   * Return the complete native semantic project. Compiler-API consumers need
   * this rather than a detached Program because symbols and node handles are
   * intentionally scoped to the immutable project snapshot.
   */
  getProject(): Project {
    return this.ensureProject();
  }

  getTimingInfo(): TimingInfo {
    this.assertActive();
    return this.api.getTimingInfo();
  }

  resetTimingInfo(): void {
    this.assertActive();
    this.api.resetTimingInfo();
  }

  startCpuProfile(directory: string): void {
    this.assertActive();
    this.api.internal.startCPUProfile(path.resolve(directory));
  }

  stopCpuProfile(): string {
    this.assertActive();
    return this.api.internal.stopCPUProfile();
  }

  saveHeapProfile(directory: string): string {
    this.assertActive();
    return this.api.internal.saveHeapProfile(path.resolve(directory));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.snapshot?.dispose();
    this.snapshot = null;
    this.project = null;
    this.api.close();
  }

  private ensureProject(): Project {
    this.assertActive();
    this.synchronizeGeneratedConfig();
    if (
      this.project &&
      this.createdFiles.size === 0 &&
      this.changedFiles.size === 0 &&
      this.deletedFiles.size === 0
    ) {
      return this.project;
    }

    const previous = this.snapshot;
    const fileChanges = {
      ...(this.createdFiles.size > 0 ? { created: [...this.createdFiles] } : {}),
      ...(this.changedFiles.size > 0 ? { changed: [...this.changedFiles] } : {}),
      ...(this.deletedFiles.size > 0 ? { deleted: [...this.deletedFiles] } : {}),
    };
    this.snapshot = this.api.updateSnapshot({
      ...(!this.opened ? { openProjects: [this.configFilePath] } : {}),
      ...(this.opened && Object.keys(fileChanges).length > 0 ? { fileChanges } : {}),
    });
    this.opened = true;
    this.project =
      this.snapshot.getProject(this.configFilePath) ?? this.snapshot.getProjects()[0] ?? null;
    previous?.dispose();
    this.createdFiles.clear();
    this.changedFiles.clear();
    this.deletedFiles.clear();
    if (!this.project) {
      throw new Error(`TypeScript 7 did not create a project for ${this.configFilePath}`);
    }
    return this.project;
  }

  private synchronizeGeneratedConfig(): void {
    const compilerOptions: Record<string, unknown> = this.sourceConfigPath
      ? {
          skipLibCheck: true,
          composite: false,
          incremental: false,
          declaration: false,
          declarationMap: false,
          emitDeclarationOnly: false,
          rootDir: path.parse(this.panelPath).root,
          rootDirs: [],
          paths: {},
          ...this.config.compilerOptions,
          noEmit: true,
        }
      : {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          jsx: "react-jsx",
          lib: [
            "ES2022",
            "ES2023.Array",
            "ES2023.Collection",
            "ES2023.Intl",
            "ESNext.Disposable",
            "ES2025.Iterator",
            "ES2024.Promise",
            "DOM",
            "DOM.Iterable",
          ],
          strict: true,
          esModuleInterop: true,
          allowSyntheticDefaultImports: true,
          resolveJsonModule: true,
          isolatedModules: true,
          allowJs: true,
          checkJs: false,
          skipLibCheck: true,
          ...(this.hasNodeTypeDefinitions ? { types: ["node"] } : {}),
          ...this.config.compilerOptions,
          noEmit: true,
        };
    const content = `${JSON.stringify(
      {
        ...(this.sourceConfigPath ? { extends: this.sourceConfigPath } : {}),
        compilerOptions,
        files: this.getFileNames(),
      },
      null,
      2
    )}\n`;
    if (content === this.configContent) return;
    const existed = this.configContent.length > 0;
    this.configContent = content;
    if (existed) this.changedFiles.add(this.configFilePath);
    else this.createdFiles.add(this.configFilePath);
  }

  private convertDiagnostic(diagnostic: Diagnostic): TypeCheckDiagnostic {
    const fileName = diagnostic.fileName ? path.resolve(diagnostic.fileName) : "";
    const sourceFile = fileName ? this.project?.program.getSourceFile(fileName) : undefined;
    const start = sourceFile?.getLineAndCharacterOfPosition(diagnostic.pos);
    const end = sourceFile?.getLineAndCharacterOfPosition(diagnostic.end);
    return {
      file: fileName,
      line: (start?.line ?? 0) + 1,
      column: (start?.character ?? 0) + 1,
      ...(end ? { endLine: end.line + 1, endColumn: end.character + 1 } : {}),
      message: this.flattenDiagnosticMessage(diagnostic),
      code: diagnostic.code,
      category: diagnostic.category,
      severity: this.categoryToSeverity(diagnostic.category),
      ...(diagnostic.reportsUnnecessary ? { reportsUnnecessary: true } : {}),
      ...(diagnostic.reportsDeprecated ? { reportsDeprecated: true } : {}),
      ...(diagnostic.relatedInformation && diagnostic.relatedInformation.length > 0
        ? {
            relatedInformation: diagnostic.relatedInformation.map((related) =>
              this.convertDiagnostic(related)
            ),
          }
        : {}),
    };
  }

  private flattenDiagnosticMessage(diagnostic: Diagnostic): string {
    const children = diagnostic.messageChain ?? [];
    if (children.length === 0) return diagnostic.text;
    return [diagnostic.text, ...children.map((child) => this.flattenDiagnosticMessage(child))]
      .filter(Boolean)
      .join("\n");
  }

  private categoryToSeverity(category: DiagnosticCategory): "error" | "warning" | "info" {
    if (category === DiagnosticCategory.Error) return "error";
    if (category === DiagnosticCategory.Warning) return "warning";
    return "info";
  }

  private getPosition(
    project: Project,
    filePath: string,
    line: number,
    column: number
  ): number | undefined {
    const sourceFile = project.program.getSourceFile(path.resolve(filePath));
    if (!sourceFile) return undefined;
    try {
      return sourceFile.getPositionOfLineAndCharacter(line - 1, column - 1);
    } catch {
      return undefined;
    }
  }

  private resolveSourceConfig(): string | null {
    if (this.config.disableTsconfigDiscovery) return null;
    if (this.config.tsconfigPath) {
      const explicit = path.resolve(this.config.tsconfigPath);
      return fs.existsSync(explicit) ? explicit : null;
    }
    const boundary = this.config.tsconfigSearchBoundary
      ? path.resolve(this.config.tsconfigSearchBoundary)
      : null;
    let directory = this.panelPath;
    for (let level = 0; level < 3; level++) {
      const candidate = path.join(directory, "tsconfig.json");
      if (fs.existsSync(candidate)) return candidate;
      if (boundary && directory === boundary) break;
      const parent = path.dirname(directory);
      if (parent === directory) break;
      if (boundary) {
        const relative = path.relative(boundary, parent);
        if (relative === ".." || relative.startsWith(`..${path.sep}`)) break;
      }
      directory = parent;
    }
    return null;
  }

  private collectConfigDependencies(configPath: string): void {
    const absolute = path.resolve(configPath);
    if (this.compilerOptionDependencies.has(absolute)) return;
    this.compilerOptionDependencies.add(absolute);
    let source: string;
    try {
      source = fs.readFileSync(absolute, "utf8");
    } catch {
      return;
    }
    const specifier = source.match(/"extends"\s*:\s*"([^"]+)"/u)?.[1];
    if (!specifier) return;
    try {
      const resolved =
        specifier.startsWith(".") || path.isAbsolute(specifier)
          ? path.resolve(path.dirname(absolute), specifier)
          : require.resolve(specifier, { paths: [path.dirname(absolute)] });
      const candidate = fs.existsSync(resolved) ? resolved : `${resolved}.json`;
      if (fs.existsSync(candidate)) this.collectConfigDependencies(candidate);
    } catch {
      // Native TypeScript will report an unresolved extends entry as a config diagnostic.
    }
  }

  private readProjectedFile(fileName: string): string | null | undefined {
    const absolute = path.resolve(fileName);
    if (absolute === this.configFilePath) return this.configContent;
    const overlay = this.files.get(absolute);
    if (overlay) return overlay.content;
    for (const candidate of this.packageProjectionCandidates(absolute)) {
      try {
        if (fs.statSync(candidate).isFile()) return fs.readFileSync(candidate, "utf8");
      } catch {
        // Try the next projection, then the real filesystem fallback.
      }
    }
    return undefined;
  }

  private projectedFileExists(fileName: string): boolean | undefined {
    const absolute = path.resolve(fileName);
    if (absolute === this.configFilePath || this.files.has(absolute)) return true;
    for (const candidate of this.packageProjectionCandidates(absolute)) {
      try {
        if (fs.statSync(candidate).isFile()) return true;
      } catch {
        // Continue.
      }
    }
    return undefined;
  }

  private projectedDirectoryExists(directoryName: string): boolean | undefined {
    const absolute = path.resolve(directoryName);
    if (this.hasVirtualDirectory(absolute)) return true;
    for (const candidate of this.packageProjectionCandidates(absolute)) {
      try {
        if (fs.statSync(candidate).isDirectory()) return true;
      } catch {
        // Continue.
      }
    }
    return undefined;
  }

  private getProjectedEntries(directoryName: string): FileSystemEntries | undefined {
    const absolute = path.resolve(directoryName);
    const files = new Set<string>();
    const directories = new Set<string>();
    for (const virtualFile of [this.configFilePath, ...this.files.keys()]) {
      if (path.dirname(virtualFile) === absolute) files.add(path.basename(virtualFile));
      else if (this.isWithin(absolute, virtualFile)) {
        const relative = path.relative(absolute, virtualFile);
        const first = relative.split(path.sep)[0];
        if (first) directories.add(first);
      }
    }
    for (const candidate of this.packageProjectionCandidates(absolute)) {
      try {
        for (const entry of fs.readdirSync(candidate, { withFileTypes: true })) {
          if (entry.isDirectory()) directories.add(entry.name);
          else if (entry.isFile()) files.add(entry.name);
        }
      } catch {
        // Continue.
      }
    }
    this.addWorkspaceEntryNames(absolute, directories);
    return files.size > 0 || directories.size > 0
      ? { files: [...files].sort(), directories: [...directories].sort() }
      : undefined;
  }

  private projectedRealpath(fileName: string): string | undefined {
    const absolute = path.resolve(fileName);
    if (absolute === this.configFilePath || this.files.has(absolute)) return absolute;
    for (const candidate of this.packageProjectionCandidates(absolute)) {
      try {
        return fs.realpathSync(candidate);
      } catch {
        // Continue.
      }
    }
    return undefined;
  }

  private packageProjectionCandidates(candidate: string): string[] {
    const marker = `${path.sep}node_modules${path.sep}`;
    const markerIndex = candidate.lastIndexOf(marker);
    if (markerIndex < 0) return [];
    const packagePath = candidate.slice(markerIndex + marker.length);
    const result: string[] = [];
    const workspace = this.workspacePackageProjection(packagePath);
    if (workspace) result.push(workspace);
    for (const root of this.nodeModulesPaths) result.push(path.join(root, packagePath));
    return result;
  }

  private workspacePackageProjection(packagePath: string): string | null {
    const parts = packagePath.split(path.sep);
    const packageName = parts[0]?.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? "");
    if (!packageName) return null;
    const info = this.workspaceContext?.packages.get(packageName);
    if (!info) return null;
    const consumed = packageName.startsWith("@") ? 2 : 1;
    return path.join(info.dir, ...parts.slice(consumed));
  }

  private addWorkspaceEntryNames(directory: string, entries: Set<string>): void {
    const suffix = this.nodeModulesSuffix(directory);
    if (suffix === null || !this.workspaceContext) return;
    const parts = suffix ? suffix.split(path.sep) : [];
    for (const info of this.workspaceContext.packages.values()) {
      const nameParts = info.name.split("/");
      if (parts.length === 0) entries.add(nameParts[0]!);
      else if (parts.length === 1 && parts[0]?.startsWith("@") && nameParts[0] === parts[0]) {
        if (nameParts[1]) entries.add(nameParts[1]);
      }
    }
  }

  private nodeModulesSuffix(candidate: string): string | null {
    const terminal = `${path.sep}node_modules`;
    if (candidate.endsWith(terminal)) return "";
    const marker = `${terminal}${path.sep}`;
    const index = candidate.lastIndexOf(marker);
    return index < 0 ? null : candidate.slice(index + marker.length);
  }

  private hasVirtualDirectory(directory: string): boolean {
    if (directory === this.panelPath) return true;
    for (const file of [this.configFilePath, ...this.files.keys()]) {
      if (this.isWithin(directory, file)) return true;
    }
    const suffix = this.nodeModulesSuffix(directory);
    if (suffix === null) return false;
    if (suffix === "") return this.nodeModulesPaths.length > 0 || Boolean(this.workspaceContext);
    return this.packageProjectionCandidates(directory).some((candidate) => {
      try {
        return fs.statSync(candidate).isDirectory();
      } catch {
        return false;
      }
    });
  }

  private isWithin(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("TypeCheckService has been disposed");
  }
}

export type { CompilerOptions, Program, Project } from "typescript/unstable/sync";
export type { WorkspacePackageInfo };
