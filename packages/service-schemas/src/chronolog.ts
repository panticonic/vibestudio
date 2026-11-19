import { z } from "zod";
import { requirementForPrincipals } from "@vibestudio/shared/authorization";
import { StreamResponseSchema } from "@vibestudio/shared/streamResponse";
import {
  defineServiceMethods,
  fixedPreparedAuthorityRequirement,
} from "@vibestudio/shared/typedServiceClient";

export const CHRONOLOG_PRINCIPALS = ["user", "code"] as const;
export const CHRONOLOG_TRANSACTION_RESOLVER = "chronolog.transact.program";
export const CHRONOLOG_CREATE_RESOLVER = "chronolog.groups.create";
export const CHRONOLOG_INVITE_RESOLVER = "chronolog.groups.invite";
export const CHRONOLOG_JOIN_RESOLVER = "chronolog.groups.join";
export const CHRONOLOG_SHARE_HISTORY_RESOLVER = "chronolog.history.share";
export const CHRONOLOG_PUBLISH_HISTORY_RESOLVER = "chronolog.history.publish";
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
  presentation: {
    title: "Read from Chronolog",
    action: "read from Chronolog",
    description: "Read account or workspace information and data from authorized Chronolog groups.",
    group: "sharing",
    authorityCategory: { domain: "sharing" as const, verb: "see" as const },
  },
  access: { sensitivity: "read" as const },
};

const node = z
  .object({
    publicKey: ChronologDigestSchema,
    endpoint: z
      .object({
        nodeId: ChronologDigestSchema,
        addrs: z.array(z.string().min(1).max(512)).max(16).optional(),
        relay: z.string().min(1).max(512).optional(),
      })
      .strict(),
  })
  .strict();
const offer = z
  .string()
  .min(1)
  .max(4 * 1024 * 1024);
const groupId = z.object({ group }).strict();
const workspaceId = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/u);
const historyHead = z.string().regex(/^[a-f0-9]{40}$/u);
const historyEvent = z.string().min(1).max(256);
export const ChronologHistoryTransitionSchema = z
  .object({
    sourceNodeId: ChronologDigestSchema,
    destinationNodeId: ChronologDigestSchema,
    workspaceId,
    previousHead: historyHead,
    proposedHead: historyHead,
  })
  .strict();
export const ChronologHistoryProofSchema = z
  .object({
    payload: ChronologHistoryTransitionSchema.extend({
      version: z.literal(1),
      applicationId: group,
      generation: ChronologDigestSchema,
      publisherPublicKey: ChronologDigestSchema,
    }).strict(),
    signature: z.string().regex(/^[a-f0-9]{128}$/u),
  })
  .strict();
const catalogAuthority = {
  ...readAuthority,
  authority: { requirement: readRequirement, resource: { kind: "literal", key: "membership" } },
} as const;

function groupMutation(
  resolver: string,
  resource: typeof groupResource | { kind: "argument"; index: 0; path: ["operationId"] }
) {
  return {
    website,
    capability: writeCapability,
    authority: {
      requirement: writeRequirement,
      resource,
      prepared: {
        resolver,
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
      rationale: "The prepared group operation selects the approved membership change.",
    },
    access: { sensitivity: "write" },
  } as const;
}

export const chronologMethods = defineServiceMethods({
  "groups.identity": {
    ...catalogAuthority,
    description: "Get the verified account and workspace node keys for an invitation.",
    args: z.tuple([]),
    returns: z.object({ publicKey: ChronologDigestSchema, node }).strict(),
  },
  "groups.list": {
    ...catalogAuthority,
    description: "List the locally installed groups where the account can read.",
    args: z.tuple([]),
    returns: z.array(
      z
        .object({
          group,
          name: z.string(),
          writer: z.boolean(),
          publisher: z.boolean(),
          administrator: z.boolean(),
        })
        .strict()
    ),
  },
  "groups.create": {
    ...groupMutation(CHRONOLOG_CREATE_RESOLVER, {
      kind: "argument",
      index: 0,
      path: ["operationId"],
    }),
    description:
      "Create an independently stored SQL group and admit the initiating account as administrator.",
    args: z.tuple([
      z
        .object({
          operationId,
          name: z.string().trim().min(1).max(128),
          policy: z.literal("eligible-members-v1"),
          schema: canonicalProgram,
        })
        .strict(),
    ]),
    returns: groupId,
  },
  "groups.invite": {
    ...groupMutation(CHRONOLOG_INVITE_RESOLVER, groupResource),
    description: "Sign a group invitation for one account and its workspace node.",
    args: z.tuple([
      z
        .object({
          group,
          operationId: operationId.max(120),
          member: ChronologDigestSchema,
          role: z.enum(["reader", "writer", "publisher", "administrator"]),
          node,
        })
        .strict(),
    ]),
    returns: z.object({ group, offer }).strict(),
  },
  "groups.join": {
    ...groupMutation(CHRONOLOG_JOIN_RESOLVER, groupResource),
    description: "Install the exact invitation in this workspace and verify current membership.",
    args: z.tuple([z.object({ group, offer }).strict()]),
    returns: groupId,
  },
  "history.current": {
    ...readAuthority,
    description: "Get the exact published workspace history revision for this group.",
    args: z.tuple([groupId]),
    returns: z.object({ workspaceId, head: historyHead, eventId: historyEvent }).strict(),
  },
  "history.share": {
    ...groupMutation(CHRONOLOG_SHARE_HISTORY_RESOLVER, groupResource),
    description:
      "Allow this Chronolog group's publishers to update the workspace's shared history.",
    args: z.tuple([groupId]),
    returns: groupId,
  },
  "history.publish": {
    ...groupMutation(CHRONOLOG_PUBLISH_HISTORY_RESOLVER, groupResource),
    description:
      "Send one exact published workspace history update to an admitted group workspace.",
    args: z.tuple([
      z
        .object({
          group,
          destination: node.shape.endpoint,
          workspaceId,
          previousHead: historyHead,
          proposedHead: historyHead,
          eventId: historyEvent,
        })
        .strict()
        .refine(({ previousHead, proposedHead }) => previousHead !== proposedHead),
    ]),
    returns: z.object({ head: historyHead }).strict(),
  },
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
