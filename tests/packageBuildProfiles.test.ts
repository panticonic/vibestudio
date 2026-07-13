import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const PACKAGES_ROOT = path.join(ROOT, "packages");
const BUILD_PROFILES = ["source-only", "tsc-output", "tsc-build", "custom-bundle"] as const;

type BuildProfile = (typeof BUILD_PROFILES)[number];

interface PackageManifest {
  name: string;
  main?: string;
  types?: string;
  exports?: unknown;
  scripts?: Record<string, string>;
  vibestudio?: {
    buildProfile?: BuildProfile;
  };
}

interface CompilerOptions {
  outDir?: string;
  rootDir?: string;
  declaration?: boolean;
  noEmit?: boolean;
  composite?: boolean;
}

function packageDirectories(): string[] {
  return fs
    .readdirSync(PACKAGES_ROOT, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && fs.existsSync(path.join(PACKAGES_ROOT, entry.name, "package.json"))
    )
    .map((entry) => path.join(PACKAGES_ROOT, entry.name))
    .sort();
}

function readManifest(packageDirectory: string): PackageManifest {
  return JSON.parse(
    fs.readFileSync(path.join(packageDirectory, "package.json"), "utf8")
  ) as PackageManifest;
}

function stringLeaves(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringLeaves);
  if (value && typeof value === "object") return Object.values(value).flatMap(stringLeaves);
  return [];
}

function publicTargets(manifest: PackageManifest): string[] {
  return [manifest.main, manifest.types, ...stringLeaves(manifest.exports)].filter(
    (target): target is string => typeof target === "string"
  );
}

function missingConcreteTargets(packageDirectory: string, targets: string[]): string[] {
  return [...new Set(targets)]
    .filter((target) => !target.includes("*"))
    .filter((target) => !fs.existsSync(path.resolve(packageDirectory, target)));
}

function effectiveCompilerOptions(tsconfigPath: string): CompilerOptions {
  const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, "utf8")) as {
    extends?: string;
    compilerOptions?: CompilerOptions;
  };
  const inherited = tsconfig.extends?.startsWith(".")
    ? effectiveCompilerOptions(path.resolve(path.dirname(tsconfigPath), tsconfig.extends))
    : {};
  return { ...inherited, ...tsconfig.compilerOptions };
}

function expectDistEntrypoints(manifest: PackageManifest): void {
  const targets = publicTargets(manifest);
  expect(
    targets.length,
    `${manifest.name} must declare at least one public entrypoint`
  ).toBeGreaterThan(0);
  expect(
    targets.filter((target) => !target.startsWith("./dist/")),
    `${manifest.name} emitted entrypoints must resolve under dist/`
  ).toEqual([]);
}

describe("package build profiles", () => {
  const packages = packageDirectories().map((directory) => ({
    directory,
    manifest: readManifest(directory),
  }));

  it("requires every packages/* package to declare a known profile", () => {
    const declarations = packages.map(({ manifest }) => ({
      name: manifest.name,
      profile: manifest.vibestudio?.buildProfile,
    }));
    expect(
      declarations.filter(({ profile }) => !BUILD_PROFILES.includes(profile as BuildProfile))
    ).toEqual([]);
  });

  for (const { directory, manifest } of packages) {
    it(`${manifest.name} conforms to ${manifest.vibestudio?.buildProfile ?? "an undeclared profile"}`, () => {
      const profile = manifest.vibestudio?.buildProfile;
      expect(BUILD_PROFILES).toContain(profile);

      if (profile === "source-only") {
        const targets = publicTargets(manifest);
        expect(
          targets.length,
          `${manifest.name} must declare at least one public entrypoint`
        ).toBeGreaterThan(0);
        expect(
          targets.filter((target) => !target.startsWith("./src/")),
          `${manifest.name} source-only entrypoints must resolve under src/`
        ).toEqual([]);
        expect(
          missingConcreteTargets(directory, targets),
          `${manifest.name} concrete source-only entrypoints must exist`
        ).toEqual([]);
        expect(
          manifest.scripts?.build,
          "source-only packages do not emit build artifacts"
        ).toBeUndefined();
        expect(fs.existsSync(path.join(directory, "tsconfig.build.json"))).toBe(false);
        expect(fs.existsSync(path.join(directory, "build.mjs"))).toBe(false);
        return;
      }

      expectDistEntrypoints(manifest);
      const buildConfigPath = path.join(directory, "tsconfig.build.json");
      expect(fs.existsSync(buildConfigPath)).toBe(true);
      const compilerOptions = effectiveCompilerOptions(buildConfigPath);
      expect(compilerOptions).toMatchObject({
        outDir: "dist",
        rootDir: "src",
        declaration: true,
      });
      expect(compilerOptions.noEmit).not.toBe(true);

      if (profile === "tsc-output") {
        expect(manifest.scripts?.build).toBe("tsc --project tsconfig.build.json");
        expect(fs.existsSync(path.join(directory, "build.mjs"))).toBe(false);
        return;
      }

      if (profile === "tsc-build") {
        expect(manifest.scripts?.build).toBe("tsc --build tsconfig.build.json --force");
        expect(compilerOptions.composite).toBe(true);
        expect(fs.existsSync(path.join(directory, "build.mjs"))).toBe(false);
        return;
      }

      expect(manifest.scripts?.build).toBe("node build.mjs");
      const customBuild = fs.readFileSync(path.join(directory, "build.mjs"), "utf8");
      expect(customBuild).toContain("esbuild.build");
    });
  }
});
