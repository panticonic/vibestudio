/**
 * Wire schema for the agent-facing "docs" capability-catalog service.
 *
 * The catalog exposes the implemented automatically documented surfaces:
 * `service` (server RPC) and `runtime` (userland runtime surface).
 *
 * `docs` replaces `meta` as the agent entry point: it derives entries from the
 * dispatcher's live service definitions, filters them to what the caller may
 * invoke, and surfaces the literate doc/access metadata that lives with each
 * method. Schemas/access here are carried loosely on the wire (the typed home
 * is MethodSchema/MethodAccessDescriptor); the catalog is a derived view.
 */

import { z } from "zod";
import { defineServiceMethods } from "../typedServiceClient.js";

export const catalogSurfaceSchema = z.enum(["service", "runtime"]);
export type CatalogSurface = z.infer<typeof catalogSurfaceSchema>;

/** Serialized access descriptor (loose; typed home is MethodAccessDescriptor). */
const catalogAccessSchema = z.record(z.unknown());

/** One catalog entry. A `service` parent + one child per method, plus `runtime` exports. */
export const catalogEntrySchema = z.object({
  /** `${surface}:${qualifiedName}` — stable id used by describe/getSchema. */
  id: z.string(),
  surface: catalogSurfaceSchema,
  qualifiedName: z.string(),
  /** Parent entry id (e.g. a method's owning service), when applicable. */
  parent: z.string().optional(),
  title: z.string(),
  description: z.string().optional(),
  /** Access/restrictedness (callers, restrictedTo, sensitivity, approval, …). */
  access: catalogAccessSchema.optional(),
  argsSchema: z.record(z.unknown()).optional(),
  returnsSchema: z.record(z.unknown()).optional(),
  /** Namespace member names (runtime surface entries). */
  members: z.array(z.string()).optional(),
  examples: z.array(z.unknown()).optional(),
});
export type CatalogEntry = z.infer<typeof catalogEntrySchema>;

/** Compact search hit — no schemas, to keep result sets cheap in context. */
export const catalogHitSchema = z.object({
  id: z.string(),
  surface: catalogSurfaceSchema,
  qualifiedName: z.string(),
  title: z.string(),
  description: z.string().optional(),
});
export type CatalogHit = z.infer<typeof catalogHitSchema>;

const searchOptsSchema = z
  .object({
    surface: catalogSurfaceSchema.optional(),
    limit: z.number().int().positive().max(100).optional(),
  })
  .optional();

const READONLY_ACCESS = {
  sensitivity: "read" as const,
};

// ── Serialized service-definition shapes (absorbed from the retired `meta`
// service): the per-service view used by docs.listServices / docs.describeService
// and by eval's help() + the CLI `services` command. ──
const serializedPolicySchema = z.object({
  allowed: z.array(z.string()),
  description: z.string().optional(),
});

export const serializedServiceMethodSchema = z.object({
  description: z.string().optional(),
  policy: serializedPolicySchema.optional(),
  access: z.record(z.unknown()).optional(),
  examples: z.array(z.unknown()).optional(),
  errors: z.array(z.unknown()).optional(),
  seeAlso: z.array(z.string()).optional(),
  argsSchema: z.record(z.unknown()),
  returnsSchema: z.record(z.unknown()).optional(),
});

export const serializedServiceSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  policy: serializedPolicySchema,
  methods: z.record(serializedServiceMethodSchema),
});
export type SerializedServiceDefinition = z.infer<typeof serializedServiceSchema>;

export const docsMethods = defineServiceMethods({
  search: {
    description:
      "Search the capability catalog (services and runtime APIs) by keyword. Results are filtered to what the calling kind may invoke. Use docs.describe(id) for the full typed schema, access rules, and examples.",
    args: z.tuple([z.string(), searchOptsSchema]),
    returns: z.array(catalogHitSchema),
    access: READONLY_ACCESS,
    examples: [{ args: ["store a blob and get a digest", { limit: 5 }] }],
  },
  describe: {
    description:
      "Return the full catalog entry for an id (typed args/returns schema, access/restrictedness, examples). Returns null if unknown or not visible to the caller.",
    args: z.tuple([z.string()]),
    returns: catalogEntrySchema.nullable(),
    access: READONLY_ACCESS,
    examples: [{ args: ["service:blobstore.putText"] }],
  },
  getSchema: {
    description: "Return just the args/returns JSON Schema for a catalog id.",
    args: z.tuple([z.string()]),
    returns: z
      .object({
        argsSchema: z.record(z.unknown()).optional(),
        returnsSchema: z.record(z.unknown()).optional(),
      })
      .nullable(),
    access: READONLY_ACCESS,
  },
  listSurfaces: {
    description: "List catalog surfaces and the number of entries the caller can see in each.",
    args: z.tuple([]),
    returns: z.array(z.object({ surface: catalogSurfaceSchema, count: z.number() })),
    access: READONLY_ACCESS,
  },
  listServices: {
    description:
      "List registered RPC services and their methods (per-service view with JSON-Schema args/returns), filtered to what the calling kind may invoke. Every service.method listed is callable as services.<service>.<method>(...).",
    args: z.tuple([]),
    returns: z.array(serializedServiceSchema),
    access: READONLY_ACCESS,
  },
  describeService: {
    description:
      "Describe one registered RPC service by name: its policy and every method the caller may invoke (with JSON-Schema args/returns). Returns null for an unknown service.",
    args: z.tuple([z.string()]),
    returns: serializedServiceSchema.nullable(),
    access: READONLY_ACCESS,
    examples: [{ args: ["blobstore"] }],
  },
});
