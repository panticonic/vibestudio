/**
 * refs service method schemas — the server-owned protected MAIN-ref table
 * (`repoPath → main state`), exposed to userland.
 *
 * The host tracks exactly one canonical `main` state per repo path. There is no
 * generic `(repo, ref)` namespace and no public arbitrary-tree `advanceRef`
 * (deleted in the narrow-host-vcs P1 — see docs/narrow-host-vcs-plan.md §2.1):
 * the only write is `updateMains`, a semantics-free atomic group
 * compare-and-swap restricted to the single VCS writer (the gad-store DO
 * backing the workspace `vcs` service declaration). It carries NO VCS-operation
 * label, reason, or movement log — provenance lives in the DO
 * (narrow-host-boundary-refactor Phase 5). Reads (`readMain`/`listMains`) are
 * plain lookups available to any caller who can hold source.
 */

import { z } from "zod";
import type { ServicePolicy, MethodAccessDescriptor } from "../servicePolicy.js";
import { defineServiceMethods } from "../typedServiceClient.js";
import { TREE_REF_RE } from "./blobstore.js";

/** Everyone who can hold source can READ mains. The WRITE (`updateMains`) has a
 *  static DO-only caller-kind policy, then the service handler narrows that to
 *  the single VCS-DO writer by target identity (§3). Reads mirror
 *  BLOBSTORE_READ_POLICY. */
export const REFS_POLICY: ServicePolicy = {
  allowed: ["panel", "app", "worker", "do", "shell", "server", "extension"],
};
const UPDATE_MAINS_POLICY: ServicePolicy = { allowed: ["do"] };

const READ_ACCESS: MethodAccessDescriptor = { sensitivity: "read" };
const WRITE_ACCESS: MethodAccessDescriptor = { sensitivity: "write" };

/** A ref value: `state:<hex64>` root pointer or `manifest:<hex64>` tree node. */
export const RefValueSchema = z.string().regex(TREE_REF_RE);

/** Current record of one repo's protected `main`. */
export const MainRefRecordSchema = z.object({
  repoPath: z.string(),
  stateHash: RefValueSchema,
  updatedAt: z.number(),
});
export type MainRefRecord = z.infer<typeof MainRefRecordSchema>;

/** One repo's requested main movement. `next: null` deletes the main. */
export const MainUpdateEntrySchema = z.object({
  repoPath: z.string().min(1),
  /** Value the caller believes the main currently has; null = must-not-exist. */
  expectedOld: RefValueSchema.nullable(),
  /** The new main state, or null to delete the main. */
  next: RefValueSchema.nullable(),
});
export type MainUpdateEntry = z.infer<typeof MainUpdateEntrySchema>;

export const updateMainsInputSchema = z.object({
  entries: z.array(MainUpdateEntrySchema).min(1),
  /**
   * On-behalf-of correlation nonce (§4). NOT a credential: an opaque handle the
   * host resolves against its own invocation table to attribute this write to
   * the originating principal. Absent = attribute to the calling DO itself.
   */
  invocationToken: z.string().optional(),
});
export type UpdateMainsRpcInput = z.infer<typeof updateMainsInputSchema>;

export const UpdateMainsResultSchema = z.object({
  updated: z.array(
    z.object({
      repoPath: z.string(),
      /** null = the main was removed. */
      stateHash: RefValueSchema.nullable(),
    })
  ),
});
export type UpdateMainsResult = z.infer<typeof UpdateMainsResultSchema>;

export const refsMethods = defineServiceMethods({
  readMain: {
    description:
      "Current record of one repo's protected `main` (repoPath → state), or null when absent.",
    args: z.tuple([z.string().min(1)]),
    returns: MainRefRecordSchema.nullable(),
    policy: REFS_POLICY,
    access: READ_ACCESS,
    examples: [{ args: ["docs/notes"], returns: null }],
  },
  listMains: {
    description: "Every repo's protected `main`, sorted by repoPath.",
    args: z.tuple([]),
    returns: z.array(MainRefRecordSchema),
    policy: REFS_POLICY,
    access: READ_ACCESS,
  },
  updateMains: {
    description:
      "Semantics-free atomic group compare-and-swap over protected `main` refs. Every entry validates " +
      "(`expectedOld` matches current, null = must-not-exist) under one critical section; the batch " +
      "persists in ONE atomic file replace. `next: null` removes a main. Any per-entry conflict fails " +
      "the whole batch with structured per-entry data. Host-approval-gated (the host computes the " +
      "content diff itself, D3) and restricted to the single VCS-DO writer (§3): every other caller " +
      "gets a structured policy rejection.",
    args: z.tuple([updateMainsInputSchema]),
    returns: UpdateMainsResultSchema,
    policy: UPDATE_MAINS_POLICY,
    access: WRITE_ACCESS,
  },
});
