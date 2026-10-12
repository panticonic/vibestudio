import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile, fork } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { DerivedCacheCoordinator, derivedCacheDatabasePath } from "@vibestudio/shared/derivedCache";

const execute = promisify(execFile);
const hostArtifactRoot = path.resolve(process.env["VIBESTUDIO_HOST_ARTIFACT_ROOT"]!);

it("maintains build and native extension dependency trees through the real child owner", async () => {
  const scratch = path.join(process.cwd(), ".cache/dependency-maintenance-tests");
  await fs.mkdir(scratch, { recursive: true });
  const fixture = await fs.mkdtemp(path.join(scratch, "run-"));
  try {
    const caches = [
      path.join(fixture, "external-deps/1111111111111111"),
      path.join(fixture, "extension-runtime-deps/2222222222222222-darwin-arm64-node24.21.0"),
    ];
    const preparations = caches.map((cache, index) => ({
      cacheDir: cache,
      stagingDir: `${cache}.tmp.${String(index + 1).repeat(32)}`,
    }));
    for (const { stagingDir } of preparations) {
      await fs.mkdir(path.join(stagingDir, "node_modules/example"), { recursive: true });
      await fs.writeFile(
        path.join(stagingDir, "node_modules/example/index.js"),
        "export const value = 42;\n"
      );
      await fs.writeFile(path.join(stagingDir, ".ready"), "ready");
    }
    await execute(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/server/buildV2/dependencyContentMaintenanceProcess.ts",
        JSON.stringify({ hostArtifactRoot, preparations, prune: false }),
      ],
      {
        env: {
          ...process.env,
          VIBESTUDIO_HOST_ARTIFACT_ROOT: hostArtifactRoot,
          VIBESTUDIO_SHARED_DERIVED_CACHE_DIR: fixture,
        },
      }
    );
    const stats = await Promise.all(
      preparations.map(({ stagingDir }) =>
        fs.stat(path.join(stagingDir, "node_modules/example/index.js"))
      )
    );
    expect(stats[0]!.ino).toBe(stats[1]!.ino);
    expect(stats[0]!.dev).toBe(stats[1]!.dev);
    expect(stats[0]!.nlink).toBeGreaterThanOrEqual(3);
    const outside = path.join(fixture, "unowned/3333333333333333");
    await expect(
      execute(
        process.execPath,
        [
          "--import",
          "tsx",
          "src/server/buildV2/dependencyContentMaintenanceProcess.ts",
          JSON.stringify({
            hostArtifactRoot,
            preparations: [{ stagingDir: `${outside}.tmp.${"c".repeat(32)}`, cacheDir: outside }],
            prune: false,
          }),
        ],
        {
          env: {
            ...process.env,
            VIBESTUDIO_HOST_ARTIFACT_ROOT: hostArtifactRoot,
            VIBESTUDIO_SHARED_DERIVED_CACHE_DIR: fixture,
          },
        }
      )
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Refusing invalid dependency cache directory"),
    });
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

it("prepares private staging content without rewriting a borrowed published cache", async () => {
  const scratch = path.join(process.cwd(), ".cache/dependency-maintenance-tests");
  await fs.mkdir(scratch, { recursive: true });
  const fixture = await fs.mkdtemp(path.join(scratch, "published-cache-"));
  const root = path.join(fixture, "external-deps");
  const cacheDir = path.join(root, "4444444444444444");
  const stagingDir = `${cacheDir}.tmp.${"d".repeat(32)}`;
  const publishedFile = path.join(cacheDir, "node_modules/example/index.js");
  const stagedFile = path.join(stagingDir, "node_modules/example/index.js");
  const coordinator = new DerivedCacheCoordinator(derivedCacheDatabasePath(root));
  const lease = coordinator.acquire(root, "4444444444444444");
  try {
    await fs.mkdir(path.dirname(publishedFile), { recursive: true });
    await fs.mkdir(path.dirname(stagedFile), { recursive: true });
    await fs.writeFile(publishedFile, "published bytes\n");
    await fs.writeFile(path.join(cacheDir, ".ready"), "published");
    await fs.writeFile(stagedFile, "published bytes\n");
    await fs.writeFile(path.join(stagingDir, ".ready"), "staged");
    const before = await fs.stat(publishedFile);

    await execute(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/server/buildV2/dependencyContentMaintenanceProcess.ts",
        JSON.stringify({
          hostArtifactRoot,
          preparations: [{ stagingDir, cacheDir }],
          prune: false,
        }),
      ],
      {
        env: {
          ...process.env,
          VIBESTUDIO_HOST_ARTIFACT_ROOT: hostArtifactRoot,
          VIBESTUDIO_SHARED_DERIVED_CACHE_DIR: fixture,
        },
      }
    );

    const after = await fs.stat(publishedFile);
    expect(await fs.readFile(publishedFile, "utf8")).toBe("published bytes\n");
    expect(after.ino).toBe(before.ino);
    expect(after.dev).toBe(before.dev);
  } finally {
    lease.release();
    coordinator.close();
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

it("transfers the original maintenance failure graph to its process owner", async () => {
  const scratch = path.join(process.cwd(), ".cache/dependency-maintenance-tests");
  await fs.mkdir(scratch, { recursive: true });
  const fixture = await fs.mkdtemp(path.join(scratch, "failure-"));
  try {
    const outside = path.join(fixture, "unowned/3333333333333333");
    const child = fork(
      "src/server/buildV2/dependencyContentMaintenanceProcess.ts",
      [
        JSON.stringify({
          hostArtifactRoot,
          preparations: [{ stagingDir: `${outside}.tmp.${"c".repeat(32)}`, cacheDir: outside }],
          prune: false,
        }),
      ],
      {
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        env: {
          ...process.env,
          VIBESTUDIO_HOST_ARTIFACT_ROOT: hostArtifactRoot,
          VIBESTUDIO_SHARED_DERIVED_CACHE_DIR: fixture,
        },
      }
    );
    let results: unknown;
    const stderr: Buffer[] = [];
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("message", (message: unknown) => {
      if (
        message &&
        typeof message === "object" &&
        (message as { type?: unknown }).type === "dependency-maintenance-results"
      )
        results = (message as { results: unknown }).results;
    });
    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
      child.once("close", (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
    });
    expect(code).toBe(1);
    expect(signal).toBeNull();
    expect(results).toEqual([
      {
        ok: false,
        failure: expect.objectContaining({
          message: expect.stringContaining("Refusing invalid dependency cache directory"),
        }),
      },
    ]);
    expect(Buffer.concat(stderr).toString()).toContain(
      "Refusing invalid dependency cache directory"
    );
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

it("keeps the parent alive for awaited and queued maintenance preparations", async () => {
  const scratch = path.join(process.cwd(), ".cache/dependency-maintenance-tests");
  await fs.mkdir(scratch, { recursive: true });
  const fixture = await fs.mkdtemp(path.join(scratch, "awaited-parent-"));
  try {
    const cacheDirs = [
      path.join(fixture, "external-deps/5555555555555555"),
      path.join(fixture, "external-deps/6666666666666666"),
    ];
    const stagingDirs = cacheDirs.map(
      (cacheDir, index) => `${cacheDir}.tmp.${String(index + 1).repeat(32)}`
    );
    for (const stagingDir of stagingDirs) {
      await fs.mkdir(path.join(stagingDir, "node_modules/example"), { recursive: true });
      await fs.writeFile(path.join(stagingDir, "node_modules/example/index.js"), "export {};\n");
      await fs.writeFile(path.join(stagingDir, ".ready"), "ready");
    }
    const moduleUrl = pathToFileURL(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "dependencyContentMaintenance.ts")
    ).href;
    const program = `
      const maintenance = await import(${JSON.stringify(moduleUrl)});
      const root = process.env.VIBESTUDIO_HOST_ARTIFACT_ROOT;
      const first = maintenance.prepareDependencyContent(
        process.env.FIRST_STAGING_DIR,
        process.env.FIRST_CACHE_DIR,
        root
      );
      await Promise.resolve();
      const second = maintenance.prepareDependencyContent(
        process.env.SECOND_STAGING_DIR,
        process.env.SECOND_CACHE_DIR,
        root
      );
      await Promise.all([first, second]);
      await maintenance.drainDependencyContentMaintenance();
    `;
    await execute(process.execPath, ["--import", "tsx", "--input-type=module", "-e", program], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        VIBESTUDIO_HOST_ARTIFACT_ROOT: hostArtifactRoot,
        VIBESTUDIO_SHARED_DERIVED_CACHE_DIR: fixture,
        FIRST_STAGING_DIR: stagingDirs[0]!,
        FIRST_CACHE_DIR: cacheDirs[0]!,
        SECOND_STAGING_DIR: stagingDirs[1]!,
        SECOND_CACHE_DIR: cacheDirs[1]!,
      },
    });
    for (const stagingDir of stagingDirs)
      await expect(
        fs.readFile(path.join(stagingDir, "node_modules/example/index.js"), "utf8")
      ).resolves.toBe("export {};\n");
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
});
