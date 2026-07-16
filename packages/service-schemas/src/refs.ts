/**
 * refs service method schemas — the server-owned protected MAIN-ref table
 * (`repoPath → main state`), exposed to userland.
 *
 * The host tracks exactly one canonical `main` state per repo path. There is no
 * generic `(repo, ref)` namespace and no public arbitrary-tree `advanceRef`
 * (deleted in the narrow-host-vcs P1 — see docs/narrow-host-vcs-plan.md §2.1):
 * the only write is `updateMains`, an atomic group compare-and-swap restricted
 * to the single VCS writer (the gad-store DO backing the workspace `vcs`
 * service declaration). The CAS itself is semantics-free, but every movement it
 * commits is captured in the host-owned **main-ref log** (`operation`, resolved
 * `writer`/`onBehalfOf`, `reason`, `old`→`new`, monotonic `seq`) — the §2
 * host-verified provenance signal read back through `listMainRefLog`. Reads
 * (`readMain`/`listMains`/`listMainRefLog`) are plain lookups available to any
 * caller who can hold source.
 */

import { z } from "zod";
import type { ServiceAuthorityPolicy, MethodAccessDescriptor } from "@vibestudio/shared/serviceAuthority";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import { requirementForPrincipals } from "@vibestudio/shared/authorization";
import { TREE_REF_RE } from "./blobstore.js";

/** Everyone who can hold source can READ mains. The WRITE (`updateMains`) has a
 *  static DO-only caller-kind policy, then the service handler narrows that to
 *  the single VCS-DO writer by target identity (§3). Reads mirror
 *  BLOBSTORE_READ_POLICY. */
export const REFS_POLICY: ServiceAuthorityPolicy = {
  principals: ["code", "user", "host"],
};
const READ_ACCESS: MethodAccessDescriptor = { sensitivity: "read" };
const WRITE_ACCESS: MethodAccessDescriptor = { sensitivity: "write" };
const UPDATE_MAINS_CAPABILITY = "service:refs.updateMains";

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

/** The VCS operation a main movement represents — recorded verbatim in the
 *  host main-ref log so render paths can label a main advance (§2/§4.1). */
export const MainRefOperationSchema = z.enum(["push", "import", "delete", "restore", "seed"]);
export type MainRefOperation = z.infer<typeof MainRefOperationSchema>;

export const updateMainsInputSchema = z.object({
  entries: z.array(MainUpdateEntrySchema).min(1),
  /** The VCS operation this batch performs, logged as movement provenance. */
  operation: MainRefOperationSchema,
  /** Free-text movement reason (e.g. a push message), logged for the audit
   *  trail. Never a semantic input to the CAS. */
  reason: z.string().optional(),
  /**
   * On-behalf-of correlation nonce (§4). NOT a credential: an opaque handle the
   * host resolves against its own invocation table to attribute this write to
   * the originating principal. Absent = attribute to the calling DO itself.
   */
  invocationToken: z.string().optional(),
});

export const UpdateMainsResultSchema = z.object({
  updated: z.array(
    z.object({
      repoPath: z.string(),
      /** null = the main was removed. */
      stateHash: RefValueSchema.nullable(),
      /** The main-ref log id assigned to this movement (the log row's monotonic
       *  `seq`); equals the current max seq for a no-op removal that moved
       *  nothing. */
      seq: z.number(),
    })
  ),
});
export type UpdateMainsResult = z.infer<typeof UpdateMainsResultSchema>;

/** One row of the host main-ref movement log (§2): a single main advance with
 *  host-verified attribution. `writer` is the single VCS writer DO; `onBehalfOf`
 *  is the token-resolved originating principal (absent token = the DO itself). */
export const MainRefLogRowSchema = z.object({
  /** Monotonic global id (the movement's `seq`). */
  id: z.number(),
  repoPath: z.string(),
  /** Always `main` today — the host tracks one protected ref per repo. */
  ref: z.string(),
  operation: z.string(),
  /** The ref value before the movement; null when it was created. */
  old: RefValueSchema.nullable(),
  /** The ref value after the movement; null when it was removed. */
  new: RefValueSchema.nullable(),
  /** The single VCS writer DO identity, or null for host-internal seeding. */
  writer: z.string().nullable(),
  /** The token-resolved originating principal (VerifiedCaller), or null. */
  onBehalfOf: z.unknown().nullable(),
  reason: z.string().nullable(),
  /** Movement timestamp (ms since epoch). */
  createdAt: z.number(),
});
export type MainRefLogRow = z.infer<typeof MainRefLogRowSchema>;

export const listMainRefLogInputSchema = z.object({
  repoPath: z.string().min(1),
  /** Return only movements with id greater than this cursor; omit for the full
   *  log. */
  sinceId: z.number().optional(),
});

export const refsMethods = defineServiceMethods({
  readMain: {
    description:
      "Current record of one repo's protected `main` (repoPath → state), or null when absent.",
    args: z.tuple([z.string().min(1)]),
    returns: MainRefRecordSchema.nullable(),
    authority: REFS_POLICY,
    access: READ_ACCESS,
    examples: [{ args: ["packages/notes"], returns: null }],
  },
  listMains: {
    description: "Every repo's protected `main`, sorted by repoPath.",
    args: z.tuple([]),
    returns: z.array(MainRefRecordSchema),
    authority: REFS_POLICY,
    access: READ_ACCESS,
  },
  listMainRefLog: {
    description:
      "The host main-ref movement log for a repo (§2): every `main` advance with its operation, " +
      "host-verified writer/on-behalf-of attribution, reason, and old→new values, oldest first. " +
      "`sinceId` pages movements after a known id (omit for the full log). The render paths read " +
      "main-advance provenance from here; the DO's stale-intent discard consults it (§6).",
    args: z.tuple([listMainRefLogInputSchema]),
    returns: z.array(MainRefLogRowSchema),
    authority: REFS_POLICY,
    access: READ_ACCESS,
    examples: [{ args: [{ repoPath: "packages/notes" }], returns: [] }],
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
    authority: {
      requirement: requirementForPrincipals(["code"], UPDATE_MAINS_CAPABILITY),
      resource: { kind: "literal", key: UPDATE_MAINS_CAPABILITY },
      prepared: {
        resolver: "refs.updateMains.writer",
        leaves: [
          {
            capability: UPDATE_MAINS_CAPABILITY,
            requirement: { kind: "selected", principals: ["code"] },
            evalAcquisition: {
              kind: "closed",
              reason: "protected main refs are writable only by the exact workspace VCS writer",
            },
          },
        ],
      },
    },
    access: WRITE_ACCESS,
  },
});
