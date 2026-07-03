/**
 * worktree service method schemas — the host's disk-scan PRIMITIVE.
 *
 * A single pure, semantics-free operation: read a (repoPath, head) working tree
 * into the content store (the CAS) and return its content-addressed
 * `{ stateHash, files }`. No commit, no ref advance, no gad-log append, no DO
 * round trip — it is the disk-side twin of the `blobstore`/`refs` primitives the
 * gad-store DO drives to hold ALL the VCS semantics itself. The DO calls this to
 * capture external disk drift; nothing here knows what a commit or a merge is.
 */

import { z } from "zod";
import type { ServicePolicy, MethodAccessDescriptor } from "../servicePolicy.js";
import { defineServiceMethods } from "../typedServiceClient.js";
import { DigestSchema, StateHashSchema } from "./blobstore.js";

/** Only the workspace VCS store DO drives the scan primitive (plus server/shell
 *  for host-side tests). Not a broadly readable surface. */
export const WORKTREE_POLICY: ServicePolicy = { allowed: ["do", "shell", "server"] };

const WRITE_ACCESS: MethodAccessDescriptor = { sensitivity: "write" };

/** Git-style file mode: 33188 regular, 33261 executable. */
export const WorktreeFileModeSchema = z.union([z.literal(33188), z.literal(33261)]);

/** One scanned file — the exact `localState` file shape (path + content address
 *  + size + mode). Size rides along because the DO's scan-adopt diffing uses it. */
export const ScannedFileSchema = z.object({
  path: z.string(),
  contentHash: DigestSchema,
  size: z.number().int().nonnegative(),
  mode: WorktreeFileModeSchema,
});

export const ScanResultSchema = z.object({
  stateHash: StateHashSchema,
  files: z.array(ScannedFileSchema),
});

export const worktreeMethods = defineServiceMethods({
  scan: {
    description:
      "Scan a working tree into the content store and return its content-addressed state. Resolves the (repoPath, head) directory, hashes+mirrors every file into the CAS (refreshing the .gad sidecar), and returns { stateHash, files }. A pure disk→CAS primitive: no commit, no ref advance, no history — the caller (the gad-store DO) owns all VCS semantics.",
    args: z.tuple([z.string(), z.string()]),
    returns: ScanResultSchema,
    policy: WORKTREE_POLICY,
    access: WRITE_ACCESS,
  },
});
