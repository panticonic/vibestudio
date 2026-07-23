/**
 * Wire schema for the server "runtime" entity lifecycle service.
 */

import { z } from "zod";
import type {
  MethodAccessDescriptor,
  ServiceAuthorityPolicy,
} from "@vibestudio/shared/serviceAuthority";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import { UnitAuthorityRequestSchema, EvalAuthorityCeilingSchema } from "./build.js";
import { contextBoundaryAuthority } from "./authority/contextBoundary.js";

// Access descriptors carry sensitivity metadata; caller-kind authorization
// belongs exclusively to the service/method `authority`.
const READ_ACCESS: MethodAccessDescriptor = {
  sensitivity: "read",
};
const RETIRE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "destructive",
};
const TITLE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};

// Read-query caller gate that additionally admits the `agent` caller kind.
// The service-level runtime policy
// deliberately omits `agent` — mutating/lifecycle methods (createEntity,
// retireEntity, cloneContext, destroyContext, …) stay agent-denied — so the
// agent grant is opted into per read method here (still a subset of `do`).
const RUNTIME_AGENT_READ_POLICY: ServiceAuthorityPolicy = {
  principals: ["code", "host", "user"],
};

const runtimeContextBoundaryAuthority = (method: string, tier: "gated" | "critical" = "gated") => {
  const primaryCapability =
    method === "cloneContext"
      ? "context.clone"
      : method === "createSubagentContext"
        ? "subagents.create"
        : "context.boundary";
  return contextBoundaryAuthority({
    service: "runtime",
    method,
    primaryCapability,
    principals: ["code", "user", "host"],
    tier,
  });
};

export const RuntimeEntityHandleSchema = z
  .object({
    id: z.string().describe("Server-authoritative canonical entity id."),
    kind: z
      .enum(["panel", "app", "worker", "do", "session"])
      .describe("Entity kind that was created."),
    source: z
      .object({
        repoPath: z.string().describe("Workspace-relative source repo path."),
        effectiveVersion: z
          .string()
          .describe("Resolved build/state version this entity is pinned to."),
      })
      .strict()
      .describe("Resolved source identity (repo path + effective version)."),
    buildKey: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional()
      .describe("Content-addressed BuildV2 artifact selected for this incarnation."),
    executionDigest: z
      .string()
      .optional()
      .describe("Immutable execution artifact digest selected for this incarnation."),
    authorityRequests: z
      .array(UnitAuthorityRequestSchema)
      .optional()
      .describe("Reviewed capability requests embedded in the selected execution artifact."),
    authorityEvalCeilings: z
      .array(EvalAuthorityCeilingSchema)
      .optional()
      .describe("Reviewed eval evalCeilings embedded in the selected execution artifact."),
    contextId: z.string().describe("Semantic workspace context this entity belongs to."),
    targetId: z
      .string()
      .describe(
        "Runtime target handle: the workerd target for do/worker; the canonical id otherwise."
      ),
  })
  .strict();

const BuildRefSchema = z
  .string()
  .describe(
    'Optional exact code build ref. Workers and Durable Objects default to their owning context; panels and apps default to protected main. Pass "main", "ctx:<contextId>", or "state:<stateHash>" only to select that frontier deliberately.'
  );

const RuntimeAgentBindingSchema = z
  .object({
    entityId: z.string().min(1).max(240),
    channelId: z.string().min(1).max(200),
  })
  .strict()
  .describe(
    "Host-verified binding input for runtimes that relay an external agent/session. The host derives context from the bound entity."
  );

export const PanelEntityCreateSpecSchema = z
  .object({
    kind: z.literal("panel"),
    source: z.string().describe("Workspace-relative panel source repo path."),
    ref: BuildRefSchema.optional(),
    contextId: z
      .string()
      .nullable()
      .optional()
      .describe(
        "Target context; omit/null to inherit the verified caller's context, or mint a fresh root when the caller has no runtime context."
      ),
    key: z.string().optional().describe("Stable instance key; omit to mint a random UUID."),
    stateArgs: z.unknown().optional().describe("Opaque initial state passed to the panel runtime."),
  })
  .strict();

export const CreateEntitySpecSchema = z.discriminatedUnion("kind", [
  PanelEntityCreateSpecSchema,
  z.object({
    kind: z.literal("app"),
    source: z.string().describe("Workspace-relative app source repo path."),
    ref: BuildRefSchema.optional(),
    contextId: z
      .string()
      .nullable()
      .optional()
      .describe(
        "Target context; omit/null to inherit the verified caller's context, or mint a fresh root when the caller has no runtime context."
      ),
    key: z.string().optional().describe("Stable instance key; omit to mint a random UUID."),
    stateArgs: z.unknown().optional().describe("Opaque initial state passed to the app runtime."),
  }),
  z.object({
    kind: z.literal("worker"),
    source: z.string().describe("Workspace-relative worker source repo path."),
    ref: BuildRefSchema.optional(),
    contextId: z
      .string()
      .nullable()
      .optional()
      .describe(
        "Target context; omit/null to inherit the verified caller's context, or mint a fresh root when the caller has no runtime context."
      ),
    key: z.string().optional().describe("Stable instance key; omit to mint a random UUID."),
    stateArgs: z
      .unknown()
      .optional()
      .describe("Opaque initial state passed to the worker runtime."),
    env: z.record(z.string()).optional().describe("Extra environment variables for the worker."),
    agentBinding: RuntimeAgentBindingSchema.optional(),
    agentChannelId: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "Channel this runtime entity itself serves as an agent. The host derives the canonical entity and context coordinates; callers never supply them."
      ),
  }),
  z.object({
    kind: z.literal("do"),
    source: z.string().describe("Workspace-relative DO source repo path."),
    ref: BuildRefSchema.optional(),
    className: z.string().describe("Durable Object class name exported by the source."),
    key: z.string().optional().describe("Stable instance key; omit to mint a random UUID."),
    contextId: z
      .string()
      .nullable()
      .optional()
      .describe(
        "Target context; omit/null to inherit the verified caller's context, or derive it from agentBinding. Root callers mint a fresh context."
      ),
    stateArgs: z.unknown().optional().describe("Opaque initial state passed to the DO runtime."),
    agentBinding: RuntimeAgentBindingSchema.optional(),
    agentChannelId: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "Channel this runtime entity itself serves as an agent. The host derives the canonical entity and context coordinates; callers never supply them."
      ),
  }),
  z.object({
    kind: z.literal("session"),
    source: z.string().describe("Logical session source label (e.g. an agent CLI name)."),
    contextId: z
      .string()
      .nullable()
      .optional()
      .describe("Target context; omit/null to mint a fresh one (reused on key re-attach)."),
    key: z.string().optional().describe("Stable session key; omit to mint a random UUID."),
    title: z.string().optional().describe("Display title surfaced by approval UIs."),
    agentChannelId: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "Channel served by this external-agent session. The host records the derived self entity/context/channel binding on the session."
      ),
  }),
]);

/** Wire shape of a full logical workspace context branch. */
export const WorkspaceContextSchema = z
  .object({
    contextId: z.string().describe("Context id for a full logical workspace branch view."),
  })
  .strict();

/** One source→clone entity mapping produced by `cloneContext`. */
export const ClonedEntitySchema = z
  .object({
    sourceId: z.string().describe("Canonical id of the source entity that was cloned."),
    newId: z.string().describe("Canonical id of the freshly-created clone in the new context."),
    kind: z.enum(["worker", "do"]).describe("Cloned entity kind (only durable kinds are cloned)."),
    source: z.string().describe("Shared source repo path (clone runs the same code)."),
    className: z.string().optional().describe("DO class name (present for kind 'do')."),
    sourceKey: z.string().describe("The source entity's instance key."),
    newKey: z.string().describe("The clone's freshly-minted instance key."),
    targetId: z.string().describe("Runtime target handle of the clone (workerd target)."),
  })
  .strict();

/** Kind of a context-relationship edge (registry). */
export const ContextEdgeKindSchema = z
  .enum(["lifecycle", "lineage"])
  .describe(
    "'lifecycle' = subagent context (cascaded on destroy, cloned on recursive clone); 'lineage' = fork provenance (access-only, never cascaded/cloned-followed)."
  );

/** One cloned context mapping produced by a recursive `cloneContext`. */
export const ClonedContextSchema = z
  .object({
    sourceContextId: z.string().describe("Source context that was cloned."),
    newContextId: z.string().describe("Freshly-minted clone of that context."),
    ownerNewContextId: z
      .string()
      .nullable()
      .describe("Cloned owner of this context in the clone tree (null for the root fork context)."),
  })
  .strict();

/** One source→clone entity rewiring, for the caller to re-home channels/pending calls. */
export const RewiredEntitySchema = z
  .object({
    sourceEntityId: z.string().describe("Canonical id of the source entity."),
    newEntityId: z.string().describe("Canonical id of its clone."),
    sourceChannelId: z
      .string()
      .optional()
      .describe("Channel the source entity was bound to (filled by the caller, not runtime)."),
    newChannelId: z
      .string()
      .optional()
      .describe("Channel the clone should bind to (filled by the caller, not runtime)."),
  })
  .strict();

/** Wire shape of a `cloneContext` result: the new context + the source→clone maps. */
export const CloneContextResultSchema = z
  .object({
    contextId: z.string().describe("The freshly-minted, isolated context holding the clones."),
    entities: z
      .array(ClonedEntitySchema)
      .describe("Source→clone mapping for every cloned worker/DO, in clone order."),
    contexts: z
      .array(ClonedContextSchema)
      .describe(
        "Source→clone mapping for every cloned context (root + recursive lifecycle subtree)."
      ),
    rewired: z
      .array(RewiredEntitySchema)
      .describe(
        "Entity id rewiring across all cloned contexts. Channel fields are left for the caller (runtime is channel-agnostic)."
      ),
  })
  .strict();

export type ClonedEntity = z.infer<typeof ClonedEntitySchema>;
export type ClonedContext = z.infer<typeof ClonedContextSchema>;
export type RewiredEntity = z.infer<typeof RewiredEntitySchema>;
export type CloneContextResult = z.infer<typeof CloneContextResultSchema>;

export const runtimeMethods = defineServiceMethods({
  createEntity: {
    description:
      "Create a runtime entity (panel, app, worker, DO, or session) and commit its durable identity. Omitted contextId inherits the verified caller's context; root callers without one mint a fresh context. A canonical key is an immutable identity and never silently switches source, context, or effective code version. Reuses or reactivates only a compatible row. Retirement does not release that identity; replacing an instance or launching edited disposable code requires a fresh key. Returns the entity handle (id + runtime targetId).",
    args: z.tuple([CreateEntitySpecSchema]),
    returns: RuntimeEntityHandleSchema,
    authority: runtimeContextBoundaryAuthority("createEntity"),
    access: {
      sensitivity: "write",
      // Declares the handler's gate (createEntity rejects app for
      // non-shell/non-server callers, and session for callers other than
      // shell/server/orchestrator-extension, with "host-managed").
      restrictedTo: [
        {
          when: "spec.kind is 'app'",
          principals: ["host", "user"],
          reason: "app runtime entities are host-managed",
        },
        {
          when: "spec.kind is 'session'",
          principals: ["host", "user", "code"],
          reason:
            "session entities are host-managed, except a launch-orchestrator extension may create a source-tagged session",
        },
      ],
      // Declares the dispatcher's prepared context-boundary leaf. It fires only
      // when the target context is BOTH foreign to the caller AND already exists;
      // same-context and fresh-context launches are free, as is trusted chrome.
      approval: [
        {
          when: "launching into another, already-existing context than the caller",
          capability: "context.boundary",
          operation: { kind: "runtime", verb: "Create runtime entity" },
          reason: "launching code into another agent or panel's existing context requires approval",
        },
      ],
    },
    examples: [
      { args: [{ kind: "do", source: "workers/agent", className: "AgentDO", key: "agent-1" }] },
      { args: [{ kind: "session", source: "agent-cli", key: "s1", title: "My agent session" }] },
    ],
  },
  reservePanelEntity: {
    description:
      "Reserve a panel's stable durable identity and context without waiting for its immutable runtime image. Reserved entities are non-executable until activatePanelEntity completes.",
    args: z.tuple([PanelEntityCreateSpecSchema]),
    returns: RuntimeEntityHandleSchema,
    authority: { principals: ["host"] },
    access: { sensitivity: "write" },
  },
  activatePanelEntity: {
    description:
      "Prepare and atomically activate the immutable runtime image for a previously reserved panel entity.",
    args: z.tuple([PanelEntityCreateSpecSchema]),
    returns: RuntimeEntityHandleSchema,
    authority: { principals: ["host"] },
    access: { sensitivity: "write" },
  },
  retireEntity: {
    description:
      "Retire a single entity, firing cleanup hooks. With removeContext, also delete the context folder when no other live entity shares the context.",
    args: z.tuple([
      z.object({
        id: z.string().describe("Canonical id of the entity to retire."),
        removeContext: z
          .boolean()
          .optional()
          .describe("Also delete the context folder if no other live entity shares it."),
      }),
    ]),
    returns: z.void(),
    authority: runtimeContextBoundaryAuthority("retireEntity", "critical"),
    access: RETIRE_ACCESS,
    examples: [{ args: [{ id: "do:workers/agent:AgentDO:agent-1", removeContext: true }] }],
  },
  listEntities: {
    description:
      "List exact live runtime instances (id, kind, source, key, contextId, title, createdAt). For running workers use kind='worker'; workspace.units.list provides aggregate status per source rather than instance ids.",
    args: z.tuple([
      z
        .object({
          kind: z
            .enum(["panel", "app", "worker", "do", "session"])
            .optional()
            .describe("Filter to a single entity kind; omit to list all kinds."),
        })
        .optional(),
    ]),
    returns: z.array(
      z.object({
        id: z.string().describe("Canonical entity id."),
        kind: z.string().describe("Entity kind."),
        source: z.string().describe("Source repo path."),
        key: z.string().describe("Caller-selected instance key encoded in the canonical id."),
        contextId: z.string().describe("Owning context id."),
        title: z.string().optional().describe("Display title, when one has been set."),
        createdAt: z.number().describe("Creation timestamp (epoch ms)."),
      })
    ),
    access: READ_ACCESS,
    authority: RUNTIME_AGENT_READ_POLICY,
    examples: [{ args: [] }, { args: [{ kind: "session" }] }],
  },
  resolveContext: {
    description:
      "Return the contextId for an entity (or null if unknown). Cached read; falls back to DO.",
    args: z.tuple([z.string().describe("Canonical entity id to resolve.")]),
    returns: z.string().nullable(),
    access: READ_ACCESS,
    authority: RUNTIME_AGENT_READ_POLICY,
  },
  setTitle: {
    description:
      "Set a server-controlled display title for the calling entity. Surfaced by approval UIs in place of the opaque id. Pass null/empty to clear.",
    args: z.tuple([
      z.string().nullable().describe("New display title; null/empty clears it."),
      z
        .object({
          explicit: z
            .boolean()
            .optional()
            .describe("Mark the title as user-intended (vs. an inferred default)."),
        })
        .optional(),
    ]),
    returns: z.void(),
    // Single source of truth for setTitle's access: executable view/worker code
    // may title its own runtime. The compositional dispatcher enforces this exact
    // code-principal requirement; the handler performs no duplicate kind check.
    authority: { principals: ["code"] },
    access: TITLE_ACCESS,
    examples: [{ args: ["Workspace Shell", { explicit: true }] }],
  },
  createContext: {
    description:
      "Create a full logical semantic workspace context. When invoked by a context-scoped runtime, the new context is recorded as that exact runtime entity's lifecycle child, making ownership, initialization authority, and teardown walkable instead of leaving an ownerless context island. Root host callers create root contexts. The state machine initializes one exact committed event and event/application working head over the whole workspace; later semantic operations advance that working head atomically. Use vcs.status for compact ancestry and integration orientation, then page repository and work membership through focused VCS inspectors.",
    args: z.tuple([
      z.object({
        contextId: z
          .string()
          .optional()
          .describe("Explicit context id; omit to mint a random UUID."),
      }),
    ]),
    returns: WorkspaceContextSchema,
    authority: runtimeContextBoundaryAuthority("createContext"),
    access: { sensitivity: "write" },
    examples: [{ args: [{}] }, { args: [{ contextId: "agent-branch-1" }] }],
  },
  cloneContext: {
    description:
      "Clone a context's durable state—every worker/DO store plus its exact committed event and event/application working head—into a fresh isolated context. Immutable semantic history and authored facts are shared by identity, not copied into a parallel snapshot history. Returns the new contextId and source-to-clone entity/context maps. With `recursive`, the whole lifecycle subtree is cloned (never following lineage edges); with `targetKey`, retry returns the same child. The caller performs per-entity rewiring such as fork-log re-rooting on the returned clones.",
    args: z.tuple([
      z.object({
        sourceContextId: z.string().describe("Context whose durable state is cloned."),
        include: z
          .array(z.string())
          .optional()
          .describe(
            "Canonical ids of the worker/DO entities to clone; applies to the ROOT context only (recursive descendants always clone in full). Omit to clone every durable entity. The semantic workspace state is always cloned as a whole-context pair of roots."
          ),
        recursive: z
          .boolean()
          .optional()
          .describe(
            "Clone the LIFECYCLE subtree of the source context (subagent worlds), re-parented to the cloned owner. Lineage (fork) edges are never followed. Cloning a context that HAS lifecycle children without this flag is an error."
          ),
        targetKey: z
          .string()
          .optional()
          .describe(
            "Idempotency key (e.g. `fork:{forkId}`). Derives the child contextId + entity keys deterministically and makes storage clone upsert-safe, so a crash-retry returns the SAME child, never a duplicate."
          ),
      }),
    ]),
    returns: CloneContextResultSchema,
    authority: runtimeContextBoundaryAuthority("cloneContext"),
    access: {
      sensitivity: "write",
      // Reading + duplicating another context's durable state is gated by the
      // single context-boundary capability: prompts iff the SOURCE context is
      // BOTH foreign to the caller AND already exists. Cloning your own context
      // is free; the freshly-minted target context is always free.
      approval: [
        {
          when: "cloning another, already-existing context than the caller",
          capability: "context.boundary",
          operation: { kind: "runtime", verb: "Clone context" },
          reason: "cloning another agent or panel's existing context state requires approval",
        },
      ],
    },
    examples: [{ args: [{ sourceContextId: "ctx-abc" }] }],
  },
  destroyContext: {
    description:
      "Retire every entity in a context and delete its folder + VCS state. With `recursive` (the default when lifecycle children exist), post-order teardown of the LIFECYCLE subtree only — never crossing a lineage (fork) edge. Free for your own context or one you fully own (every active entity was launched by you); gated when destroying another agent or panel's existing context.",
    args: z.tuple([
      z.object({
        contextId: z.string().describe("Context to destroy (all its entities are retired)."),
        recursive: z
          .boolean()
          .optional()
          .describe(
            "Post-order teardown of the LIFECYCLE subtree (subagent worlds). Defaults to true so lifecycle children cascade; lineage (fork) edges are never followed. Pass false to destroy only this context."
          ),
      }),
    ]),
    returns: z.void(),
    authority: runtimeContextBoundaryAuthority("destroyContext", "critical"),
    access: {
      sensitivity: "destructive",
      // Gated by context-boundary, with an ownership bypass: destroying a context
      // whose every active entity you launched (or your own context) is free; only
      // tearing down another agent or panel's existing context prompts.
      approval: [
        {
          when: "destroying another agent or panel's existing context (not one you own)",
          capability: "context.boundary",
          operation: { kind: "runtime", verb: "Destroy context" },
          reason: "destroying another agent or panel's existing context requires approval",
        },
      ],
    },
    examples: [{ args: [{ contextId: "ctx-abc" }] }],
  },
  listOwnedContexts: {
    description:
      "List the contexts owned by a context via the relationship registry. `kind` scopes to 'lifecycle' (subagent children) or 'lineage' (fork provenance); omit to list both. Returns { contexts: [...] }.",
    args: z.tuple([
      z.object({
        contextId: z.string().describe("Owner context whose edges are listed."),
        kind: ContextEdgeKindSchema.optional().describe(
          "Scope to a single edge kind; omit to list both lifecycle and lineage."
        ),
      }),
    ]),
    returns: z
      .object({
        contexts: z.array(
          z
            .object({
              contextId: z.string().describe("Owned/child/descendant context id."),
              kind: ContextEdgeKindSchema,
              ownerEntityId: z
                .string()
                .nullable()
                .describe("Spawning entity in the owner context (lifecycle), or null."),
            })
            .strict()
        ),
      })
      .strict(),
    access: READ_ACCESS,
    authority: RUNTIME_AGENT_READ_POLICY,
    examples: [{ args: [{ contextId: "ctx-abc", kind: "lifecycle" }] }],
  },
  recordContextEdge: {
    description:
      "Idempotently upsert a context-relationship edge into the registry. Host-internal only; userland creates trusted edges through cloneContext/createSubagentContext instead.",
    args: z.tuple([
      z.object({
        contextId: z.string().describe("Child/dependent/descendant context."),
        ownerContextId: z.string().describe("Parent/owner context."),
        kind: ContextEdgeKindSchema,
        ownerEntityId: z
          .string()
          .optional()
          .describe("Spawning entity in the owner context (lifecycle subagent owner)."),
      }),
    ]),
    returns: z.void(),
    access: { sensitivity: "write" },
    authority: { principals: ["user", "host"] },
    examples: [
      {
        args: [{ contextId: "ctx-child", ownerContextId: "ctx-parent", kind: "lifecycle" }],
      },
    ],
  },
  createSubagentContext: {
    description:
      "Create a subagent's child context from a parent: validate the spawning owner, mint a deterministic child contextId from targetKey, fork the parent's committed event and exact event/application working head while retaining provenance lineage, ensure its projection directory, and record a 'lifecycle' edge (owner = parentContextId). Idempotent under targetKey. Composes context lifecycle and registry operations; callers must not hand-roll this.",
    args: z.tuple([
      z.object({
        parentContextId: z.string().describe("Parent context the subagent forks from."),
        ownerEntityId: z.string().describe("The spawning agent entity (recorded on the edge)."),
        targetKey: z
          .string()
          .describe("Idempotency key deriving the deterministic child contextId."),
      }),
    ]),
    returns: z.object({ contextId: z.string() }).strict(),
    authority: runtimeContextBoundaryAuthority("createSubagentContext"),
    access: { sensitivity: "write" },
    examples: [
      {
        args: [
          {
            parentContextId: "ctx-parent",
            ownerEntityId: "do:workers/agent:AgentDO:a1",
            targetKey: "run:r1",
          },
        ],
      },
    ],
  },
});
