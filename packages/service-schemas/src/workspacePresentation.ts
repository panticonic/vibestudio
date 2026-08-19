import { z } from "zod";
import { defineReceiverServiceMethods } from "@vibestudio/shared/typedServiceClient";
import type { ServiceAuthorityPolicy } from "@vibestudio/shared/serviceAuthority";

const productPolicy: ServiceAuthorityPolicy = { principals: ["host", "user", "code"] };
const method = (sensitivity: "read" | "write") => ({
  authority: productPolicy,
  access: { sensitivity },
  directEffect: { kind: "open" as const },
  tier: {
    tier: "open" as const,
    session: "family" as const,
    residency: "transport" as const,
    family: "workspace-presentation.current",
    rationale: "Current-generation workspace presentation data owned by Base.",
  },
});

const indexablePanelSchema = z
  .object({
    id: z.string().min(1),
    source: z.string().min(1),
    title: z.string(),
    path: z.string().optional(),
    manifestDescription: z.string().optional(),
    manifestDependencies: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
    keywords: z.array(z.string()).optional(),
  })
  .strict();

const searchResultSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    relevance: z.number(),
    accessCount: z.number().int().nonnegative(),
    matchContext: z.string().optional(),
  })
  .strict();

export const workspacePresentationMethods = defineReceiverServiceMethods({
  bindSlot: {
    ...method("write"),
    description:
      "Bind a shell slot to the presented panel and entity, recording the display " +
      "title the binder already knows so the tree never has to present a slot id.",
    args: z.tuple([
      z.string().min(1),
      z.string().min(1),
      z.string().min(1),
      z.string().nullable().optional(),
    ]),
    argumentNames: ["slotId", "entityId", "source", "title"],
    returns: z.void(),
  },
  removeSlots: {
    ...method("write"),
    description: "Remove presentation bindings for closed shell slots.",
    args: z.tuple([z.array(z.string().min(1)).max(1_000)]),
    argumentNames: ["slotIds"],
    returns: z.void(),
  },
  indexPanel: {
    ...method("write"),
    description: "Index a panel manifest for workspace search.",
    args: z.tuple([
      indexablePanelSchema,
      z.string().min(1).nullable(),
      z.object({ explicit: z.boolean().optional() }).strict().optional(),
    ]),
    argumentNames: ["panel", "entityId", "options"],
    returns: z.string().min(1).nullable(),
  },
  updatePanelTitle: {
    ...method("write"),
    description: "Update a panel title and its search index entry.",
    args: z.tuple([
      z.string().min(1),
      z.string().min(1),
      z.string(),
      z.object({ explicit: z.boolean().optional() }).strict().optional(),
    ]),
    argumentNames: ["slotId", "entityId", "title", "options"],
    returns: z.string().min(1),
  },
  setEntityTitle: {
    ...method("write"),
    description: "Set or clear the title associated with an entity.",
    args: z.tuple([
      z.string().min(1),
      z.string().nullable(),
      z.object({ explicit: z.boolean().optional() }).strict().optional(),
    ]),
    argumentNames: ["entityId", "title", "options"],
    returns: z.void(),
  },
  listEntityTitles: {
    ...method("read"),
    description: "List the workspace's explicit entity titles.",
    args: z.tuple([]),
    argumentNames: [],
    returns: z.array(
      z.object({ id: z.string(), title: z.string(), explicit: z.boolean() }).strict()
    ),
  },
  isEntityTitleExplicit: {
    ...method("read"),
    description: "Whether an entity title was explicitly selected by its owning runtime.",
    args: z.tuple([z.string().min(1)]),
    argumentNames: ["entityId"],
    returns: z.boolean(),
  },
  titlesForSlots: {
    ...method("read"),
    description: "Resolve presented titles for shell slots.",
    args: z.tuple([z.array(z.string().min(1)).max(1_000)]),
    argumentNames: ["slotIds"],
    returns: z.record(z.string(), z.string()),
  },
  incrementAccess: {
    ...method("write"),
    description: "Record access to a presented panel.",
    args: z.tuple([z.string().min(1)]),
    argumentNames: ["slotId"],
    returns: z.void(),
  },
  sourceUsage: {
    ...method("read"),
    description: "Summarize recent panel usage by source.",
    args: z.tuple([z.number().int().positive().max(200).optional()]),
    argumentNames: ["limit"],
    returns: z.array(
      z
        .object({
          source: z.string(),
          accessCount: z.number().int().nonnegative(),
          lastAccessedAt: z.number().int().nonnegative(),
        })
        .strict()
    ),
  },
  search: {
    ...method("read"),
    description: "Search indexed workspace panels.",
    args: z.tuple([
      z.string(),
      z.number().int().positive().max(200).optional(),
      z.string().optional(),
    ]),
    argumentNames: ["query", "limit", "cursor"],
    returns: z
      .object({ results: z.array(searchResultSchema), nextCursor: z.string().nullable() })
      .strict(),
  },
  rebuildIndex: {
    ...method("write"),
    description: "Rebuild the workspace panel search index.",
    args: z.tuple([]),
    argumentNames: [],
    returns: z.void(),
  },
});
