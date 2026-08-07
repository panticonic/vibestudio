import * as path from "node:path";
import type { Project } from "typescript/unstable/sync";
import { TypeCheckService, type TypeCheckServiceConfig } from "./service.js";

export interface TypeScriptProjectSource {
  fileName: string;
  content: string;
}

/** Reusable incremental parser for repeated syntax-only repository analysis. */
export class TypeScriptSyntaxService {
  private service: TypeCheckService | null = null;
  private readonly files: readonly string[];
  private readonly root: string;
  private idleDisposal: ReturnType<typeof setTimeout> | null = null;

  constructor(root: string, extensions: readonly ("ts" | "tsx")[] = ["ts", "tsx"]) {
    const absoluteRoot = path.resolve(root);
    this.root = absoluteRoot;
    this.files = extensions.map((extension) =>
      path.join(absoluteRoot, `syntax-source.${extension}`)
    );
  }

  analyze<T>(
    source: string,
    operation: (sourceFiles: readonly import("typescript/unstable/ast").SourceFile[]) => T
  ): T {
    if (this.idleDisposal) clearTimeout(this.idleDisposal);
    const service = this.ensureService();
    for (const fileName of this.files) service.updateFile(fileName, source);
    const program = service.getProject().program;
    const sourceFiles = this.files.flatMap((fileName) => {
      const sourceFile = program.getSourceFile(fileName);
      return sourceFile ? [sourceFile] : [];
    });
    try {
      return operation(sourceFiles);
    } finally {
      // Synchronous repository folds call analyze repeatedly in one turn. Keep
      // that project warm, then release the native child before the next turn.
      this.idleDisposal = setTimeout(() => this.dispose(), 0);
    }
  }

  dispose(): void {
    if (this.idleDisposal) clearTimeout(this.idleDisposal);
    this.idleDisposal = null;
    this.service?.dispose();
    this.service = null;
  }

  private ensureService(): TypeCheckService {
    return (this.service ??= new TypeCheckService({
      panelPath: this.root,
      workspaceContext: null,
      disableTsconfigDiscovery: true,
      skipSuggestions: true,
    }));
  }
}

/**
 * Run a synchronous compiler-API operation inside an explicitly owned native
 * TypeScript 7 project. AST nodes, symbols, and handles never escape the
 * snapshot lifetime; callers return only their derived application data.
 */
export function usingTypeScriptProject<T>(
  sources: readonly TypeScriptProjectSource[],
  operation: (project: Project) => T,
  config: Omit<TypeCheckServiceConfig, "panelPath"> = {}
): T {
  if (sources.length === 0) throw new Error("A TypeScript project requires at least one source");
  const absoluteSources = sources.map((source) => ({
    ...source,
    fileName: path.resolve(source.fileName),
  }));
  const service = new TypeCheckService({
    panelPath: path.dirname(absoluteSources[0]!.fileName),
    workspaceContext: null,
    disableTsconfigDiscovery: true,
    skipSuggestions: true,
    ...config,
  });
  for (const source of absoluteSources) service.updateFile(source.fileName, source.content);
  try {
    return operation(service.getProject());
  } finally {
    service.dispose();
  }
}
