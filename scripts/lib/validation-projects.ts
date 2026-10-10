import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { configuredCompilerOptions } from "./host-validation.js";
import { DerivedCacheCoordinator, derivedCacheDatabasePath } from "@vibestudio/shared/derivedCache";

// Compiler programs retain their authoritative configs and complete ambient
// context. The compiler validates changed inputs/options against retained state.
export class ValidationProjects {
  private readonly root: string;
  private readonly coordinator: DerivedCacheCoordinator;
  private readonly leases: ReturnType<DerivedCacheCoordinator["acquire"]>[] = [];
  constructor(private readonly appRoot: string) {
    this.root = path.join(appRoot, ".cache", "typecheck-state");
    this.coordinator = new DerivedCacheCoordinator(derivedCacheDatabasePath(this.root));
  }
  check(
    name: string,
    sourceConfig: string
  ): void {
    const cacheRoot = path.join(this.appRoot, ".cache", "typecheck-state");
    // Compiler options define the diagnostic context. Distinct contexts must
    // not share cached diagnostics; source versions remain compiler-owned.
    const inherited = configuredCompilerOptions(sourceConfig);
    const { configFilePath: _configFilePath, ...scopeOptions } = inherited;
    const contextOptions: Record<string, unknown> = { ...scopeOptions, noEmit: true, incremental: true };
    // Source projections use the same layout at disposable physical locations.
    // Actual compiler options and file paths remain untouched in the program.
    for (const key of ["rootDir", "outDir", "baseUrl", "pathsBasePath"])
      if (typeof contextOptions[key] === "string")
        contextOptions[key] = path.relative(path.dirname(sourceConfig), contextOptions[key] as string);
    const key = createHash("sha256")
      .update(JSON.stringify({ name, compilerOptions: contextOptions, config: path.basename(sourceConfig) }))
      .digest("hex");
    this.leases.push(this.coordinator.acquire(cacheRoot, key));
    const root = path.join(cacheRoot, key);
    fs.mkdirSync(root, { recursive: true });
    const state = path.join(root, "state.tsbuildinfo");
    const id = randomUUID();
    const ownedState = path.join(root, `${key}-${id}.tsbuildinfo`);
    try {
      if (fs.existsSync(state)) fs.copyFileSync(state, ownedState);
      let failure: unknown;
      try {
        this.compile(sourceConfig, ownedState);
      } catch (error) {
        // A completed compiler can cache diagnostics as well as successful
        // checks. Launch failure or cancellation cannot publish owned state.
        if (typeof (error as {status?: unknown}).status !== "number") throw error;
        failure = error;
      }
      if (fs.existsSync(ownedState)) fs.renameSync(ownedState, state);
      if (failure) throw failure;
      console.log(`✓ ${name}`);
    } finally {
      fs.rmSync(ownedState, { force: true });
    }
  }

  private compile(config: string, state: string): void {
    execFileSync(path.join(this.appRoot, "node_modules/typescript/bin/tsc"),
      ["--project", config, "--noEmit", "--incremental", "--tsBuildInfoFile", state, "--pretty", "false"],
      { cwd: this.appRoot, stdio: "inherit" });
  }

  async close(): Promise<void> {
    try {
      for (const lease of this.leases) lease.release();
      await this.coordinator.prune(this.root);
    } finally {
      this.coordinator.close();
    }
  }
}
