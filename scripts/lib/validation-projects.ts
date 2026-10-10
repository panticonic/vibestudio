import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { DerivedCacheCoordinator, derivedCacheDatabasePath } from "@vibestudio/shared/derivedCache";
import { fileDigest } from "./file-digest.mjs";
import { compilerImports, relativeCompilerInput } from "./compiler-inputs.mjs";

export interface ValidationUnit {
  name: string;
  root: string;
  files: string[];
}
export type ValidationPaths = Record<string, string[]>;

function owner(file: string, units: ValidationUnit[]) {
  return units.find((unit) => file === unit.root || file.startsWith(`${unit.root}${path.sep}`));
}

// Source-relative imports share one owner group so emitted relative coordinates
// stay valid. Package imports form declaration boundaries; cycles share a group.
export function validationGroups(
  units: ValidationUnit[],
  paths: ValidationPaths
): ValidationUnit[][] {
  const edges = new Map(units.map((unit) => [unit, new Set<ValidationUnit>()]));
  const patterns = Object.keys(paths).sort((a, b) => b.length - a.length);
  for (const unit of units)
    for (const file of inputClosure([unit])) {
      if (!/\.[cm]?tsx?$/.test(file)) continue;
      for (const { specifier } of compilerImports(file)) {
        const pattern = patterns.find((key) =>
          key.includes("*")
            ? specifier.startsWith(key.split("*")[0]!) && specifier.endsWith(key.split("*")[1]!)
            : key === specifier
        );
        const target = specifier.startsWith(".")
          ? path.resolve(path.dirname(file), specifier)
          : pattern
            ? paths[pattern]?.[0]?.split("*")[0]
            : undefined;
        const dependency = target ? owner(target, units) : undefined;
        if (!dependency || dependency === unit) continue;
        edges.get(unit)!.add(dependency);
        if (specifier.startsWith(".")) edges.get(dependency)!.add(unit);
      }
    }
  const indices = new Map<ValidationUnit, number>();
  const low = new Map<ValidationUnit, number>();
  const stack: ValidationUnit[] = [];
  const active = new Set<ValidationUnit>();
  const groups: ValidationUnit[][] = [];
  const visit = (unit: ValidationUnit) => {
    indices.set(unit, indices.size);
    low.set(unit, indices.get(unit)!);
    stack.push(unit);
    active.add(unit);
    for (const dependency of edges.get(unit)!) {
      if (!indices.has(dependency)) {
        visit(dependency);
        low.set(unit, Math.min(low.get(unit)!, low.get(dependency)!));
      } else if (active.has(dependency))
        low.set(unit, Math.min(low.get(unit)!, indices.get(dependency)!));
    }
    if (low.get(unit) !== indices.get(unit)) return;
    const group: ValidationUnit[] = [];
    let popped: ValidationUnit;
    do {
      popped = stack.pop()!;
      active.delete(popped);
      group.push(popped);
    } while (popped !== unit);
    groups.push(group.sort((a, b) => a.name.localeCompare(b.name)));
  };
  for (const unit of units) if (!indices.has(unit)) visit(unit);
  return groups;
}

function commonRoot(files: string[]): string {
  let root = path.dirname(files[0]!);
  while (files.some((file) => path.relative(root, file).startsWith(`..${path.sep}`)))
    root = path.dirname(root);
  return root;
}

function inputClosure(group: ValidationUnit[]): string[] {
  const pending = [...new Set(group.flatMap((unit) => unit.files))];
  const files = new Set(pending);
  for (const file of pending) {
    if (!/\.[cm]?tsx?$/.test(file)) continue;
    for (const { specifier } of compilerImports(file)) {
      if (!specifier.startsWith(".")) continue;
      const resolved = relativeCompilerInput(file, specifier);
      if (resolved && owner(resolved, group) && !files.has(resolved)) {
        files.add(resolved);
        pending.push(resolved);
      }
    }
  }
  return [...files].sort();
}

function outputManifest(root: string): { file: string; hash: string }[] {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const file = path.join(entry.parentPath, entry.name);
      return { file: path.relative(root, file), hash: fileDigest(file) };
    })
    .sort((a, b) => a.file.localeCompare(b.file));
}

function validContract(root: string): boolean {
  try {
    const receipt = JSON.parse(fs.readFileSync(path.join(root, "complete.json"), "utf8"));
    if (
      fs.realpathSync(path.join(root, "node_modules")) !== fs.realpathSync(receipt.nodeModulesDir)
    )
      return false;
    return (
      JSON.stringify(receipt.outputs) === JSON.stringify(outputManifest(path.join(root, "types")))
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError))
      throw error;
    return false;
  }
}

export class ValidationProjects {
  private readonly root: string;
  private readonly coordinator: DerivedCacheCoordinator;
  private readonly leases: ReturnType<DerivedCacheCoordinator["acquire"]>[] = [];
  constructor(private readonly appRoot: string) {
    this.root = path.join(appRoot, ".cache", "typecheck-contracts");
    this.coordinator = new DerivedCacheCoordinator(derivedCacheDatabasePath(this.root));
  }

  async contracts(
    units: ValidationUnit[],
    inputPaths: ValidationPaths,
    options: Record<string, unknown>,
    ambientFiles: string[] = [],
    nodeModulesDir: string = path.join(this.appRoot, "node_modules")
  ): Promise<ValidationPaths> {
    const paths = { ...inputPaths };
    for (const group of validationGroups(units, inputPaths)) {
      const ownedFiles = inputClosure(group);
      if (!ownedFiles.length) continue;
      const files = [...new Set([...ownedFiles, ...ambientFiles])].sort();
      const rootDir = commonRoot(group.map((unit) => path.join(unit.root, "package.json")));
      const manifests = group
        .map((unit) => path.join(unit.root, "package.json"))
        .filter((file) => fs.existsSync(file));
      const compilerOptions = {
        ...options,
        paths,
        rootDir,
        noEmit: false,
        declaration: true,
        emitDeclarationOnly: true,
        noEmitOnError: true,
        declarationMap: false,
        incremental: true,
        allowImportingTsExtensions: true,
      };
      // Disposable projections have different physical locations but the same
      // package coordinates. Declaration layout and package identities, rather
      // than projection directory names, determine reusable compiler output.
      const sourceRoot = commonRoot(units.map((unit) => path.join(unit.root, "package.json")));
      const coordinate = (file: string) => {
        const unit = owner(file, units);
        if (unit) return `unit:${unit.name}/${path.relative(unit.root, file)}`;
        return file.startsWith(sourceRoot + path.sep)
          ? `source:${path.relative(sourceRoot, file)}`
          : file;
      };
      const identity = JSON.stringify({
        version: 4,
        nodeModulesDir,
        compilerOptions: {
          ...compilerOptions,
          rootDir: "<declaration-root>",
          paths: Object.fromEntries(
            Object.entries(paths)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([name, targets]) => [
                name,
                targets.map((target) => (owner(target, units) ? coordinate(target) : target)),
              ])
          ),
        },
        layout: group.map((unit) => ({ name: unit.name, root: path.relative(rootDir, unit.root) })),
        files: files.map(coordinate).sort(),
        manifests: manifests.map(coordinate).sort(),
      });
      const hash = createHash("sha256").update(identity);
      for (const file of [...files].sort((a, b) => coordinate(a).localeCompare(coordinate(b))))
        hash.update(coordinate(file)).update(fileDigest(file));
      for (const file of manifests) hash.update(coordinate(file)).update(fileDigest(file));
      // Installed dependencies and compiler identity are part of the boundary.
      hash.update(fileDigest(path.join(this.appRoot, "pnpm-lock.yaml")));
      const infrastructureReceipt = path.join(
        this.appRoot,
        ".cache/vibestudio-infrastructure-build.json"
      );
      if (fs.existsSync(infrastructureReceipt)) hash.update(fileDigest(infrastructureReceipt));
      const key = hash.digest("hex");
      const target = path.join(this.root, key);
      this.leases.push(this.coordinator.acquire(this.root, key));
      if (fs.existsSync(path.join(target, "complete.json")) && !validContract(target))
        throw new Error(`Declaration cache integrity failure: ${target}`);
      if (!validContract(target)) {
        const scratch = path.join(this.appRoot, ".cache", `typecheck-contract-${randomUUID()}`);
        fs.mkdirSync(scratch, { recursive: true });
        try {
          fs.symlinkSync(
            nodeModulesDir,
            path.join(scratch, "node_modules"),
            process.platform === "win32" ? "junction" : "dir"
          );
          const config = path.join(scratch, "tsconfig.json");
          fs.writeFileSync(
            config,
            JSON.stringify({
              files: files.filter(
                (file) => /\.[cm]?tsx?$/.test(file) || options["allowJs"] === true
              ),
              compilerOptions: {
                ...compilerOptions,
                outDir: path.join(scratch, "types"),
                tsBuildInfoFile: path.join(scratch, "state.tsbuildinfo"),
              },
            })
          );
          this.compile(config);
          for (const file of [
            ...manifests,
            ...files.filter((file) => file.endsWith(".json") || /\.d\.[cm]?ts$/.test(file)),
          ]) {
            const relative = path.relative(rootDir, file);
            if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
            const destination = path.join(scratch, "types", relative);
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            fs.copyFileSync(file, destination);
          }
          const completedHash = createHash("sha256").update(identity);
          for (const file of [...files].sort((a, b) => coordinate(a).localeCompare(coordinate(b))))
            completedHash.update(coordinate(file)).update(fileDigest(file));
          for (const file of manifests)
            completedHash.update(coordinate(file)).update(fileDigest(file));
          completedHash.update(fileDigest(path.join(this.appRoot, "pnpm-lock.yaml")));
          if (fs.existsSync(infrastructureReceipt))
            completedHash.update(fileDigest(infrastructureReceipt));
          if (completedHash.digest("hex") !== key)
            throw new Error("Validation inputs changed during declaration compilation");
          fs.writeFileSync(
            path.join(scratch, "complete.json"),
            JSON.stringify({
              key,
              nodeModulesDir,
              units: group.map((unit) => unit.name),
              outputs: outputManifest(path.join(scratch, "types")),
            })
          );
          fs.rmSync(config);
          try {
            fs.renameSync(scratch, target);
          } catch (error) {
            if (!validContract(target)) throw error;
          }
        } finally {
          fs.rmSync(scratch, { recursive: true, force: true });
        }
      }
      for (const [specifier, targets] of Object.entries(paths)) {
        paths[specifier] = targets.map((file) => {
          if (!group.some((unit) => owner(file.split("*")[0]!, [unit]))) return file;
          if (/\.d\.[cm]?ts$/.test(file)) return file;
          return path
            .join(target, "types", path.relative(rootDir, file))
            .replace(/\.mts$/, ".d.mts")
            .replace(/\.cts$/, ".d.cts")
            .replace(/\.tsx?$/, ".d.ts");
        });
      }
      console.log(`✓ declarations: ${group.map((unit) => unit.name).join(", ")}`);
    }
    return paths;
  }

  check(
    name: string,
    files: string[],
    compilerOptions: Record<string, unknown>,
    extendsConfig?: string
  ): void {
    if (!files.length) return;
    const cacheRoot = path.join(this.appRoot, ".cache", "typecheck-state");
    const { rootDir: _rootDir, outDir: _outDir, ...checkOptions } = compilerOptions;
    // Declaration locations change with content. The compiler validates those
    // changes; retain the preceding program state instead of discarding it.
    const { paths: _paths, ...identityOptions } = checkOptions;
    const key = createHash("sha256")
      .update(JSON.stringify({ name, compilerOptions: identityOptions, extendsConfig }))
      .digest("hex");
    this.leases.push(this.coordinator.acquire(cacheRoot, key));
    const root = path.join(cacheRoot, key);
    fs.mkdirSync(root, { recursive: true });
    const state = path.join(root, "state.tsbuildinfo");
    const id = randomUUID();
    const config = path.join(root, `${key}-${id}.json`);
    const ownedState = path.join(root, `${key}-${id}.tsbuildinfo`);
    try {
      if (fs.existsSync(state)) fs.copyFileSync(state, ownedState);
      fs.writeFileSync(
        config,
        JSON.stringify({
          extends: extendsConfig,
          files,
          compilerOptions: {
            ...checkOptions,
            noEmit: true,
            incremental: true,
            tsBuildInfoFile: ownedState,
          },
        })
      );
      this.compile(config);
      fs.renameSync(ownedState, state);
      console.log(`✓ ${name}`);
    } finally {
      fs.rmSync(config, { force: true });
      fs.rmSync(ownedState, { force: true });
    }
  }

  checkUnits(
    units: ValidationUnit[],
    sourcePaths: ValidationPaths,
    declarationPaths: ValidationPaths,
    options: Record<string, unknown>,
    ambientFiles: string[] = []
  ): void {
    for (const group of validationGroups(units, sourcePaths)) {
      const paths = { ...declarationPaths };
      for (const [name, targets] of Object.entries(sourcePaths)) {
        if (targets.some((target) => group.some((unit) => owner(target.split("*")[0]!, [unit]))))
          paths[name] = targets;
      }
      this.check(
        group.map((unit) => unit.name).join(", "),
        [...new Set([...group.flatMap((unit) => unit.files), ...ambientFiles])],
        { ...options, paths }
      );
    }
  }

  private compile(config: string): void {
    execFileSync(
      path.join(this.appRoot, "node_modules/typescript/bin/tsc"),
      ["--project", config, "--pretty", "false"],
      { cwd: this.appRoot, stdio: "inherit" }
    );
  }

  async close(): Promise<void> {
    try {
      for (const lease of this.leases) lease.release();
      await this.coordinator.prune(this.root);
      await this.coordinator.prune(path.join(this.appRoot, ".cache", "typecheck-state"));
    } finally {
      this.coordinator.close();
    }
  }
}
