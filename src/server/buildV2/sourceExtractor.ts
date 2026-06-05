/**
 * Source Extractor — extracts source files from git at specific commits.
 *
 * Before building, we extract source files at the correct git ref into a temp
 * directory so esbuild reads the content that matches the EV, not whatever
 * happens to be checked out in the working tree.
 *
 * Uses `git archive` piped to `tar` for extraction — no shell involved.
 */

import { mkdir, mkdtemp, rm } from "fs/promises";
import * as path from "path";
import * as os from "os";
import { spawn, type ChildProcess } from "child_process";
import type { GraphNode, PackageGraph } from "./packageGraph.js";
import { getCommitAt, resolveMainRef } from "./effectiveVersion.js";
import { spawnGit } from "@natstack/shared/gitRuntime";
import { assertPresent } from "../../lintHelpers";

// ---------------------------------------------------------------------------
// Git Archive Extraction
// ---------------------------------------------------------------------------

interface ProcessCloseResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export function waitForClose(child: ChildProcess): Promise<ProcessCloseResult> {
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
}

export function processFailureMessage(
  label: string,
  repoPath: string,
  commitSha: string,
  result: ProcessCloseResult,
  stderr: string
): string | null {
  if (result.signal) {
    return `${label} was killed by signal ${result.signal} for ${repoPath} at ${commitSha}: ${stderr}`;
  }
  if (result.code !== 0) {
    return `${label} failed for ${repoPath} at ${commitSha}: ${stderr}`;
  }
  return null;
}

/**
 * Extract the full git tree at a specific commit into a target directory.
 * Streams `git archive --format=tar <commit>` into `tar -x -C <dir>` — async and
 * fully streamed (no synchronous spawn, no large in-memory buffers), so it never
 * blocks the server event loop that also relays DO traffic.
 */
async function extractGitTree(
  repoPath: string,
  commitSha: string,
  targetDir: string
): Promise<void> {
  const archive = spawnGit(["archive", "--format=tar", commitSha], {
    cwd: repoPath,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const extract = spawn("tar", ["-x", "-C", targetDir], {
    stdio: ["pipe", "ignore", "pipe"],
  });

  let archiveErr = "";
  let extractErr = "";
  archive.stderr?.on("data", (chunk) => {
    archiveErr += chunk.toString();
  });
  extract.stderr?.on("data", (chunk) => {
    extractErr += chunk.toString();
  });

  // Stream archive stdout → tar stdin (backpressure-aware pipe, no buffering).
  if (archive.stdout && extract.stdin) archive.stdout.pipe(extract.stdin);

  const [archiveResult, extractResult] = await Promise.all([
    waitForClose(archive),
    waitForClose(extract),
  ]);

  const archiveFailure = processFailureMessage(
    "git archive",
    repoPath,
    commitSha,
    archiveResult,
    archiveErr
  );
  if (archiveFailure) throw new Error(archiveFailure);
  const extractFailure = processFailureMessage(
    "tar extract",
    repoPath,
    commitSha,
    extractResult,
    extractErr
  );
  if (extractFailure) throw new Error(extractFailure);
}

// ---------------------------------------------------------------------------
// Transitive Dependency Collection
// ---------------------------------------------------------------------------

/**
 * Walk internalDeps recursively to collect all nodes needed for a build.
 * Returns the target node plus all its transitive internal dependencies.
 */
export function collectTransitiveInternalDeps(node: GraphNode, graph: PackageGraph): GraphNode[] {
  const visited = new Set<string>();
  const result: GraphNode[] = [];

  function walk(n: GraphNode): void {
    if (visited.has(n.name)) return;
    visited.add(n.name);

    for (const depName of n.internalDeps) {
      const dep = graph.tryGet(depName);
      if (dep) walk(dep);
    }

    result.push(n);
  }

  walk(node);
  return result;
}

// ---------------------------------------------------------------------------
// Source Extraction for Build
// ---------------------------------------------------------------------------

export interface ExtractedSource {
  /** Root directory containing extracted source (temp dir) */
  sourceRoot: string;
  /** Clean up the extracted source (async; safe to await) */
  cleanup(): Promise<void>;
}

/**
 * Extract source files from git for a unit and all its transitive internal deps.
 *
 * Phase 1 (sync): Resolve commit SHAs for every node — prefers pre-captured
 * commits from commitMap (built by pushTrigger from persisted ref state), falls
 * back to resolving from git when absent (cold-start / on-demand paths). All SHAs
 * captured before any extraction begins, so concurrent pushes can't create
 * inconsistency.
 *
 * Phase 2 (sync): Extract each node at its captured SHA via git archive.
 *
 * Preserves relative paths: <sourceRoot>/panels/chat/, <sourceRoot>/packages/core/
 */
export async function extractSourceForBuild(
  unit: GraphNode,
  graph: PackageGraph,
  workspaceRoot: string,
  commitMap?: Map<string, string>
): Promise<ExtractedSource> {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "natstack-source-"));

  // Collect all nodes needed for this build
  const nodes = collectTransitiveInternalDeps(unit, graph);

  // Phase 1: Resolve commit SHAs — prefer pre-captured, fall back to a single
  // fast `git rev-parse` (sub-ms; left synchronous to avoid rippling
  // effectiveVersion async). The heavy work (archive+tar) is streamed async below.
  const resolvedMap = new Map<string, string>();
  for (const node of nodes) {
    const preCapture = commitMap?.get(node.name);
    if (preCapture) {
      resolvedMap.set(node.name, preCapture);
    } else {
      // Resolve current main ref (cold-start / on-demand fallback)
      const ref = resolveMainRef(node.path);
      const sha = getCommitAt(node.path, ref);
      if (!sha) {
        throw new Error(`Cannot resolve commit for ${node.name} at ${node.path}`);
      }
      resolvedMap.set(node.name, sha);
    }
  }

  // Phase 2: Extract each node at its captured SHA (streamed, async)
  try {
    for (const node of nodes) {
      const sha = assertPresent(resolvedMap.get(node.name));
      // Sanity check: SHA should be a hex string, not a version spec
      if (sha && !sha.match(/^[0-9a-f]{7,40}$/i) && !sha.startsWith("refs/")) {
        throw new Error(
          `Invalid commit SHA for ${node.name}: "${sha}" (expected hex SHA or ref). ` +
            `This likely means a dependency version like "workspace:*" leaked through as a git ref.`
        );
      }
      const relPath = path.relative(workspaceRoot, node.path);
      const extractTarget = path.join(sourceRoot, relPath);
      await mkdir(extractTarget, { recursive: true });
      await extractGitTree(node.path, sha, extractTarget);
    }
  } catch (error) {
    // Clean up on extraction failure
    await rm(sourceRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  return {
    sourceRoot,
    async cleanup() {
      await rm(sourceRoot, { recursive: true, force: true }).catch(() => {});
    },
  };
}
