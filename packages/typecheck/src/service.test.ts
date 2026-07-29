import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { TypeCheckService } from "./service.js";
import { clearWorkspaceContextCache } from "./lib/workspace-packages.js";

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  // Symlinks on macOS resolve to /private/var/... — use realpath so the
  // service's internal path comparisons match.
  const real = fs.realpathSync(dir);
  tempDirs.push(real);
  return real;
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  clearWorkspaceContextCache();
});

describe("TypeCheckService workspace resolution", () => {
  it("honors an exact tsconfig search boundary instead of adopting parent workspace config", () => {
    const root = createTempDir("typecheck-service-config-boundary-");
    const unitDir = path.join(root, "packages", "unit");
    const sourceFile = path.join(unitDir, "index.ts");
    writeFile(
      path.join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: false } })
    );
    writeFile(sourceFile, "export function identity(value) { return value; }\n");

    const inherited = new TypeCheckService({
      panelPath: unitDir,
      skipSuggestions: true,
      workspaceContext: null,
    });
    inherited.updateFile(sourceFile, fs.readFileSync(sourceFile, "utf8"));
    expect(inherited.check(sourceFile).diagnostics.filter((d) => d.severity === "error")).toEqual(
      []
    );

    const exact = new TypeCheckService({
      panelPath: unitDir,
      skipSuggestions: true,
      workspaceContext: null,
      tsconfigSearchBoundary: unitDir,
    });
    exact.updateFile(sourceFile, fs.readFileSync(sourceFile, "utf8"));
    expect(
      exact
        .check(sourceFile)
        .diagnostics.some((diagnostic) =>
          diagnostic.message.includes("implicitly has an 'any' type")
        )
    ).toBe(true);
  });

  it("provides the standard decorator context globals in hermetic builds", () => {
    const root = createTempDir("typecheck-service-decorators-");
    const sourceFile = path.join(root, "index.ts");
    writeFile(
      sourceFile,
      [
        "function rpc(value: () => void, context: ClassMethodDecoratorContext): void {",
        "  void value; void context;",
        "}",
        "class DecoratedService { @rpc run(): void {} }",
      ].join("\n")
    );
    const service = new TypeCheckService({
      panelPath: root,
      skipSuggestions: true,
      disableTsconfigDiscovery: true,
      workspaceContext: null,
    });
    service.updateFile(sourceFile, fs.readFileSync(sourceFile, "utf8"));

    const errors = service.check(sourceFile).diagnostics.filter((d) => d.severity === "error");
    expect(errors).toEqual([]);
  });

  it("resolves a workspace package from its source via the workspace context map", () => {
    // Build a minimal pnpm-workspace-style monorepo:
    //   <root>/pnpm-workspace.yaml           (packages: ["packages/*"])
    //   <root>/packages/runtime/package.json (name: "@vibestudio/runtime", exports: ./src/index.ts)
    //   <root>/packages/runtime/src/index.ts (exports RuntimeThing)
    //   <root>/packages/consumer/package.json
    //   <root>/packages/consumer/index.ts    (imports @vibestudio/runtime)
    const root = createTempDir("typecheck-service-workspace-");

    writeFile(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");

    // The producer package
    writeFile(
      path.join(root, "packages", "runtime", "package.json"),
      JSON.stringify(
        {
          name: "@vibestudio/runtime",
          type: "module",
          exports: { ".": "./src/index.ts" },
        },
        null,
        2
      )
    );
    writeFile(
      path.join(root, "packages", "runtime", "src", "index.ts"),
      "export interface RuntimeThing { ok: boolean }\n"
    );

    // The consumer package (this is what we type-check)
    writeFile(
      path.join(root, "packages", "consumer", "package.json"),
      JSON.stringify({ name: "@workspace/consumer", type: "module" }, null, 2)
    );
    const consumerFile = path.join(root, "packages", "consumer", "index.ts");
    writeFile(
      consumerFile,
      [
        'import type { RuntimeThing } from "@vibestudio/runtime";',
        "const value: RuntimeThing = { ok: true };",
        "void value;",
      ].join("\n")
    );

    const service = new TypeCheckService({
      panelPath: path.join(root, "packages", "consumer"),
      skipSuggestions: true,
      disableTsconfigDiscovery: true,
    });

    service.updateFile(consumerFile, fs.readFileSync(consumerFile, "utf-8"));

    const result = service.check(consumerFile);
    const unresolvedModules = result.diagnostics.filter((d) => d.code === 2307);
    expect(unresolvedModules).toHaveLength(0);
    const errors = result.diagnostics.filter((d) => d.severity === "error");
    expect(errors).toHaveLength(0);
  });

  it("returns a Cannot-find-module error for an import that doesn't resolve", () => {
    const root = createTempDir("typecheck-service-workspace-");
    writeFile(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
    const consumerDir = path.join(root, "packages", "consumer");
    writeFile(
      path.join(consumerDir, "package.json"),
      JSON.stringify({ name: "@workspace/consumer", type: "module" }, null, 2)
    );
    const consumerFile = path.join(consumerDir, "index.ts");
    writeFile(consumerFile, 'import { nope } from "@workspace/nonexistent";\nvoid nope;\n');

    const service = new TypeCheckService({
      panelPath: consumerDir,
      skipSuggestions: true,
      disableTsconfigDiscovery: true,
    });
    service.updateFile(consumerFile, fs.readFileSync(consumerFile, "utf-8"));

    const result = service.check(consumerFile);
    const unresolvedModules = result.diagnostics.filter((d) => d.code === 2307);
    expect(unresolvedModules).toHaveLength(1);
  });

  it("resolves external packages from explicit nodeModulesPaths", () => {
    const root = createTempDir("typecheck-service-node-modules-");
    const consumerDir = path.join(root, "workspace", "packages", "consumer");
    const externalNodeModules = path.join(root, "external-deps", "node_modules");

    writeFile(
      path.join(consumerDir, "package.json"),
      JSON.stringify(
        {
          name: "@workspace/consumer",
          type: "module",
          dependencies: {
            "use-stick-to-bottom": "^1.1.3",
          },
        },
        null,
        2
      )
    );
    writeFile(
      path.join(externalNodeModules, "use-stick-to-bottom", "package.json"),
      JSON.stringify(
        {
          name: "use-stick-to-bottom",
          type: "module",
          types: "./dist/index.d.ts",
        },
        null,
        2
      )
    );
    writeFile(
      path.join(externalNodeModules, "use-stick-to-bottom", "dist", "index.d.ts"),
      "export declare function useStickToBottom(): { isAtBottom: boolean };\n"
    );

    const consumerFile = path.join(consumerDir, "index.ts");
    writeFile(
      consumerFile,
      [
        'import { useStickToBottom } from "use-stick-to-bottom";',
        "const state = useStickToBottom();",
        "const atBottom: boolean = state.isAtBottom;",
        "void atBottom;",
      ].join("\n")
    );

    const service = new TypeCheckService({
      panelPath: consumerDir,
      nodeModulesPaths: [externalNodeModules],
      skipSuggestions: true,
      disableTsconfigDiscovery: true,
      workspaceContext: null,
    });

    service.updateFile(consumerFile, fs.readFileSync(consumerFile, "utf-8"));

    const result = service.check(consumerFile);
    const unresolvedModules = result.diagnostics.filter((d) => d.code === 2307);
    expect(unresolvedModules).toHaveLength(0);
    const errors = result.diagnostics.filter((d) => d.severity === "error");
    expect(errors).toHaveLength(0);
  });

  it("prefers DefinitelyTyped declarations for JavaScript package subpaths", () => {
    const root = createTempDir("typecheck-service-definitely-typed-");
    const consumerDir = path.join(root, "workspace", "panels", "consumer");
    const externalNodeModules = path.join(root, "external-deps", "node_modules");

    writeFile(
      path.join(externalNodeModules, "react", "package.json"),
      JSON.stringify({
        name: "react",
        exports: {
          ".": "./index.js",
          "./jsx-runtime": "./jsx-runtime.js",
        },
      })
    );
    writeFile(
      path.join(externalNodeModules, "react", "index.js"),
      "export const runtime = true;\n"
    );
    writeFile(
      path.join(externalNodeModules, "react", "jsx-runtime.js"),
      "export function jsx() {}\n"
    );
    writeFile(
      path.join(externalNodeModules, "@types", "react", "package.json"),
      JSON.stringify({ name: "@types/react", types: "index.d.ts" })
    );
    writeFile(
      path.join(externalNodeModules, "@types", "react", "index.d.ts"),
      "export interface ReactNodeMarker { readonly kind: 'react-node' }\n"
    );
    writeFile(
      path.join(externalNodeModules, "@types", "react", "jsx-runtime.d.ts"),
      "export declare function jsx(type: string): { readonly type: string };\n"
    );

    const sourceFile = path.join(consumerDir, "index.tsx");
    writeFile(
      sourceFile,
      [
        'import type { ReactNodeMarker } from "react";',
        'import { jsx } from "react/jsx-runtime";',
        "const marker: ReactNodeMarker = { kind: 'react-node' };",
        "const elementType: string = jsx('div').type;",
        "void marker; void elementType;",
      ].join("\n")
    );

    const service = new TypeCheckService({
      panelPath: consumerDir,
      nodeModulesPaths: [externalNodeModules],
      skipSuggestions: true,
      disableTsconfigDiscovery: true,
      workspaceContext: null,
    });
    service.updateFile(sourceFile, fs.readFileSync(sourceFile, "utf-8"));

    const errors = service.check(sourceFile).diagnostics.filter((d) => d.severity === "error");
    expect(errors).toEqual([]);
  });
});

describe("TypeCheckService extension augmentation", () => {
  // Extension types follow the same dependency boundary as extension code: a
  // consumer imports the package it uses, activating that package's ordinary
  // `@vibestudio/extension` module augmentation. The sealed runtime stays
  // workspace-independent.
  function buildRuntimeWorkspace(opts: { importExtension: boolean }): {
    root: string;
    panelFile: string;
  } {
    const root = createTempDir("typecheck-registry-");
    writeFile(
      path.join(root, "pnpm-workspace.yaml"),
      "packages:\n  - 'packages/*'\n  - 'extensions/*'\n"
    );

    // @vibestudio/extension: empty registry + use() keyed on it.
    writeFile(
      path.join(root, "packages", "extension", "package.json"),
      JSON.stringify({
        name: "@vibestudio/extension",
        type: "module",
        exports: { ".": "./index.ts" },
      })
    );
    writeFile(
      path.join(root, "packages", "extension", "index.ts"),
      [
        "export interface WorkspaceExtensions {}",
        "export type ExtensionName = keyof WorkspaceExtensions & string;",
        "export function use<K extends ExtensionName>(_n: K): WorkspaceExtensions[K] {",
        "  return undefined as WorkspaceExtensions[K];",
        "}",
      ].join("\n")
    );

    // Extension package that self-registers.
    writeFile(
      path.join(root, "extensions", "foo", "package.json"),
      JSON.stringify({ name: "@ext/foo", type: "module", exports: { ".": "./index.ts" } })
    );
    writeFile(
      path.join(root, "extensions", "foo", "index.ts"),
      [
        "export type Api = { greet(): string };",
        'declare module "@vibestudio/extension" {',
        '  interface WorkspaceExtensions { "@ext/foo": Api }',
        "}",
      ].join("\n")
    );

    // @vibestudio/runtime: generic extension client only.
    writeFile(
      path.join(root, "packages", "runtime", "package.json"),
      JSON.stringify({
        name: "@vibestudio/runtime",
        type: "module",
        exports: { ".": "./src/index.ts" },
      })
    );
    writeFile(
      path.join(root, "packages", "runtime", "src", "index.ts"),
      'export { use } from "@vibestudio/extension";\n'
    );

    // The panel explicitly imports the extension declaration it consumes.
    writeFile(
      path.join(root, "packages", "panel", "package.json"),
      JSON.stringify({ name: "@workspace/panel", type: "module" })
    );
    const panelFile = path.join(root, "packages", "panel", "index.ts");
    writeFile(
      panelFile,
      [
        'import { use } from "@vibestudio/runtime";',
        ...(opts.importExtension ? ['import type {} from "@ext/foo";'] : []),
        'const greeting: string = use("@ext/foo").greet();',
        "void greeting;",
      ].join("\n")
    );
    return { root, panelFile };
  }

  it("resolves use() through the consumer's extension import", () => {
    const { root, panelFile } = buildRuntimeWorkspace({ importExtension: true });
    const service = new TypeCheckService({
      panelPath: path.join(root, "packages", "panel"),
      skipSuggestions: true,
      disableTsconfigDiscovery: true,
    });
    service.updateFile(panelFile, fs.readFileSync(panelFile, "utf-8"));

    const result = service.check(panelFile);
    expect(result.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
  });

  it("rejects an extension name whose declaration was not imported", () => {
    const { root, panelFile } = buildRuntimeWorkspace({ importExtension: false });
    const service = new TypeCheckService({
      panelPath: path.join(root, "packages", "panel"),
      skipSuggestions: true,
      disableTsconfigDiscovery: true,
    });
    service.updateFile(panelFile, fs.readFileSync(panelFile, "utf-8"));

    const result = service.check(panelFile);
    expect(result.diagnostics.filter((d) => d.severity === "error").length).toBeGreaterThan(0);
  });
});
