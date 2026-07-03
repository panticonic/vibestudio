/**
 * refs service method schemas — the server-owned protected MAIN-ref table
 * (`repoPath → main state`), exposed to userland.
 *
 * The host tracks exactly one canonical `main` state per repo path. There is no
 * generic `(repo, ref)` namespace and no public arbitrary-tree `advanceRef`
 * (deleted in the narrow-host-vcs P1 — see docs/narrow-host-vcs-plan.md §2.1):
 * the only write is `updateMains`, an atomic group compare-and-swap restricted
 * to the single VCS writer (the gad-store DO backing the workspace `vcs`
 * service declaration). Reads (`readMain`/`listMains`/`readMainLog`) are plain
 * lookups available to any caller who can hold source.
 */

import { z } from "zod";
import type { ServicePolicy, MethodAccessDescriptor } from "../servicePolicy.js";
import { defineServiceMethods } from "../typedServiceClient.js";
import { TREE_REF_RE } from "./blobstore.js";

/** Everyone who can hold source can READ mains; the WRITE (`updateMains`) is
 *  additionally restricted to the single VCS-DO writer by target identity in
 *  the service handler (§3), not by caller kind. Reads mirror
 *  BLOBSTORE_READ_POLICY. */
export const REFS_POLICY: ServicePolicy = {
  allowed: ["panel", "app", "worker", "do", "shell", "server", "extension"],
};

const READ_ACCESS: MethodAccessDescriptor = { sensitivity: "read" };
const WRITE_ACCESS: MethodAccessDescriptor = { sensitivity: "write" };

/** A ref value: `state:<hex64>` root pointer or `manifest:<hex64>` tree node. */
export const RefValueSchema = z.string().regex(TREE_REF_RE);

/** Current record of one repo's protected `main`. */
export const MainRefRecordSchema = z.object({
  repoPath: z.string(),
  stateHash: RefValueSchema,
  updatedAt: z.number(),
  seq: z.number().int(),
});
export type MainRefRecord = z.infer<typeof MainRefRecordSchema>;

/** How a batch of main movements is framed (approval copy + log). A `delete`
 *  batch removes mains (`next: null`); `restore` re-creates a previously
 *  deleted repo's main (`expectedOld: null` on a repo whose host ref log shows
 *  a prior delete). */
export const MAIN_UPDATE_OPERATIONS = [
  "push",
  "merge",
  "import",
  "delete",
  "restore",
] as const;
export const MainUpdateOperationSchema = z.enum(MAIN_UPDATE_OPERATIONS);
export type MainUpdateOperation = z.infer<typeof MainUpdateOperationSchema>;

/**
 * One entry in the per-repoPath main-movement log. `new` is NULLABLE: a delete
 * records `new: null` and a subsequent re-creation records `old: null` — which
 * is exactly what the gate's log-derived restore classification reads (§5).
 * `writer` is the DO/principal that performed the CAS; `onBehalfOf` is the
 * host-resolved originating principal (from the invocation-token table, §4)
 * when the write was dispatched on behalf of an upstream caller.
 */
export const MainRefLogEntrySchema = z.object({
  repoPath: z.string(),
  seq: z.number().int(),
  old: RefValueSchema.nullable(),
  new: RefValueSchema.nullable(),
  writer: z.string(),
  onBehalfOf: z.string().nullable().optional(),
  reason: z.string(),
  operation: MainUpdateOperationSchema,
  timestamp: z.number(),
});
export type MainRefLogEntry = z.infer<typeof MainRefLogEntrySchema>;

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
  /** Human-readable reason recorded in every touched repo's main log. */
  reason: z.string().max(2000).optional(),
  operation: MainUpdateOperationSchema,
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
      /** null = the main was deleted. */
      stateHash: RefValueSchema.nullable(),
      seq: z.number().int(),
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
  readMainLog: {
    description:
      "Chronological (oldest→newest) movement log for one repo's `main`; `limit` keeps the newest N " +
      "entries. `new` is null for a delete entry (`old` is null for a re-creation).",
    args: z.tuple([
      z.object({
        repoPath: z.string().min(1),
        limit: z.number().int().positive().optional(),
      }),
    ]),
    returns: z.array(MainRefLogEntrySchema),
    policy: REFS_POLICY,
    access: READ_ACCESS,
  },
  updateMains: {
    description:
      "Atomic group compare-and-swap over protected `main` refs. Every entry validates " +
      "(`expectedOld` matches current, null = must-not-exist) under one critical section; the batch " +
      "persists in ONE atomic file replace. `next: null` deletes a main. Any per-entry conflict fails " +
      "the whole batch with structured per-entry data. Approval-gated and restricted to the single " +
      "VCS-DO writer (§3): every other caller gets a structured policy rejection.",
    args: z.tuple([updateMainsInputSchema]),
    returns: UpdateMainsResultSchema,
    policy: REFS_POLICY,
    access: WRITE_ACCESS,
  },
});
