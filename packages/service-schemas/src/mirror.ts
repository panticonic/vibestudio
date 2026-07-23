/**
 * `mirror` service — the read-side of the context projector, over the wire
 * (plan §6.5, breaking change §9.11). It lets a remote CLI materialize a
 * context's repos into a local snapshot: `targets` returns repository
 * projections of one exact workspace state, and `objects` streams the CAS tree
 * content for a state in size-bounded pages.
 *
 * It holds no write or merge semantics. A mirror is a pure projection read,
 * never a second working tree whose filesystem changes are reconstructed into
 * semantic edits.
 */

import { z } from "zod";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import type { ServiceAuthorityPolicy } from "@vibestudio/shared/serviceAuthority";

/** shell + agent are the remote-mirror drivers; `do` keeps the agent⊆do
 *  invariant; server/panel for host-side tooling and tests. */
export const MIRROR_POLICY: ServiceAuthorityPolicy = {
  principals: ["user", "code", "host"],
};

export const mirrorTargetSchema = z
  .object({
    repoPath: z.string(),
    stateHash: z.string(),
  })
  .strict();
export type MirrorTarget = z.infer<typeof mirrorTargetSchema>;

export const mirrorTargetsArgsSchema = z.object({ contextId: z.string() }).strict();

/** One file in a streamed CAS page: content is base64 (binary-safe). */
export const mirrorFileSchema = z
  .object({
    path: z.string(),
    /** Git-style file mode (33188 regular, 33261 executable). */
    mode: z.number().int(),
    /** File bytes, base64-encoded. */
    content: z.string(),
    /** Raw byte length (pre-base64). */
    size: z.number().int().nonnegative(),
  })
  .strict();
export type MirrorFile = z.infer<typeof mirrorFileSchema>;

export const mirrorObjectsArgsSchema = z
  .object({
    stateHash: z.string(),
    /** Restrict to these repo-relative paths (default: the whole tree). */
    paths: z.array(z.string()).optional(),
    /** Opaque continuation cursor from a previous page's `next`. */
    cursor: z.string().optional(),
  })
  .strict();

export const mirrorObjectsResultSchema = z
  .object({
    files: z.array(mirrorFileSchema),
    /** Present when more files remain; pass back as `cursor` for the next page. */
    next: z.string().optional(),
  })
  .strict();
export type MirrorObjectsResult = z.infer<typeof mirrorObjectsResultSchema>;

export const mirrorMethods = defineServiceMethods({
  targets: {
    args: z.tuple([mirrorTargetsArgsSchema]),
    returns: z.array(mirrorTargetSchema),
    description:
      "Return repository content projections for a context's exact working head. Each {repoPath,stateHash} is a content-only projector target, never ancestry or a semantic revision. Stream its immutable tree through `objects`.",
    authority: MIRROR_POLICY,
    access: { sensitivity: "read" },
  },
  objects: {
    args: z.tuple([mirrorObjectsArgsSchema]),
    returns: mirrorObjectsResultSchema,
    description:
      "Stream one content-only repository tree as bounded pages of {path,mode,content,size}. Agent callers may read only states currently reachable from their host-bound context; no prior `targets` call is required. A stateHash never grants workspace history or provenance. Page with `next` until absent and optionally restrict to paths.",
    authority: MIRROR_POLICY,
    access: { sensitivity: "read" },
  },
});
