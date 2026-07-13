import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  discoverExtensionPackageNames,
  findExtensionRegistrySinks,
  renderExtensionRegistry,
  writeExtensionRegistry,
  EXTENSION_REGISTRY_SINK_DIRECTIVE,
  EXTENSION_REGISTRY_SINK_FILENAME,
} from "./extensionRegistry.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ext-registry-")));
  tempDirs.push(dir);
  return dir;
}

function write(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

/** Declare a registry sink at `<root>/packages/<relPath>` (workspace-owned opt-in). */
function writeSink(root: string, relPath: string, content?: string): string {
  const sinkPath = path.join(root, "packages", relPath, EXTENSION_REGISTRY_SINK_FILENAME);
  write(sinkPath, content ?? `${EXTENSION_REGISTRY_SINK_DIRECTIVE}\nexport {};\n`);
  return sinkPath;
}

function writeExtension(
  root: string,
  relDir: string,
  name: string,
  opts: { manifestExtension?: boolean; selfRegisters?: boolean } = {},
): void {
  const { manifestExtension = true, selfRegisters = true } = opts;
  write(
    path.join(root, "extensions", relDir, "package.json"),
    JSON.stringify({ name, ...(manifestExtension ? { vibestudio: { extension: {}, entry: "index.ts" } } : {}) }),
  );
  write(
    path.join(root, "extensions", relDir, "index.ts"),
    selfRegisters
      ? `export type Api = {};\ndeclare module "@vibestudio/extension" { interface WorkspaceExtensions { "${name}": Api } }\n`
      : "export type Api = {};\n",
  );
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("renderExtensionRegistry", () => {
  it("renders sorted type-only re-exports with sanitized aliases", () => {
    const out = renderExtensionRegistry([
      "@workspace-extensions/shell",
      "@workspace-extensions/browser-data",
    ]);
    expect(out).toContain('export type { Api as Ext_workspace_extensions_browser_data } from "@workspace-extensions/browser-data";');
    expect(out).toContain('export type { Api as Ext_workspace_extensions_shell } from "@workspace-extensions/shell";');
    // browser-data sorts before shell
    expect(out.indexOf("browser_data")).toBeLessThan(out.indexOf("Ext_workspace_extensions_shell"));
  });

  it("emits an empty module marker when there are no extensions", () => {
    expect(renderExtensionRegistry([])).toContain("export {};");
  });

  it("starts with the sink directive so regenerated files stay sinks", () => {
    expect(renderExtensionRegistry([]).startsWith(`${EXTENSION_REGISTRY_SINK_DIRECTIVE}\n`)).toBe(true);
    expect(
      renderExtensionRegistry(["@a/one"]).startsWith(`${EXTENSION_REGISTRY_SINK_DIRECTIVE}\n`),
    ).toBe(true);
  });

  it("is deterministic and de-duplicates", () => {
    const a = renderExtensionRegistry(["@a/one", "@a/two", "@a/one"]);
    const b = renderExtensionRegistry(["@a/two", "@a/one"]);
    expect(a).toBe(b);
  });
});

describe("discoverExtensionPackageNames", () => {
  it("finds extension packages in flat paths, skipping non-extensions", () => {
    const root = tempDir();
    writeExtension(root, "shell", "@workspace-extensions/shell");
    writeExtension(root, "file-tools", "@workspace-extensions/file-tools");
    writeExtension(root, "standalone-ext", "standalone-ext");
    writeExtension(root, "not-an-ext", "@workspace-extensions/not-an-ext", {
      manifestExtension: false,
    });

    expect(discoverExtensionPackageNames(root).sort()).toEqual([
      "@workspace-extensions/file-tools",
      "@workspace-extensions/shell",
      "standalone-ext",
    ]);
  });

  it("excludes extensions that do not self-register in WorkspaceExtensions", () => {
    const root = tempDir();
    writeExtension(root, "shell", "@workspace-extensions/shell");
    // Infra extension: has the manifest marker but never augments the registry.
    writeExtension(root, "infra", "@workspace-extensions/infra", {
      selfRegisters: false,
    });

    expect(discoverExtensionPackageNames(root)).toEqual(["@workspace-extensions/shell"]);
  });

  it("returns [] when there is no extensions directory", () => {
    expect(discoverExtensionPackageNames(tempDir())).toEqual([]);
  });
});

describe("findExtensionRegistrySinks", () => {
  it("finds declared sinks anywhere inside a workspace package", () => {
    const root = tempDir();
    const deep = writeSink(root, path.join("runtime", "src", "shared"));
    const flat = writeSink(root, "other");
    expect(findExtensionRegistrySinks(root)).toEqual([deep, flat].sort());
  });

  it("ignores same-named files without the directive (workspace opt-out)", () => {
    const root = tempDir();
    writeSink(root, path.join("runtime", "src"), "// not a sink\nexport {};\n");
    expect(findExtensionRegistrySinks(root)).toEqual([]);
  });

  it("does not descend into node_modules or build output dirs", () => {
    const root = tempDir();
    writeSink(root, path.join("runtime", "node_modules", "dep"));
    writeSink(root, path.join("runtime", "dist"));
    expect(findExtensionRegistrySinks(root)).toEqual([]);
  });

  it("returns [] for a workspace without a packages directory", () => {
    expect(findExtensionRegistrySinks(tempDir())).toEqual([]);
  });
});

describe("writeExtensionRegistry", () => {
  it("rewrites a declared sink and is idempotent", () => {
    const root = tempDir();
    const sink = writeSink(root, path.join("runtime", "src", "shared"));
    writeExtension(root, "shell", "@workspace-extensions/shell");

    expect(writeExtensionRegistry(root)).toBe(true);
    const content = fs.readFileSync(sink, "utf-8");
    expect(content).toContain("@workspace-extensions/shell");
    // Regenerated content keeps the directive: the file stays a sink.
    expect(content.startsWith(`${EXTENSION_REGISTRY_SINK_DIRECTIVE}\n`)).toBe(true);
    // Second run with unchanged inputs makes no write.
    expect(writeExtensionRegistry(root)).toBe(false);
  });

  it("is a no-op when the workspace declares no sink", () => {
    const root = tempDir();
    writeExtension(root, "shell", "@workspace-extensions/shell");
    // A same-named file without the directive is workspace-owned and untouched.
    const optedOut = writeSink(root, path.join("runtime", "src"), "// hands off\nexport {};\n");

    expect(writeExtensionRegistry(root)).toBe(false);
    expect(fs.readFileSync(optedOut, "utf-8")).toBe("// hands off\nexport {};\n");
  });

  it("delivers the registry to every declared sink", () => {
    const root = tempDir();
    const a = writeSink(root, path.join("runtime", "src", "shared"));
    const b = writeSink(root, path.join("alt-runtime", "typed"));
    writeExtension(root, "shell", "@workspace-extensions/shell");

    expect(writeExtensionRegistry(root)).toBe(true);
    expect(fs.readFileSync(a, "utf-8")).toBe(fs.readFileSync(b, "utf-8"));
    expect(fs.readFileSync(a, "utf-8")).toContain("@workspace-extensions/shell");
  });

  it("writes an empty registry when no extensions self-register", () => {
    const root = tempDir();
    const sink = writeSink(
      root,
      path.join("runtime", "src", "shared"),
      `${EXTENSION_REGISTRY_SINK_DIRECTIVE}\nexport type { Api as Ext_stale } from "@gone/ext";\n`,
    );

    expect(writeExtensionRegistry(root)).toBe(true);
    const content = fs.readFileSync(sink, "utf-8");
    expect(content).toContain("export {};");
    expect(content).not.toContain("@gone/ext");
  });
});
