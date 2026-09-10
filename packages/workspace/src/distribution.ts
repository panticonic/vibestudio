import * as fs from "node:fs";
import * as path from "node:path";
import { compareUtf16CodeUnits } from "@vibestudio/content-addressing";
import {
  BUILDABLE_UNIT_DIRS,
  WORKSPACE_PACKAGE_SCOPES,
  WORKSPACE_SOURCE_DIRS,
} from "@vibestudio/workspace-contracts/sourceDirs";
import type { WorkspaceConfig } from "@vibestudio/workspace-contracts/types";
import {
  canonicalTemplateYaml,
  parseTemplateManifestContent,
  rootRuntimeFromTemplateManifest,
  validateTemplateSnapshotInventory,
  type ParsedTemplateManifest,
} from "./templateManifest.js";

const INTERNAL_DEPENDENCY_SECTIONS = [
  "dependencies",
  "peerDependencies",
  "optionalDependencies",
  "devDependencies",
] as const;
const GENERATED_PATHS = new Set(["meta/vibestudio.yml"]);

interface PackageManifest {
  name?: unknown;
  vibestudio?: unknown;
  dependencies?: unknown;
  peerDependencies?: unknown;
  optionalDependencies?: unknown;
  devDependencies?: unknown;
}

function panelTemplateDependency(
  sourceRoot: string,
  repoPath: string,
  manifest: PackageManifest | null
): string | null {
  if (!repoPath.startsWith("panels/") || !manifest) return null;
  const vibestudio = manifest.vibestudio;
  const configured =
    vibestudio && typeof vibestudio === "object" && !Array.isArray(vibestudio)
      ? (vibestudio as Record<string, unknown>)["template"]
      : undefined;
  if (configured !== undefined && typeof configured !== "string") {
    throw new Error(`Distribution repository ${repoPath} vibestudio.template must be a string`);
  }
  const name = configured ?? "default";
  if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..") {
    throw new Error(
      `Distribution repository ${repoPath} has invalid build template ${JSON.stringify(name)}`
    );
  }
  const template = `templates/${name}`;
  const sourcePath = path.join(sourceRoot, "templates", name);
  if (fs.existsSync(sourcePath) && fs.lstatSync(sourcePath).isDirectory()) return template;
  if (configured !== undefined) {
    throw new Error(
      `Distribution repository ${repoPath} requires missing build template ${template}`
    );
  }
  return null;
}

export type WorkspaceDistributionFile =
  | { path: string; mode: 0o644 | 0o755; sourcePath: string }
  | { path: string; mode: 0o644 | 0o755; bytes: Uint8Array };

export interface PreparedWorkspaceDistribution {
  manifest: ParsedTemplateManifest;
  repositories: string[];
  files: WorkspaceDistributionFile[];
}

function canonicalRelativePath(value: string, label: string): string {
  const normalized = value.replace(/\\/gu, "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`${label} is not a canonical relative path: ${JSON.stringify(value)}`);
  }
  return normalized;
}

function readPackageManifest(sourceRoot: string, repoPath: string): PackageManifest | null {
  const manifestPath = path.join(sourceRoot, ...repoPath.split("/"), "package.json");
  if (!fs.existsSync(manifestPath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Distribution repository ${repoPath} has invalid package.json`, {
      cause: error,
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Distribution repository ${repoPath} package.json must be an object`);
  }
  return parsed as PackageManifest;
}

function packageOwners(sourceRoot: string): Map<string, string[]> {
  const owners = new Map<string, string[]>();
  for (const { dir, kind } of BUILDABLE_UNIT_DIRS) {
    if (kind === "template") continue;
    const sectionPath = path.join(sourceRoot, dir);
    if (!fs.existsSync(sectionPath)) continue;
    for (const entry of fs.readdirSync(sectionPath, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const repoPath = `${dir}/${entry.name}`;
      const manifest = readPackageManifest(sourceRoot, repoPath);
      if (!manifest || typeof manifest.name !== "string" || manifest.name.length === 0) continue;
      const current = owners.get(manifest.name) ?? [];
      current.push(repoPath);
      owners.set(manifest.name, current);
    }
  }
  return owners;
}

function isWorkspacePackage(name: string): boolean {
  return WORKSPACE_PACKAGE_SCOPES.some((scope) => name.startsWith(scope));
}

function runtimeSourceReferences(runtime: Omit<WorkspaceConfig, "id">): string[] {
  return [
    runtime.defaultRepo,
    ...(runtime.initPanels ?? []).map(({ source }) => source),
    ...(runtime.extensions ?? []).map(({ source }) => source),
    ...(runtime.apps ?? []).map(({ source }) => source),
    ...(runtime.services ?? []).map(({ source }) => source),
    ...(runtime.routes ?? []).map(({ source }) => source),
    ...(runtime.singletonObjects ?? []).map(({ source }) => source),
    runtime.providers?.evalEngine?.source,
    runtime.providers?.evalRuntime?.source,
    runtime.providers?.cdpClient?.source,
    runtime.providers?.browserData?.extension,
    runtime.providers?.gitInterop?.extension,
    runtime.providers?.claudeCode?.extension,
    runtime.hostTargets?.electron?.app,
    ...(runtime.hostTargets?.electron?.requiresExtensions ?? []),
    runtime.hostTargets?.["react-native"]?.app,
    ...(runtime.hostTargets?.["react-native"]?.requiresExtensions ?? []),
    runtime.hostTargets?.terminal?.app,
    ...(runtime.hostTargets?.terminal?.requiresExtensions ?? []),
    ...(runtime.trust?.chromeApps ?? []),
    ...(runtime.trust?.connectionManagementApps ?? []),
  ].filter((source): source is string => typeof source === "string");
}

function validateRuntimeInventory(
  sourceRoot: string,
  runtime: Omit<WorkspaceConfig, "id">,
  repositories: ReadonlySet<string>
): void {
  const owners = packageOwners(sourceRoot);
  for (const source of runtimeSourceReferences(runtime)) {
    let repoPath: string | undefined;
    if (isWorkspacePackage(source)) {
      const matches = owners.get(source) ?? [];
      if (matches.length !== 1) {
        throw new Error(
          matches.length === 0
            ? `Distribution runtime references missing local package ${source}`
            : `Distribution runtime local package ${source} has multiple owners: ${matches.join(", ")}`
        );
      }
      repoPath = matches[0];
    } else {
      const candidate = source.replace(/\\/gu, "/");
      if (WORKSPACE_SOURCE_DIRS.some((section) => candidate.startsWith(`${section}/`))) {
        repoPath = canonicalRelativePath(candidate, "Distribution runtime source");
      }
    }
    if (repoPath && !repositories.has(repoPath)) {
      throw new Error(
        `Distribution runtime references ${repoPath}, which is outside its repository inventory`
      );
    }
  }
}

function workspaceDependencies(repoPath: string, manifest: PackageManifest | null): string[] {
  if (!manifest) return [];
  const dependencies = new Set<string>();
  for (const section of INTERNAL_DEPENDENCY_SECTIONS) {
    const value = manifest[section];
    if (value === undefined) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(
        `Distribution repository ${repoPath} package.json ${section} must be an object`
      );
    }
    for (const [name, specifier] of Object.entries(value as Record<string, unknown>)) {
      if (!isWorkspacePackage(name)) continue;
      if (
        typeof specifier !== "string" ||
        !new Set(["*", "workspace:", "workspace:*"]).has(specifier.trim().toLowerCase())
      ) {
        throw new Error(
          `Distribution repository ${repoPath} internal dependency ${name} must use workspace:*`
        );
      }
      dependencies.add(name);
    }
  }
  return [...dependencies].sort(compareUtf16CodeUnits);
}

/** Resolve the complete local package closure of an explicit repository selection. */
export function resolveDistributionInventory(
  sourceRootInput: string,
  roots: readonly string[],
  /**
   * Repositories a declared dependency already supplies.
   *
   * A distribution built on another declares only what it adds, so its closure
   * must stop at the dependency's edge. Without that, the closure walks back
   * into everything the dependency provides and the composed workspace ends up
   * with two layers declaring the same repository.
   */
  provided: ReadonlySet<string> = new Set()
): string[] {
  const sourceRoot = fs.realpathSync(path.resolve(sourceRootInput));
  const selected = new Set<string>();
  const pending: string[] = [];
  for (const value of roots) {
    const repoPath = canonicalRelativePath(value, "Distribution repository");
    const sourcePath = path.join(sourceRoot, ...repoPath.split("/"));
    if (!fs.existsSync(sourcePath) || !fs.lstatSync(sourcePath).isDirectory()) {
      throw new Error(`Distribution repository is missing: ${repoPath}`);
    }
    if (provided.has(repoPath)) {
      throw new Error(
        `Distribution repository ${repoPath} is already provided by a declared dependency`
      );
    }
    if (!selected.has(repoPath)) {
      selected.add(repoPath);
      pending.push(repoPath);
    }
  }

  const owners = packageOwners(sourceRoot);
  while (pending.length > 0) {
    const repoPath = pending.shift();
    if (!repoPath) break;
    const manifest = readPackageManifest(sourceRoot, repoPath);
    const template = panelTemplateDependency(sourceRoot, repoPath, manifest);
    if (template && !provided.has(template) && !selected.has(template)) {
      selected.add(template);
      pending.push(template);
    }
    for (const dependency of workspaceDependencies(repoPath, manifest)) {
      const matches = owners.get(dependency) ?? [];
      if (matches.length === 0) {
        throw new Error(
          `Distribution repository ${repoPath} requires missing local dependency ${dependency}`
        );
      }
      if (matches.length > 1) {
        throw new Error(
          `Distribution local dependency ${dependency} has multiple owners: ${matches.sort(compareUtf16CodeUnits).join(", ")}`
        );
      }
      const owner = matches[0];
      if (!owner) throw new Error(`Distribution local dependency ${dependency} has no owner`);
      if (provided.has(owner) || selected.has(owner)) continue;
      selected.add(owner);
      pending.push(owner);
    }
  }
  return [...selected].sort(compareUtf16CodeUnits);
}

function addSourceFile(
  files: Map<string, WorkspaceDistributionFile>,
  sourceRoot: string,
  relativePathInput: string
): void {
  const relativePath = canonicalRelativePath(relativePathInput, "Distribution file");
  if (GENERATED_PATHS.has(relativePath)) {
    throw new Error(`Distribution support files cannot replace generated ${relativePath}`);
  }
  const sourcePath = path.join(sourceRoot, ...relativePath.split("/"));
  const stat = fs.lstatSync(sourcePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Distribution source path is not a regular file: ${relativePath}`);
  }
  if (files.has(relativePath))
    throw new Error(`Distribution file is selected twice: ${relativePath}`);
  files.set(relativePath, {
    path: relativePath,
    mode: stat.mode & 0o111 ? 0o755 : 0o644,
    sourcePath,
  });
}

function addRepositoryFiles(
  files: Map<string, WorkspaceDistributionFile>,
  sourceRoot: string,
  relativePath: string
): void {
  const directory = path.join(sourceRoot, ...relativePath.split("/"));
  for (const entry of fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => compareUtf16CodeUnits(left.name, right.name))) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const child = `${relativePath}/${entry.name}`;
    if (entry.isDirectory()) {
      addRepositoryFiles(files, sourceRoot, child);
      continue;
    }
    addSourceFile(files, sourceRoot, child);
  }
}

/**
 * Prepare a positive-list-only distribution projection before creating output.
 * The source manifest supplies runtime configuration and initial roots; its
 * emitted inventory records the resolved local package closure.
 */
export function prepareWorkspaceDistribution(input: {
  sourceRoot: string;
  manifestContent: string;
  expectedSystemEpoch: number;
  /** Repositories the manifest's declared dependencies already supply. */
  providedRepositories?: ReadonlySet<string>;
}): PreparedWorkspaceDistribution {
  const sourceRoot = fs.realpathSync(path.resolve(input.sourceRoot));
  const authored = parseTemplateManifestContent(input.manifestContent, input.expectedSystemEpoch);
  const provided = input.providedRepositories ?? new Set<string>();
  if (authored.dependencies.length === 0 && provided.size > 0) {
    throw new Error("Distribution declares no dependencies, so nothing can be provided for it");
  }
  const repositories = resolveDistributionInventory(
    sourceRoot,
    authored.inventory.repositories,
    provided
  );
  const sourceManifest = canonicalTemplateYaml({
    ...authored.top,
    template: {
      ...(authored.presentation ?? {}),
      // Carried through, because the workspace this becomes has to know what it
      // is built on in order to acquire it.
      ...(authored.dependencies.length > 0 ? { dependencies: authored.dependencies } : {}),
      repositories,
      files: authored.inventory.files,
    },
  });
  const manifest = parseTemplateManifestContent(sourceManifest, input.expectedSystemEpoch);
  // A runtime reference into a dependency's repository is legitimate: that
  // repository is present in the composed workspace, just not in this layer.
  validateRuntimeInventory(
    sourceRoot,
    rootRuntimeFromTemplateManifest(manifest),
    new Set([...repositories, ...provided])
  );
  const files = new Map<string, WorkspaceDistributionFile>([
    [
      "meta/vibestudio.yml",
      {
        path: "meta/vibestudio.yml",
        mode: 0o644,
        bytes: new TextEncoder().encode(sourceManifest),
      },
    ],
  ]);
  for (const filePath of manifest.inventory.files) addSourceFile(files, sourceRoot, filePath);
  for (const repoPath of repositories) addRepositoryFiles(files, sourceRoot, repoPath);
  validateTemplateSnapshotInventory(manifest.inventory, [...files.keys()]);
  return {
    manifest,
    repositories,
    files: [...files.values()].sort((left, right) => compareUtf16CodeUnits(left.path, right.path)),
  };
}
