import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
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
    files: string[],
    compilerOptions: Record<string, unknown>,
    extendsConfig?: string
  ): void {
    if (!files.length) return;
    const cacheRoot = path.join(this.appRoot, ".cache", "typecheck-state");
    const checkOptions = compilerOptions;
    // Disposable source projections can move. Keep prior state available; the
    // compiler validates the current roots, paths, options, and compiler version.
    const { paths: _paths, ...identityOptions } = checkOptions;
    const key = createHash("sha256")
      .update(JSON.stringify({ name, compilerOptions: identityOptions, config: extendsConfig && path.basename(extendsConfig) }))
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

  private compile(config: string): void {
    execFileSync(path.join(this.appRoot, "node_modules/typescript/bin/tsc"),
      ["--project", config, "--pretty", "false"],
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
