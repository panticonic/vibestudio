import { z } from "zod";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import type { ServiceAuthorityPolicy } from "@vibestudio/shared/serviceAuthority";

/**
 * The retired SQLite workspace store (`WorkspaceDO`) as the import reads it, and
 * the import's own methods on `WorkspaceStateDO` (`workspaceStateEngine.ts`
 * adds them there). docs/dolt-redesign.md §9.2; the design is in
 * `packages/builtin/src/workspace-state/legacyImport.ts`.
 */
const hostOnly: ServiceAuthorityPolicy = { principals: ["host"] };
export const legacyInternal = (sensitivity: "read" | "write" | "destructive") => ({
  capability: "workspace.runtime-state.manage",
  authority: hostOnly,
  website: {
    kind: "closed",
    reason: "Storage import entry points are internal implementation authority.",
  } as const,
  tier: {
    tier: "gated" as const,
    session: "family" as const,
    rationale: "Host-only control of authority-bearing product-builtin workspace state.",
  },
  access: { sensitivity },
});

export const LegacyImportTableSchema = z.enum([
  "entities",
  "runtime_resource_bindings",
  "slots",
  "slot_history",
  "context_edges",
  "workspace_meta",
  "panel_close_cleanup",
  "lifecycle_epochs",
  "lifecycle_leases",
  "lifecycle_ops",
  "do_alarms",
  "do_alarm_test_policies",
  "durable_work_owners",
  "state",
]);

export const LegacyRowSchema = z.record(z.string(), z.union([z.string(), z.number(), z.null()]));

export const LegacyManifestSchema = z
  .object({
    present: z.boolean(),
    schemaVersion: z.number().int().nullable(),
    tables: z.array(
      z
        .object({
          name: LegacyImportTableSchema,
          rows: z.number().int().nonnegative(),
          digest: z.string().regex(/^[0-9a-f]{64}$/u),
        })
        .strict()
    ),
    digest: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .strict();

const rawWorkspaceStateLegacyMethods = defineServiceMethods({
  legacyManifest: {
    ...legacyInternal("read"),
    description: "What the retired SQLite workspace store holds: per table a row count and digest.",
    args: z.tuple([]),
    returns: LegacyManifestSchema,
  },
  legacyReadRows: {
    ...legacyInternal("read"),
    description: "Read a page of one retired-store table in rowid order.",
    args: z.tuple([
      z
        .object({
          table: LegacyImportTableSchema,
          afterRowid: z.number().int().nonnegative(),
          limit: z.number().int().positive().max(500),
        })
        .strict(),
    ]),
    returns: z
      .object({
        rows: z.array(z.object({ rowid: z.number().int(), row: LegacyRowSchema }).strict()),
        done: z.boolean(),
      })
      .strict(),
  },
});

export const workspaceStateLegacyMethods = rawWorkspaceStateLegacyMethods;
