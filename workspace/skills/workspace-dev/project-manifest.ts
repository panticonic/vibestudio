import { parseUnitAuthorityManifest } from "@vibestudio/shared/authorityManifest";

export const PROJECT_TYPES = ["panel", "package", "skill", "project", "worker"] as const;
export type ProjectType = (typeof PROJECT_TYPES)[number];

export interface ProjectPreflightReport {
  ok: true;
  projectType: ProjectType;
  packageName: string | null;
  entry: string | null;
  authorityRequestCount: number;
  importedPackages: string[];
  checked: string[];
}

export interface BuildProjectManifestInput {
  projectType: Exclude<ProjectType, "project">;
  name: string;
  title: string;
  entry?: string;
  template?: string;
  exports?: Record<string, string>;
  exposeModules?: string[];
  durableClasses?: string[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const PACKAGE_SCOPES: Record<Exclude<ProjectType, "project">, string> = {
  panel: "@workspace-panels",
  package: "@workspace",
  skill: "@workspace-skills",
  worker: "@workspace-workers",
};

function assertProjectName(name: string): void {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new Error(
      "Project name must start with a lowercase letter and contain only lowercase letters, numbers, and hyphens."
    );
  }
}

export function assertProjectIdentity(name: string, title: string): void {
  assertProjectName(name);
  if (!title.trim() || /[`\\\r\n"<>{}&*]|\$\{/.test(title)) {
    throw new Error(
      'Project title must be a single non-empty line without code or markup delimiters such as ", <, {, *, backticks, or backslashes.'
    );
  }
}

function canonicalRecord<T>(value: Record<string, T> | undefined): Record<string, T> | undefined {
  if (!value) return undefined;
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
  );
}

/** Build the one canonical package manifest shape used by every scaffold template. */
export function buildProjectManifest(input: BuildProjectManifestInput): Record<string, unknown> {
  assertProjectIdentity(input.name, input.title);
  const executable = input.projectType === "panel" || input.projectType === "worker";
  if (executable && !input.entry) {
    throw new Error(`${input.projectType} manifests require an explicit entry`);
  }
  if (!executable && input.entry) {
    throw new Error(`${input.projectType} manifests cannot declare a Vibestudio entry`);
  }
  const manifest: Record<string, unknown> = {
    name: `${PACKAGE_SCOPES[input.projectType]}/${input.name}`,
    version: "0.1.0",
    private: true,
    type: "module",
  };
  if (input.exports) manifest["exports"] = canonicalRecord(input.exports);
  if (executable) {
    manifest["vibestudio"] = {
      ...(input.projectType === "worker" ? { type: "worker" } : {}),
      title: input.title,
      entry: input.entry,
      ...(input.exposeModules ? { exposeModules: [...input.exposeModules] } : {}),
      authority: { requests: [] },
      ...(input.template ? { template: input.template } : {}),
      ...(input.durableClasses
        ? {
            durable: {
              classes: input.durableClasses.map((className) => ({ className })),
            },
          }
        : {}),
    };
  }
  if (input.dependencies) manifest["dependencies"] = canonicalRecord(input.dependencies);
  if (input.devDependencies) manifest["devDependencies"] = canonicalRecord(input.devDependencies);
  return manifest;
}

export function serializeProjectManifest(input: BuildProjectManifestInput): string {
  return `${JSON.stringify(buildProjectManifest(input), null, 2)}\n`;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function parseManifest(source: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(
      `package.json must be valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return asRecord(parsed, "package.json");
}

function packageCoordinate(specifier: string): string | null {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:")) {
    return null;
  }
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

function importedPackages(files: Readonly<Record<string, string | Uint8Array>>): string[] {
  const imports = new Set<string>();
  const pattern =
    /(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\()\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']/g;
  for (const [path, content] of Object.entries(files)) {
    if (content instanceof Uint8Array || path === "package.json") continue;
    for (const match of content.matchAll(pattern)) {
      const coordinate = packageCoordinate(match[1] ?? match[2] ?? "");
      if (coordinate) imports.add(coordinate);
    }
  }
  return [...imports].sort();
}

/**
 * Validate the complete planned repository before any VCS edit occurs.
 * Forks and fresh templates intentionally share this exact gate.
 */
export function preflightProjectFiles(input: {
  projectType: ProjectType;
  name: string;
  files: Readonly<Record<string, string | Uint8Array>>;
}): ProjectPreflightReport {
  assertProjectName(input.name);
  const checked = ["canonical project type", "non-empty repository"];
  if (!PROJECT_TYPES.includes(input.projectType)) {
    throw new Error(`Unknown project type ${JSON.stringify(input.projectType)}`);
  }
  if (Object.keys(input.files).length === 0) {
    throw new Error("A project repository must contain at least one file");
  }
  if (input.projectType === "project") {
    return {
      ok: true,
      projectType: input.projectType,
      packageName: null,
      entry: null,
      authorityRequestCount: 0,
      importedPackages: [],
      checked,
    };
  }

  const packageSource = input.files["package.json"];
  if (typeof packageSource !== "string") {
    throw new Error(`${input.projectType} repositories require a textual package.json`);
  }
  const manifest = parseManifest(packageSource);
  const expectedName = `${PACKAGE_SCOPES[input.projectType]}/${input.name}`;
  if (manifest["name"] !== expectedName) {
    throw new Error(`package.json name must be ${expectedName}`);
  }
  if (manifest["private"] !== true || manifest["type"] !== "module") {
    throw new Error("package.json must declare private: true and type: module");
  }
  checked.push("package identity");

  let entry: string | null = null;
  let authorityRequestCount = 0;
  if (input.projectType === "panel" || input.projectType === "worker") {
    const vibestudio = asRecord(manifest["vibestudio"], "package.json vibestudio");
    if (typeof vibestudio["title"] !== "string") {
      throw new Error("Executable package.json must declare a Vibestudio title");
    }
    assertProjectIdentity(input.name, vibestudio["title"]);
    if (input.projectType === "worker" && vibestudio["type"] !== "worker") {
      throw new Error('Worker package.json must declare vibestudio.type: "worker"');
    }
    entry = typeof vibestudio["entry"] === "string" ? vibestudio["entry"] : null;
    if (!entry || !(entry in input.files)) {
      throw new Error(`${input.projectType} entry must name a file in the planned repository`);
    }
    authorityRequestCount = parseUnitAuthorityManifest(
      vibestudio["authority"],
      `${expectedName} vibestudio.authority`
    ).requests.length;
    checked.push("executable entry", "strict authority manifest");
  } else if (manifest["exports"] === undefined) {
    throw new Error(`${input.projectType} package.json must declare exports`);
  }

  if (input.projectType === "skill" && typeof input.files["SKILL.md"] !== "string") {
    throw new Error("Skill repositories require a textual SKILL.md");
  }
  if (input.projectType === "skill") checked.push("skill instructions");

  const imports = importedPackages(input.files);
  const dependencies =
    manifest["dependencies"] === undefined
      ? {}
      : asRecord(manifest["dependencies"], "package.json dependencies");
  const devDependencies =
    manifest["devDependencies"] === undefined
      ? {}
      : asRecord(manifest["devDependencies"], "package.json devDependencies");
  const undeclared = imports.filter(
    (coordinate) => !(coordinate in dependencies) && !(coordinate in devDependencies)
  );
  if (undeclared.length > 0) {
    throw new Error(`Imported package(s) missing from dependencies: ${undeclared.join(", ")}`);
  }
  checked.push("import dependency closure");

  return {
    ok: true,
    projectType: input.projectType,
    packageName: expectedName,
    entry,
    authorityRequestCount,
    importedPackages: imports,
    checked,
  };
}
