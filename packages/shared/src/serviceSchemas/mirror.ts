/**
 * `mirror` service — the read-side of the context projector, over the wire
 * (plan §6.5, breaking change §9.11). It lets a remote CLI materialize a
 * context's repos into a local working tree it can drive with `vibestudio
 * fs/vcs`: `targets` returns the per-repo content-addressed states, and
 * `objects` streams the CAS tree content for a state in size-bounded pages.
 *
 * It holds NO write/merge semantics — inbound updates and local edit writeback
 * ride the existing `vcs.edit`/context substrate. This is a pure projection
 * read, a sibling of `worktree.scan` on the fetch side.
 */

import { z } from "zod";
import { defineServiceMethods } from "../typedServiceClient.js";
import type { ServicePolicy } from "../servicePolicy.js";

/** shell + agent are the remote-mirror drivers; `do` keeps the agent⊆do
 *  invariant; server/panel for host-side tooling and tests. */
export const MIRROR_POLICY: ServicePolicy = {
  allowed: ["shell", "agent", "do", "server", "panel"],
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
      "The per-repo { repoPath, stateHash } targets a context resolves to (read-side of the projector). Fetch these, then stream each state's tree via `objects`.",
    policy: MIRROR_POLICY,
    access: { sensitivity: "read" },
  },
  objects: {
    args: z.tuple([mirrorObjectsArgsSchema]),
    returns: mirrorObjectsResultSchema,
    description:
      "Stream the content-addressed tree for a `stateHash` as size-bounded pages of { path, mode, content (base64), size }. Page with the returned `next` cursor until absent; optionally restrict to `paths`.",
    policy: MIRROR_POLICY,
    access: { sensitivity: "read" },
  },
});
