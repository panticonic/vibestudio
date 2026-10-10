import type { WorkspaceConfig } from "@vibestudio/workspace-contracts/types";
import {
  buildWorkspaceDeclarations,
  type WorkspaceDeclarations,
} from "@vibestudio/workspace/singletonRegistry";
import { readWorkspaceConfig } from "@vibestudio/workspace/configParser";

type WorkspaceConfigFile = {
  content: { kind: "text"; text: string } | { kind: "bytes"; base64: string };
};

export interface WorkspaceConfigVcsReader {
  readFile(ref: string, filePath: string): Promise<WorkspaceConfigFile | null>;
}

export function normalizeStateRef(stateHash: string): string {
  return stateHash.startsWith("state:") ? stateHash : `state:${stateHash}`;
}

type Snapshot = { config: Promise<WorkspaceConfig>; declarations?: Promise<WorkspaceDeclarations> };
const snapshots = new WeakMap<WorkspaceConfigVcsReader, Map<string, Snapshot>>();
const MAX_SNAPSHOTS_PER_READER = 64;

/** The cache owns immutable content snapshots, never mutable context heads. */
function snapshotFromState(
  vcs: WorkspaceConfigVcsReader,
  workspaceId: string,
  stateHash: string
): Snapshot {
  const ref = normalizeStateRef(stateHash);
  let cache = snapshots.get(vcs);
  if (!cache) {
    cache = new Map();
    snapshots.set(vcs, cache);
  }
  const key = JSON.stringify([workspaceId, ref]);
  let snapshot = cache.get(key);
  if (!snapshot) {
    const config = readWorkspaceConfig(
      {
        readText: async (filePath) => {
          const file = await vcs.readFile(ref, filePath);
          return file?.content.kind === "text" ? file.content.text : null;
        },
      },
      workspaceId
    ).catch((error) => {
      throw new Error(
        `Cannot read workspace configuration from ${ref}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error }
      );
    });
    snapshot = { config };
    cache.set(key, snapshot);
    while (cache.size > MAX_SNAPSHOTS_PER_READER) cache.delete(cache.keys().next().value!);
    const pending = snapshot;
    void config.catch(() => {
      if (cache!.get(key) === pending) cache!.delete(key);
    });
  }
  return snapshot;
}

/** Public configuration consumers may edit their own copy. */
export async function readWorkspaceConfigFromState(
  vcs: WorkspaceConfigVcsReader,
  workspaceId: string,
  stateHash: string
): Promise<WorkspaceConfig> {
  return structuredClone(await snapshotFromState(vcs, workspaceId, stateHash).config);
}

function freezeDeclarations<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeclarations(child);
  return Object.freeze(value);
}

/** Borrow the validated immutable declarations for one exact content state.
 * Mutable context resolution belongs to its fenced owner before this read. */
export function readWorkspaceDeclarationsFromState(
  vcs: WorkspaceConfigVcsReader,
  workspaceId: string,
  stateHash: string
): Promise<WorkspaceDeclarations> {
  const snapshot = snapshotFromState(vcs, workspaceId, stateHash);
  return (snapshot.declarations ??= snapshot.config.then((config) =>
    freezeDeclarations(buildWorkspaceDeclarations(config))
  ));
}
