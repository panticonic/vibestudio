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
