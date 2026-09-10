import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
  acquireExactGitSnapshot,
  readExactGitSnapshot,
  readThroughImmutableGitCheckout,
  type ExactGitSnapshot,
  type GitClient,
  type SnapshotContentSink,
} from "@vibestudio/git";
import type { WorkspaceTemplatePin } from "@vibestudio/workspace-contracts/types";
import { WorkspaceTemplatePinSchema } from "@vibestudio/workspace-contracts/workspaceConfigSchema";
import {
  canonicalTemplateNodeId,
  TEMPLATE_RESERVED_PATH_POLICY,
  templateGitTransportUrl,
} from "@vibestudio/workspace/templateCoordinates";
import { getSharedDerivedDataPath } from "@vibestudio/env-paths";

/**
 * Where an exact template checkout is cached.
 *
 * Profile-level derived data rather than workspace state, which is what this
 * content is: keyed by URL and commit, and every hit validated by reading that
 * exact commit's tree. Two workspaces built on one template — the ordinary
 * case now that a distribution declares its dependencies instead of copying
 * them — clone it once between them rather than once each. Supervisors and
 * tests point VIBESTUDIO_SHARED_DERIVED_CACHE_DIR somewhere private to stay
 * hermetic.
 */
function rootTemplateCheckoutTarget(pin: { url: string; commit: string }): string {
  return path.join(
    getSharedDerivedDataPath(),
    "root-templates",
    canonicalTemplateNodeId(pin.url, pin.commit)
  );
}

/**
 * Acquire the one immutable root snapshot through an atomic checkout cache.
 * A crash may leave a complete published coordinate or a private temporary
 * attempt, never a half-cloned checkout at the coordinate used by retries.
 */
export function acquireRootTemplateSnapshot(input: {
  pin: WorkspaceTemplatePin;
  git: GitClient;
  sink: SnapshotContentSink;
  fs?: typeof fsp;
}): Promise<ExactGitSnapshot> {
  const fs = input.fs ?? fsp;
  const label = `workspace root template ${input.pin.url}`;
  const target = rootTemplateCheckoutTarget(input.pin);
  const read = (dir: string) =>
    readExactGitSnapshot({
      git: input.git,
      dir,
      commit: input.pin.commit,
      label,
      sink: input.sink,
      reservedPaths: TEMPLATE_RESERVED_PATH_POLICY,
    });
  return readThroughImmutableGitCheckout({
    fs,
    target,
    label: "root-template",
    read,
    prepare: (dir) =>
      acquireExactGitSnapshot({
        git: input.git,
        dir,
        url: templateGitTransportUrl(input.pin.url),
        ref: input.pin.ref,
        expectedCommit: input.pin.commit,
        label,
        sink: input.sink,
        reservedPaths: TEMPLATE_RESERVED_PATH_POLICY,
      }),
  });
}

/**
 * Seed the same content-addressed snapshot boundary from a local committed
 * checkout. Only the named commit tree is read; dirty worktree bytes are never
 * admitted and the commit need not be reachable from a remote.
 */
export function seedRootTemplateSnapshotFromCheckout(input: {
  checkout: string;
  pin: WorkspaceTemplatePin;
  git: GitClient;
  sink: SnapshotContentSink;
  fs?: typeof fsp;
}): Promise<ExactGitSnapshot> {
  const fs = input.fs ?? fsp;
  const label = `local workspace root template ${input.pin.url}`;
  const target = rootTemplateCheckoutTarget(input.pin);
  return readThroughImmutableGitCheckout({
    fs,
    target,
    label: "local-root-template-seed",
    read: (dir) =>
      readExactGitSnapshot({
        git: input.git,
        dir,
        commit: input.pin.commit,
        label,
        sink: input.sink,
        reservedPaths: TEMPLATE_RESERVED_PATH_POLICY,
      }),
    prepare: async (dir) => {
      // This is a transport adapter, not a second resolver. Copy the repository
      // database into the private atomic attempt, then apply the exact same
      // commit-tree and snapshot verification used by ordinary acquisition.
      // Worktree dirt is harmless because readExactGitSnapshot reads the named
      // commit tree rather than filesystem bytes.
      const startedAt = performance.now();
      await fs.cp(path.resolve(input.checkout), dir, { recursive: true });
      const copiedAt = performance.now();
      const snapshot = await readExactGitSnapshot({
        git: input.git,
        dir,
        commit: input.pin.commit,
        label,
        sink: input.sink,
        reservedPaths: TEMPLATE_RESERVED_PATH_POLICY,
      });
      const readAt = performance.now();
      if (readAt - startedAt >= 100) {
        console.log("[Perf] local root template seed", {
          copyMs: copiedAt - startedAt,
          readMs: readAt - copiedAt,
          totalMs: readAt - startedAt,
        });
      }
      return snapshot;
    },
  });
}

/**
 * Resolve one developer-selected committed checkpoint into the same exact pin
 * and cache coordinate used by remote acquisition. Tracked edits are rejected:
 * the candidate is the commit, never an accidental mixture of HEAD and the
 * worktree. Untracked paths are reported but excluded from the immutable tree.
 */
export async function discoverAndSeedRootTemplateSnapshotFromCheckout(input: {
  checkout: string;
  url: string;
  git: GitClient;
  sink: SnapshotContentSink;
  fs?: typeof fsp;
}): Promise<{
  pin: WorkspaceTemplatePin;
  snapshot: ExactGitSnapshot;
  untrackedPaths: string[];
}> {
  const discovered = await inspectRootTemplateCheckout(input);
  const snapshot = await seedRootTemplateSnapshotFromCheckout({
    checkout: input.checkout,
    pin: discovered.pin,
    git: input.git,
    sink: input.sink,
    ...(input.fs ? { fs: input.fs } : {}),
  });
  return { ...discovered, snapshot };
}

/** Resolve an explicitly selected checkout HEAD without publishing or seeding it. */
export async function inspectRootTemplateCheckout(input: {
  checkout: string;
  url: string;
  git: GitClient;
  sink: SnapshotContentSink;
  validateSnapshot?: (snapshot: ExactGitSnapshot) => Promise<void> | void;
}): Promise<{
  pin: WorkspaceTemplatePin;
  untrackedPaths: string[];
}> {
  const checkout = path.resolve(input.checkout);
  const status = await input.git.status(checkout);
  if (!status.commit) throw new Error(`Local root template checkout ${checkout} has no commit`);
  if (!status.branch) {
    throw new Error(`Local root template checkout ${checkout} must be on a named branch`);
  }
  const trackedChanges = status.files.filter((file) => file.status !== "untracked");
  if (trackedChanges.length > 0) {
    throw new Error(
      `Local root template checkpoint has tracked worktree changes: ${trackedChanges
        .map((file) => file.path)
        .join(", ")}; commit or restore them before selecting the checkpoint`
    );
  }
  const untrackedPaths = status.files
    .filter((file) => file.status === "untracked")
    .map((file) => file.path)
    .sort();
  const observed = await readExactGitSnapshot({
    git: input.git,
    dir: checkout,
    commit: status.commit,
    label: `local workspace root template ${input.url}`,
    sink: input.sink,
    reservedPaths: TEMPLATE_RESERVED_PATH_POLICY,
  });
  await input.validateSnapshot?.(observed);
  const pin = WorkspaceTemplatePinSchema.parse({
    url: input.url,
    ref: `refs/heads/${status.branch}`,
    commit: observed.commit,
  }) as WorkspaceTemplatePin;
  return { pin, untrackedPaths };
}
