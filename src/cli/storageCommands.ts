import { compactCompletedSystemTestTrajectories } from "./systemTestStore.js";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  DerivedCacheCoordinator,
  derivedCacheDatabasePath,
  derivedCacheMaxBytes,
  type DerivedCachePruneResult,
} from "@vibestudio/shared/derivedCache";
import {
  getCentralDataPath,
  getProfileDataPath,
  getSharedDerivedDataPath,
} from "@vibestudio/env-paths";
import { JSON_FLAG, type CliCommand, type ParsedInvocation } from "./commandTable.js";
import { UsageError, jsonMode, printError, printResult } from "./output.js";
import { collectArtifactPool } from "../server/buildV2/buildArtifactPool.js";

type StorageRoot =
  | { kind: "live-safe"; name: string; path: string }
  | { kind: "link-pool"; name: string; path: string }
  | { kind: "offline-only"; name: string; path: string };

function cacheRoots(): StorageRoot[] {
  const profile = getProfileDataPath();
  const shared = getSharedDerivedDataPath();
  const roots: StorageRoot[] = [
    {
      kind: "live-safe",
      name: "shared external dependencies",
      path: path.join(shared, "external-deps"),
    },
    {
      kind: "live-safe",
      name: "shared extension runtime installations",
      path: path.join(shared, "extension-runtime-deps"),
    },
    {
      kind: "live-safe",
      name: "shared transport derivatives",
      path: path.join(shared, "transport-derivatives"),
    },
    { kind: "live-safe", name: "shared build results", path: path.join(shared, "build-results") },
    {
      kind: "live-safe",
      name: "shared root template checkouts",
      path: path.join(shared, "root-templates"),
    },
    {
      kind: "link-pool",
      name: "shared build artifacts",
      path: path.join(shared, "build-artifacts"),
    },
    {
      kind: "live-safe",
      name: "selected instance build cache",
      path: path.join(getCentralDataPath(), "build-cache"),
    },
    { kind: "offline-only", name: "shared npm cache", path: path.join(shared, "npm-cache") },
    {
      kind: "live-safe",
      name: "shared npm registry downloads",
      path: path.join(shared, "npm-registry-downloads"),
    },
    {
      kind: "offline-only",
      name: "selected instance transport derivatives",
      path: path.join(getCentralDataPath(), "transport-cache"),
    },
    {
      kind: "offline-only",
      name: "shared dependency file content",
      path: path.join(shared, "dependency-files"),
    },
    {
      kind: "offline-only",
      name: "shared authority analysis",
      path: path.join(shared, "authority-analysis"),
    },
    {
      kind: "offline-only",
      name: "selected instance CAS",
      path: path.join(getCentralDataPath(), "cas"),
    },
  ];

  const instanceState = path.join(profile, "instance-state");
  try {
    for (const repo of fs.readdirSync(instanceState, { withFileTypes: true })) {
      if (!repo.isDirectory()) continue;
      const repoRoot = path.join(instanceState, repo.name);
      for (const instance of fs.readdirSync(repoRoot, { withFileTypes: true })) {
        if (!instance.isDirectory()) continue;
        roots.push({
          kind: "live-safe",
          name: `instance ${repo.name}/${instance.name} build cache`,
          path: path.join(repoRoot, instance.name, "build-cache"),
        });
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const unique = new Map<string, StorageRoot>();
  for (const root of roots) unique.set(path.resolve(root.path), root);
  return [...unique.values()].filter((root) => fs.existsSync(root.path));
}

function gibibytes(value: string | boolean | undefined): number | undefined {
  if (typeof value !== "string") return undefined;
  const gib = Number(value);
  if (!Number.isFinite(gib) || gib < 0.25 || gib > 1024) {
    throw new UsageError("--max-gib must be a number from 0.25 to 1024");
  }
  return Math.floor(gib * 1024 ** 3);
}

function humanBytes(bytes: number): string {
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

function storedBytes(storedPath: string): number {
  const stat = fs.lstatSync(storedPath);
  if (!stat.isDirectory()) {
    return Math.ceil((stat.blocks * 512 || stat.size) / Math.max(1, stat.nlink));
  }
  return fs
    .readdirSync(storedPath)
    .reduce((total, child) => total + storedBytes(path.join(storedPath, child)), stat.blocks * 512);
}

function offlineStatus(root: Extract<StorageRoot, { kind: "offline-only" }>) {
  const entries = fs.readdirSync(root.path, { withFileTypes: true });
  const statfs = fs.statfsSync(root.path);
  return {
    ...root,
    root: root.path,
    bytes: storedBytes(root.path),
    entries: entries.length,
    leasedEntries: 0,
    reclaimableBytes: 0,
    availableBytes: Number(statfs.bavail) * Number(statfs.bsize),
  };
}

async function status(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const roots = await Promise.all(
      cacheRoots().map(async (root) => {
        if (root.kind === "offline-only") return offlineStatus(root);
        if (root.kind === "link-pool") {
          const pool = await collectArtifactPool(root.path, { dryRun: true });
          const disk = fs.statfsSync(root.path);
          return {
            ...root,
            root: root.path,
            bytes: storedBytes(root.path),
            entries: pool.files,
            leasedEntries: 0,
            reclaimableBytes: pool.reclaimableBytes,
            availableBytes: Number(disk.bavail) * Number(disk.bsize),
          };
        }
        const coordinator = new DerivedCacheCoordinator(derivedCacheDatabasePath(root.path));
        try {
          return {
            ...root,
            ...(await coordinator.status(root.path)),
            maxBytes: derivedCacheMaxBytes(root.path),
          };
        } finally {
          coordinator.close();
        }
      })
    );
    printResult(
      { roots },
      {
        json,
        human: () => {
          for (const root of roots) {
            console.log(
              `${root.name}: ${humanBytes(root.bytes)} in ${root.entries} entries` +
                (root.kind === "live-safe" ? ` (limit ${humanBytes(root.maxBytes)})` : "") +
                ` (${humanBytes(root.reclaimableBytes)} currently reclaimable, ${root.kind})`
            );
          }
        },
      }
    );
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

async function prune(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  const dryRun = inv.flags["dry-run"] === true;
  try {
    // Inside the guard: a rejected --max-gib is a usage error, and reporting it
    // through printError is what preserves the exit code and the --json error
    // shape that scripted callers parse.
    const maxBytes = gibibytes(inv.flags["max-gib"]);
    const results: Array<StorageRoot & DerivedCachePruneResult> = [];
    for (const root of cacheRoots().filter((candidate) => candidate.kind === "live-safe")) {
      const coordinator = new DerivedCacheCoordinator(derivedCacheDatabasePath(root.path));
      try {
        results.push({
          ...root,
          ...(await coordinator.prune(root.path, {
            ...(maxBytes === undefined ? {} : { maxBytes }),
            dryRun,
          })),
        });
      } finally {
        coordinator.close();
      }
    }
    // This pool is a content-sharing index, not workspace durable storage.
    // Each build owns its own link or copy; collection removes pool-only names.
    const artifactPool = await collectArtifactPool(
      path.join(getSharedDerivedDataPath(), "build-artifacts"),
      { dryRun }
    );
    const systemTestEvidence = await compactCompletedSystemTestTrajectories({ dryRun });
    printResult(
      {
        dryRun,
        ...(maxBytes === undefined ? {} : { maxBytes }),
        roots: results,
        artifactPool,
        systemTestEvidence,
      },
      {
        json,
        human: () => {
          for (const result of results) {
            console.log(
              `${result.name}: ${dryRun ? "would remove" : "removed"} ` +
                `${result.removedEntries} entries / ${humanBytes(result.removedBytes)}; ` +
                `${humanBytes(result.bytes)} ${dryRun ? "would remain" : "remain"} ` +
                `(limit ${humanBytes(result.targetBytes)})`
            );
          }
          console.log(
            `Shared artifact pool: ${dryRun ? "would remove" : "removed"} ` +
              `${dryRun ? artifactPool.reclaimableFiles : artifactPool.removedFiles} files / ` +
              humanBytes(dryRun ? artifactPool.reclaimableBytes : artifactPool.removedBytes)
          );
          console.log(
            `Completed test trajectories: ${systemTestEvidence.files} files; ` +
              (dryRun
                ? `${humanBytes(systemTestEvidence.originalBytes)} available for lossless compression`
                : `${humanBytes(systemTestEvidence.originalBytes)} compressed to ${humanBytes(systemTestEvidence.compressedBytes)}`)
          );
        },
      }
    );
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

export const storageCommands: CliCommand[] = [
  {
    group: "storage",
    name: "status",
    summary: "Inspect regenerable Vibestudio storage and live cache leases",
    flags: [JSON_FLAG],
    run: status,
  },
  {
    group: "storage",
    name: "prune",
    summary: "Prune only live-safe, unleased derived cache entries",
    usage: "vibestudio storage prune [--max-gib <GiB>] [--dry-run] [--json]",
    flags: [
      {
        name: "max-gib",
        takesValue: true,
        description: "Override the configured size limit for every live-safe cache root",
      },
      {
        name: "dry-run",
        takesValue: false,
        description: "Report reclaimable entries without deleting",
      },
      JSON_FLAG,
    ],
    run: prune,
  },
];
