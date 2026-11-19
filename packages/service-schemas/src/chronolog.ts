import { z } from "zod";
import { requirementForPrincipals } from "@vibestudio/shared/authorization";
import { StreamResponseSchema } from "@vibestudio/shared/streamResponse";
import {
  defineServiceMethods,
  fixedPreparedAuthorityRequirement,
} from "@vibestudio/shared/typedServiceClient";

export const CHRONOLOG_PRINCIPALS = ["user", "code"] as const;
export const CHRONOLOG_TRANSACTION_RESOLVER = "chronolog.transact.program";
export const ChronologDigestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const sequence = z.number().int().nonnegative().safe();
const canonicalProgram = z
  .string()
  .max(529_000)
  .regex(/^(?:[0-9a-f]{2})+$/u);
const operationId = z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/u);
const group = ChronologDigestSchema;

const point = z
  .object({ generation: ChronologDigestSchema, sequence, root: ChronologDigestSchema })
  .strict();
export const ChronologRevisionSchema = z
  .object({
    applicationId: group,
    historyId: z.string().min(1).max(128),
    generation: ChronologDigestSchema,
    point,
    controlRevision: sequence,
    materializationRevision: z.string().regex(/^[0-9]+$/u),
  })
  .strict();

const value = z.union([
  z.string(),
  z.number().finite(),
  z.bigint(),
  z.instanceof(Uint8Array),
  z.null(),
]);
const groupQuery = z
  .object({
    group,
    sql: z.string().min(1).max(262_144),
    bindings: z.array(value).max(1_000).optional(),
  })
  .strict();
const queryResult = z
  .object({
    revision: ChronologRevisionSchema,
    columns: z.array(z.object({ name: z.string(), declaredType: z.string().optional() }).strict()),
    rows: z.array(z.array(value)),
  })
  .strict();

const readCapability = "chronolog.read";
const writeCapability = "chronolog.write";
const readRequirement = requirementForPrincipals(CHRONOLOG_PRINCIPALS, readCapability);
const writeRequirement = requirementForPrincipals(CHRONOLOG_PRINCIPALS, writeCapability);
const groupResource = { kind: "argument", index: 0, path: ["group"] } as const;
const website = {
  kind: "closed",
  reason: "Chronolog groups require a verified workspace account.",
} as const;
const readAuthority = {
  website,
  capability: readCapability,
  authority: { requirement: readRequirement, resource: groupResource },
  tier: {
    tier: "gated" as const,
    session: "family" as const,
    rationale: "Group reads use the authenticated account and a group-scoped grant.",
  },
  access: { sensitivity: "read" as const },
};

export const chronologMethods = defineServiceMethods({
  transact: {
    website,
    capability: writeCapability,
    authority: {
      requirement: writeRequirement,
      resource: groupResource,
      prepared: {
        resolver: CHRONOLOG_TRANSACTION_RESOLVER,
        leaves: [
          {
            capability: writeCapability,
            requirement: fixedPreparedAuthorityRequirement(writeRequirement),
            tier: "gated",
          },
        ],
      },
    },
    tier: {
      tier: "open",
      session: "family",
      rationale: "The prepared program selects the exact group and approved contents.",
    },
    description: "Submit one canonical change program signed by the initiating account.",
    presentation: {
      title: "Write to a Chronolog group",
      action: "write to a Chronolog group",
      description: "Review one signed transaction for a specific group.",
      group: "sharing",
      authorityCategory: { domain: "sharing", verb: "act" },
    },
    args: z.tuple([
      z
        .object({
          group,
          operationId,
          program: canonicalProgram,
          basedOn: ChronologRevisionSchema.optional(),
        })
        .strict(),
    ]),
    returns: z.object({ txId: ChronologDigestSchema }).strict(),
    access: { sensitivity: "write" },
  },
  outcome: {
    ...readAuthority,
    description: "Read the status of a transaction signed by the initiating account.",
    args: z.tuple([z.object({ group, txId: ChronologDigestSchema }).strict()]),
    returns: z
      .discriminatedUnion("status", [
        z.object({ status: z.literal("pending") }).strict(),
        z.object({ status: z.literal("accepted") }).strict(),
        z
          .object({
            status: z.literal("rejected"),
            code: z.string(),
            statementIndex: sequence.nullable(),
          })
          .strict(),
        z.object({ status: z.literal("abandoned") }).strict(),
      ])
      .nullable(),
  },
  query: {
    ...readAuthority,
    description: "Run a read-only SQL query against the group's selected revision.",
    args: z.tuple([groupQuery.extend({ revision: ChronologRevisionSchema.optional() })]),
    returns: queryResult,
  },
  subscribe: {
    ...readAuthority,
    description: "Stream current query results as the selected revision changes.",
    args: z.tuple([groupQuery]),
    returns: StreamResponseSchema,
  },
});
