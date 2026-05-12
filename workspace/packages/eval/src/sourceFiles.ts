import { execute, getDefaultRequire, preloadRequires } from "./execute.js";
import { transformCode, type TransformOptions } from "./transform.js";

export type LoadSourceFile = (path: string) => Promise<string>;

export interface SourceFileBundle {
  entryPath: string;
  files: Record<string, string>;
}

export interface SourceFileOptions {
  sourcePath?: string;
  sourceFiles?: Record<string, string>;
  loadSourceFile?: LoadSourceFile;
}

export interface PreparedSource {
  code: string;
  entryPath?: string;
  sourceFiles?: Record<string, string>;
  localModuleIds: Set<string>;
}

type EnsureExternalRequires = (requires: string[]) => Promise<void>;

const EXTENSIONS = [".tsx", ".ts", ".jsx", ".js"];
const INDEX_FILES = EXTENSIONS.map((ext) => `/index${ext}`);

function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

function hasKnownExtension(filePath: string): boolean {
  return EXTENSIONS.some((ext) => filePath.endsWith(ext));
}

export function normalizeSourcePath(filePath: string, baseDir?: string): string {
  const raw = filePath.replace(/\\/g, "/").trim();
  const combined = baseDir && isRelativeSpecifier(raw) ? `${baseDir}/${raw}` : raw;
  const absolute = combined.startsWith("/");
  const parts: string[] = [];
  for (const part of combined.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") {
        parts.pop();
      } else if (!absolute) {
        parts.push(part);
      }
      continue;
    }
    parts.push(part);
  }
  const normalized = parts.join("/");
  return absolute ? `/${normalized}` : normalized;
}

function dirname(filePath: string): string {
  const normalized = normalizeSourcePath(filePath);
  const index = normalized.lastIndexOf("/");
  if (index < 0) return "";
  if (index === 0) return "/";
  return normalized.slice(0, index);
}

function candidatePaths(specifier: string, importerPath?: string): string[] {
  const base = normalizeSourcePath(specifier, importerPath ? dirname(importerPath) : undefined);
  if (hasKnownExtension(base)) return [base];
  return [
    base,
    ...EXTENSIONS.map((ext) => `${base}${ext}`),
    ...INDEX_FILES.map((suffix) => `${base}${suffix}`),
  ];
}

export function findRelativeSpecifiers(code: string): string[] {
  const patterns = [
    /\b(?:import|export)\s+(?:[^"'`]*?\s+from\s+)?["'](\.{1,2}\/[^"']+)["']/g,
    /\brequire\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g,
  ];
  const specifiers: string[] = [];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      if (match[1]) specifiers.push(match[1]);
    }
  }
  return Array.from(new Set(specifiers));
}

async function resolveSourceFile(
  specifier: string,
  importerPath: string | undefined,
  files: Map<string, string>,
  loadSourceFile?: LoadSourceFile,
): Promise<{ path: string; code: string }> {
  const candidates = candidatePaths(specifier, importerPath);
  for (const candidate of candidates) {
    const normalized = normalizeSourcePath(candidate);
    const existing = files.get(normalized);
    if (existing !== undefined) return { path: normalized, code: existing };
  }

  if (!loadSourceFile) {
    throw new Error(`Relative import "${specifier}" could not be resolved from ${importerPath ?? "<inline source>"}`);
  }

  const errors: string[] = [];
  for (const candidate of candidates) {
    const normalized = normalizeSourcePath(candidate);
    try {
      const code = await loadSourceFile(normalized);
      files.set(normalized, code);
      return { path: normalized, code };
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  throw new Error(
    `Relative import "${specifier}" could not be resolved from ${importerPath ?? "<inline source>"}. ` +
    `Tried: ${candidates.map((candidate) => normalizeSourcePath(candidate)).join(", ")}. ${errors[errors.length - 1] ?? ""}`.trim(),
  );
}

export async function loadSourceFileBundle(
  entryPath: string,
  loadSourceFile: LoadSourceFile,
  entryCode?: string,
): Promise<SourceFileBundle> {
  const files = new Map<string, string>();
  const first = await resolveSourceFile(entryPath, undefined, files, async (path) => (
    path === normalizeSourcePath(entryPath) && entryCode !== undefined ? entryCode : loadSourceFile(path)
  ));
  const visiting = new Set<string>();

  async function visit(filePath: string): Promise<void> {
    const normalized = normalizeSourcePath(filePath);
    if (visiting.has(normalized)) return;
    visiting.add(normalized);
    const code = files.get(normalized);
    if (code === undefined) throw new Error(`Source file missing from bundle: ${normalized}`);
    for (const specifier of findRelativeSpecifiers(code)) {
      const resolved = await resolveSourceFile(specifier, normalized, files, loadSourceFile);
      await visit(resolved.path);
    }
  }

  await visit(first.path);
  return { entryPath: first.path, files: Object.fromEntries(files) };
}

function rewriteRelativeSpecifiers(
  code: string,
  importerPath: string,
  files: Map<string, string>,
): string {
  function resolve(specifier: string): string {
    for (const candidate of candidatePaths(specifier, importerPath)) {
      const normalized = normalizeSourcePath(candidate);
      if (files.has(normalized)) return normalized;
    }
    return specifier;
  }

  return code
    .replace(
      /(\b(?:import|export)\s+(?:[^"'`]*?\s+from\s+)?["'])(\.{1,2}\/[^"']+)(["'])/g,
      (_match, prefix: string, specifier: string, suffix: string) => `${prefix}${resolve(specifier)}${suffix}`,
    )
    .replace(
      /(\brequire\(\s*["'])(\.{1,2}\/[^"']+)(["']\s*\))/g,
      (_match, prefix: string, specifier: string, suffix: string) => `${prefix}${resolve(specifier)}${suffix}`,
    );
}

async function defaultEnsureExternalRequires(requires: string[]): Promise<void> {
  const external = requires.filter(Boolean);
  if (external.length === 0) return;
  const preload = await preloadRequires(external);
  if (!preload.success) {
    throw new Error(preload.error ?? `Module "${preload.failedModule}" not available`);
  }
}

async function loadLocalModules(
  entryPath: string,
  files: Map<string, string>,
  syntax: TransformOptions["syntax"],
  ensureExternalRequires: EnsureExternalRequires,
): Promise<void> {
  const localModuleIds = new Set(files.keys());
  const loadedContent = new Map<string, string>();
  const loading = new Set<string>();
  const moduleMap = ((globalThis as Record<string, unknown>)["__natstackModuleMap__"] ??= {}) as Record<string, unknown>;
  const requireFn = getDefaultRequire();
  if (!requireFn) throw new Error("__natstackRequire__ not available. Build may be outdated.");

  async function loadModule(filePath: string): Promise<void> {
    const normalized = normalizeSourcePath(filePath);
    if (normalized === entryPath) return;
    if (loading.has(normalized)) return;

    const code = files.get(normalized);
    if (code === undefined) throw new Error(`Source file missing from bundle: ${normalized}`);

    const rewritten = rewriteRelativeSpecifiers(code, normalized, files);
    if (loadedContent.get(normalized) === rewritten && moduleMap[normalized]) return;

    loading.add(normalized);
    try {
      for (const specifier of findRelativeSpecifiers(code)) {
        const resolved = await resolveSourceFile(specifier, normalized, files);
        await loadModule(resolved.path);
      }

      const transformed = await transformCode(rewritten, { syntax });
      const externalRequires = transformed.requires.filter((specifier) => !localModuleIds.has(specifier));
      await ensureExternalRequires(externalRequires);

      const result = execute(transformed.code, { require: requireFn });
      moduleMap[normalized] = result.exports;
      loadedContent.set(normalized, rewritten);
    } finally {
      loading.delete(normalized);
    }
  }

  for (const specifier of findRelativeSpecifiers(files.get(entryPath) ?? "")) {
    const resolved = await resolveSourceFile(specifier, entryPath, files);
    await loadModule(resolved.path);
  }
}

export async function prepareSourceCode(
  code: string,
  options: SourceFileOptions & { syntax: TransformOptions["syntax"] },
  ensureExternalRequires: EnsureExternalRequires = defaultEnsureExternalRequires,
): Promise<PreparedSource> {
  if (!options.sourcePath) {
    return { code, localModuleIds: new Set() };
  }

  const normalizedFiles = new Map<string, string>();
  for (const [filePath, fileCode] of Object.entries(options.sourceFiles ?? {})) {
    normalizedFiles.set(normalizeSourcePath(filePath), fileCode);
  }

  const bundle = await loadSourceFileBundle(
    options.sourcePath,
    async (filePath) => {
      const normalized = normalizeSourcePath(filePath);
      const existing = normalizedFiles.get(normalized);
      if (existing !== undefined) return existing;
      if (!options.loadSourceFile) {
        throw new Error(`Source file not present in embedded file bundle: ${normalized}`);
      }
      return options.loadSourceFile(normalized);
    },
    code,
  );

  const files = new Map<string, string>();
  for (const [filePath, fileCode] of Object.entries(bundle.files)) {
    files.set(normalizeSourcePath(filePath), fileCode);
  }
  const localModuleIds = new Set(files.keys());
  await loadLocalModules(bundle.entryPath, files, options.syntax, ensureExternalRequires);

  return {
    code: rewriteRelativeSpecifiers(files.get(bundle.entryPath) ?? code, bundle.entryPath, files),
    entryPath: bundle.entryPath,
    sourceFiles: Object.fromEntries(files),
    localModuleIds,
  };
}
