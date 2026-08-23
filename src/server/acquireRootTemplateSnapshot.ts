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

/**
 * Acquire the one immutable root snapshot through an atomic checkout cache.
 * A crash may leave a complete published coordinate or a private temporary
 * attempt, never a half-cloned checkout at the coordinate used by retries.
 */
export function acquireRootTemplateSnapshot(input: {
  statePath: string;
  pin: WorkspaceTemplatePin;
  git: GitClient;
  sink: SnapshotContentSink;
  fs?: typeof fsp;
}): Promise<ExactGitSnapshot> {
  const fs = input.fs ?? fsp;
  const label = `workspace root template ${input.pin.url}`;
  const target = path.join(
    input.statePath,
    "git-checkouts",
    "_root-template",
    canonicalTemplateNodeId(input.pin.url, input.pin.commit)
  );
  const read = (dir: string) =>
    readExactGitSnapshot({
      git: input.git,
      dir,
      commit: input.pin.commit,
      expectedSnapshot: input.pin.snapshot,
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
        expectedSnapshot: input.pin.snapshot,
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
  statePath: string;
  checkout: string;
  pin: WorkspaceTemplatePin;
  git: GitClient;
  sink: SnapshotContentSink;
  fs?: typeof fsp;
}): Promise<ExactGitSnapshot> {
  const fs = input.fs ?? fsp;
  const label = `local workspace root template ${input.pin.url}`;
  const target = path.join(
    input.statePath,
    "git-checkouts",
    "_root-template",
    canonicalTemplateNodeId(input.pin.url, input.pin.commit)
  );
  return readThroughImmutableGitCheckout({
    fs,
    target,
    label: "local-root-template-seed",
    read: (dir) =>
      readExactGitSnapshot({
        git: input.git,
        dir,
        commit: input.pin.commit,
        expectedSnapshot: input.pin.snapshot,
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
      await fs.cp(path.resolve(input.checkout), dir, { recursive: true });
      return readExactGitSnapshot({
        git: input.git,
        dir,
        commit: input.pin.commit,
        expectedSnapshot: input.pin.snapshot,
        label,
        sink: input.sink,
        reservedPaths: TEMPLATE_RESERVED_PATH_POLICY,
      });
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
  statePath: string;
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
    statePath: input.statePath,
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
    snapshot: observed.snapshot,
  }) as WorkspaceTemplatePin;
  return { pin, untrackedPaths };
}
