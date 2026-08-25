import * as fs from "node:fs";
import * as path from "node:path";
import {
  DEFAULT_DERIVED_CACHE_MAX_BYTES,
  DerivedCacheCoordinator,
  derivedCacheDatabasePath,
  type DerivedCachePruneResult,
} from "@vibestudio/shared/derivedCache";
import {
  getCentralDataPath,
  getProfileDataPath,
  getSharedDerivedDataPath,
} from "@vibestudio/env-paths";
import { JSON_FLAG, type CliCommand, type ParsedInvocation } from "./commandTable.js";
import { UsageError, jsonMode, printError, printResult } from "./output.js";

interface StorageRoot {
  kind: "live-safe" | "offline-only";
  name: string;
  path: string;
}

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
    { kind: "live-safe", name: "shared build results", path: path.join(shared, "build-results") },
    {
      kind: "offline-only",
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

function gibibytes(value: string | boolean | undefined): number {
  if (typeof value !== "string") return DEFAULT_DERIVED_CACHE_MAX_BYTES;
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

function offlineStatus(root: StorageRoot) {
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
        const coordinator = new DerivedCacheCoordinator(derivedCacheDatabasePath(root.path));
        try {
          return { ...root, ...(await coordinator.status(root.path)) };
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
          ...(await coordinator.prune(root.path, { maxBytes, dryRun })),
        });
      } finally {
        coordinator.close();
      }
    }
    printResult(
      { dryRun, maxBytes, roots: results },
      {
        json,
        human: () => {
          for (const result of results) {
            console.log(
              `${result.name}: ${dryRun ? "would remove" : "removed"} ` +
                `${result.removedEntries} entries / ${humanBytes(result.removedBytes)}; ` +
                `${humanBytes(result.bytes)} ${dryRun ? "would remain" : "remain"}`
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
        description: "Maximum size of each live-safe cache root",
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
