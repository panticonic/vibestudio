/**
 * portableRuntimeSurface — the runtime-instance surface that is IDENTICAL on
 * panel · worker · eval, i.e. exactly what `createHostedRuntime` returns. This is
 * the single source of truth for cross-target parity:
 *   - `runtimeSurface.eval.ts` IS this surface (what `import {…} from
 *     "@workspace/runtime"` resolves to inside eval).
 *   - `runtimeSurface.core.ts` is this surface minus the few entries whose
 *     description differs per target (workspace / openPanel / … / panelTree),
 *     which panel & worker then re-add with their own wording.
 *   - the parity test asserts `Object.keys(createHostedRuntime(host))` equals
 *     these keys.
 *
 * Includes `callMain` + `getParent`/`getParentWithContract` (portable as
 * of the surface-harmonization). Does NOT include `expose` (use `rpc.expose`) or
 * the removed approval APIs. Authority acquisition is receiver-owned and is
 * not exposed as an advisory runtime namespace.
 */

import {
  callableEntry,
  namespaceEntry,
  valueEntry,
  type RuntimeSurfaceEntry,
} from "@vibestudio/shared/runtimeSurface";
import browserDataRuntimeCatalog from "./generated/browserDataRuntimeCatalog.json";
import gadRuntimeCatalog from "./generated/gadRuntimeCatalog.json";
import gitRuntimeCatalog from "./generated/gitRuntimeCatalog.json";
import templatesRuntimeCatalog from "./generated/templatesRuntimeCatalog.json";
import webhooksRuntimeCatalog from "./generated/webhooksRuntimeCatalog.json";
import workspaceServiceResolutionSchema from "./generated/workspaceServiceResolution.json";
import { GAD_RUNTIME_METHOD_NAMES } from "@vibestudio/shared/gadRuntimeMethods";
import { runtimeMethods } from "../runtime.js";
import { problemReportsMethods } from "../problemReports.js";
import {
  BLOBSTORE_METHOD_NAMES,
  GIT_INTEROP_METHOD_NAMES,
  VCS_METHOD_NAMES,
  WORKSPACE_METHOD_NAMES,
} from "../clients/generated/runtimeClientMethods.js";

export const OPEN_PANEL_SIGNATURE =
  "openPanel(source: string, options?: OpenPanelOptions): Promise<PanelHandle>";
export const CREATE_PANEL_SLOT_SIGNATURE =
  "createPanelSlot(source: string, options?: CreatePanelSlotOptions): Promise<PanelHandle>";

export const PANEL_HANDLE_AUTOMATION_GUIDE =
  "The returned PanelHandle is the complete lifecycle and inspection API. " +
  "Use `const session = await handle.cdp.session(); const page = session.page` for automation. Keep the stable page across rebuild/navigation; its next awaited operation rebinds without replaying the interrupted action. `session.receipt` reports acquired, reconnected, or replaced generations. " +
  'For a one-call host image use `await handle.cdp.screenshot({ format: "png" })`. ' +
  "For host-captured logs since panel creation use `await handle.cdp.consoleHistory()` (live page console events are separate).";

// --- shared namespace member arrays (single source of truth) ---
export const WORKERS_MEMBERS = [
  "listSources",
  "create",
  "createDurableObject",
  "list",
  "destroy",
  "resetStorage",
  "listStorageBackups",
  "restoreStorageBackup",
  "listServices",
  "resolveService",
  "resolveDurableObject",
  "durableObjectService",
];

/**
 * Public helper methods owned by the runtime wrapper rather than a same-named
 * RPC service method. Keeping their contracts beside the runtime surface makes
 * `docs_search` and `help()` two projections of the same API instead of forcing
 * agents to guess the lower-level runtime transport.
 */
export const WORKERS_RUNTIME_METHOD_CATALOG = {
  listSources: {
    signature: "listSources(): Promise<WorkerSourceInfo[]>",
    description:
      "List every launchable worker source with its manifest entry point and Durable Object classes. Use this to inspect runnable units; do not guess index.ts or class names.",
    argumentNames: [],
    argsSchema: { type: "array", maxItems: 0, prefixItems: [] },
    examples: [{ args: [] }],
  },
  create: {
    signature: "create(source: string, options?: WorkerCreateOptions): Promise<WorkerEntityHandle>",
    description:
      "Launch a regular worker through the canonical entity lifecycle in the caller's current semantic workspace context. Pass contextId only to deliberately target another context; key, env, stateArgs, and ref are optional.",
    argumentNames: ["source", "options"],
    argsSchema: {
      type: "array",
      prefixItems: [
        { type: "string", description: "Workspace-relative worker source." },
        {
          type: "object",
          properties: {
            key: { type: "string" },
            contextId: { type: "string" },
            env: { type: "object", additionalProperties: { type: "string" } },
            stateArgs: {},
            ref: { type: "string" },
          },
          additionalProperties: false,
        },
      ],
      minItems: 1,
      maxItems: 2,
    },
    examples: [{ args: ["workers/my-worker", { key: "probe-1" }] }],
  },
  createDurableObject: {
    signature:
      "createDurableObject(source: string, className: string, options?: DurableObjectCreateOptions): Promise<DurableObjectEntityHandle>",
    description:
      "Create a concrete Durable Object through the canonical entity lifecycle, owned by the caller and therefore safe to pass to workers.destroy. Call the returned handle's targetId directly for RPC; the handle does not echo its creation key. Retain an explicit options.key if you will later resolve the object by source, class, and key. Use resolveDurableObject for an existing/shared object; resolving never transfers lifecycle ownership.",
    argumentNames: ["source", "className", "options"],
    argsSchema: {
      type: "array",
      prefixItems: [
        { type: "string", description: "Workspace-relative worker source." },
        { type: "string", description: "Manifest-declared Durable Object class." },
        {
          type: "object",
          properties: {
            key: { type: "string" },
            contextId: { type: "string" },
            stateArgs: {},
            ref: { type: "string" },
          },
          additionalProperties: false,
        },
      ],
      minItems: 2,
      maxItems: 3,
    },
    examples: [{ args: ["workers/notes", "NotesDO", { key: "disposable-probe" }] }],
  },
  list: {
    signature: "list(): Promise<WorkerEntityInfo[]>",
    description: "List live regular-worker instances and their canonical entity handles.",
    argumentNames: [],
    argsSchema: { type: "array", maxItems: 0 },
    examples: [{ args: [] }],
  },
  destroy: {
    signature: "destroy(entity: RuntimeEntityReference): Promise<void>",
    description:
      "Retire a runtime entity through the canonical lifecycle. Pass a handle from workers.create or workers.createDurableObject, or its canonical id. Resolving an object or service does not transfer lifecycle ownership.",
    argumentNames: ["entity"],
    argsSchema: {
      type: "array",
      prefixItems: [
        {
          oneOf: [
            { type: "string" },
            {
              type: "object",
              properties: {
                id: { type: "string" },
                targetId: { type: "string" },
              },
              anyOf: [{ required: ["id"] }, { required: ["targetId"] }],
              additionalProperties: true,
            },
          ],
        },
      ],
      minItems: 1,
      maxItems: 1,
    },
    examples: [{ args: [{ id: "worker:workers/my-worker:probe-1" }] }],
  },
  resetStorage: {
    signature:
      "resetStorage(target: DurableObjectStorageTarget, intent: string): Promise<{ operationId: string }>",
    description:
      "Back up, integrity-check, and reset one exact Durable Object storage target. Reset only explicitly disposable state; retained product data must use its current product export/import surface.",
    argumentNames: ["target", "intent"],
    argsSchema: { type: "array", minItems: 2, maxItems: 2 },
    examples: [
      {
        args: [
          { source: "workers/notes", className: "NotesDO", objectKey: "scratch" },
          "Discard incompatible disposable test data",
        ],
      },
    ],
  },
  listStorageBackups: {
    signature:
      "listStorageBackups(target: DurableObjectStorageTarget): Promise<DurableObjectStorageBackup[]>",
    description: "List verified storage backups for one exact Durable Object target.",
    argumentNames: ["target"],
    argsSchema: { type: "array", minItems: 1, maxItems: 1 },
    examples: [{ args: [{ source: "workers/notes", className: "NotesDO", objectKey: "scratch" }] }],
  },
  restoreStorageBackup: {
    signature:
      "restoreStorageBackup(target: DurableObjectStorageTarget, operationId: string, intent: string): Promise<{ operationId: string }>",
    description:
      "Back up the current files and restore a verified named backup to the same exact target.",
    argumentNames: ["target", "operationId", "intent"],
    argsSchema: { type: "array", minItems: 3, maxItems: 3 },
    examples: [
      {
        args: [
          { source: "workers/notes", className: "NotesDO", objectKey: "scratch" },
          "00000000-0000-4000-8000-000000000000",
          "Undo the disposable schema reset",
        ],
      },
    ],
  },
  listServices: {
    signature: "listServices(): Promise<WorkspaceServiceInfo[]>",
    description:
      "List product and live workspace services visible in this exact semantic context. Workspace rows include docsId; open it with the agent docs_open tool for the live method contract.",
    argumentNames: [],
    argsSchema: { type: "array", maxItems: 0, prefixItems: [] },
    examples: [{ args: [] }],
  },
  resolveService: {
    signature:
      "resolveService(query: string, objectKey?: string | null): Promise<ResolvedWorkspaceService>",
    description:
      "Resolve a manifest-declared service by name or protocol in the caller's exact semantic context. Consent-bound services require the exact workspace-service:<name> capability; declared bindings are reviewed wiring and leave authority to each method's receiver contract. Resolution never grants authority by itself.",
    argumentNames: ["query", "objectKey"],
    argsSchema: {
      type: "array",
      prefixItems: [
        {
          type: "string",
          description: "Service name or protocol from workers.listServices()/docs_open.",
        },
        {
          type: ["string", "null"],
          description: "Object key override for a Durable Object service.",
        },
      ],
      minItems: 1,
      maxItems: 2,
    },
    returnsSchema: workspaceServiceResolutionSchema,
    examples: [{ args: ["example.notes.v1"] }],
  },
  resolveDurableObject: {
    signature:
      "resolveDurableObject(source: string, className: string, objectKey: string): Promise<ResolvedDurableObjectTarget>",
    description:
      "Resolve and activate an existing concrete Durable Object target when no workspace service declaration exists. Prefer resolveService whenever a declared service is available. Resolution grants relay access but never lifecycle ownership; use createDurableObject when the caller must own and destroy a disposable object.",
    argumentNames: ["source", "className", "objectKey"],
    argsSchema: {
      type: "array",
      prefixItems: [
        { type: "string", description: "Workspace-relative worker source." },
        { type: "string", description: "Manifest-declared Durable Object class." },
        { type: "string", description: "Concrete object key." },
      ],
      minItems: 3,
      maxItems: 3,
    },
    examples: [{ args: ["workers/notes", "NotesDO", "main"] }],
  },
  durableObjectService: {
    signature:
      "durableObjectService(query: string, objectKey?: string | null): DurableObjectServiceClient",
    description:
      "Create a lazy client that resolves a manifest-declared Durable Object service and calls it through unified RPC.",
    argumentNames: ["query", "objectKey"],
    argsSchema: {
      type: "array",
      prefixItems: [{ type: "string" }, { type: ["string", "null"] }],
      minItems: 1,
      maxItems: 2,
    },
    examples: [{ args: ["example.notes.v1", "main"] }],
  },
} satisfies Record<string, import("@vibestudio/shared/runtimeSurface").RuntimeSurfaceMethodDoc>;

/** Top-level keys of the actual typed workspace client, plus its one ergonomic
 * project-discovery namespace. Deriving this prevents the portable help surface
 * from retaining deleted hub-catalog methods or missing new nested groups. */
export const WORKSPACE_MEMBERS = [
  ...new Set(WORKSPACE_METHOD_NAMES.map((method) => method.split(".")[0]!)),
  "projects",
];

export const CREDENTIALS_MEMBERS = [
  "openWebSocketScope",
  "closeWebSocketScope",
  "store",
  "connect",
  "beginWebsitePublication",
  "recordWebsitePublication",
  "configureClient",
  "requestCredentialInput",
  "getClientConfigStatus",
  "deleteClientConfig",
  "listStoredCredentials",
  "summarizeStoredCredentials",
  "inspectStoredCredentials",
  "revokeCredential",
  "resolveCredential",
  "deriveCredential",
  "fetch",
  "publishFetch",
  "hookForUrl",
  "gitHttp",
  "forAudience",
];

export const BROWSER_DATA_MEMBERS = Object.keys(browserDataRuntimeCatalog);

export const GIT_MEMBERS = [...GIT_INTEROP_METHOD_NAMES];

export const VCS_MEMBERS = [...VCS_METHOD_NAMES, "publish"];

/** Runtime-only VCS composite documented beside the semantic service schema. */
const VCS_RUNTIME_ONLY_METHOD_CATALOG = {
  publish: {
    signature:
      'publish(input?: { contextId?, message?, intentSummary? }): Promise<{ status: "published", contextId, commit, push } | { status: "integration-required", code: "IntegrationRequired", contextId, mainRelation, mainEventId, compare: { target, source } }>',
    description:
      "Read status once, commit the uncommitted chain when there is one, and push the committed event against the observed protected main. Push keeps its build gate and publication approval. When main is behind or diverged it returns IntegrationRequired with the compare to review and changes nothing; it never merges.",
    argumentNames: ["input"],
  },
};

export const VCS_DESCRIPTION =
  "Simple semantic version control: exact event/application state, expressive edit/move/copy records, incremental local integration, whole-chain commit/discard, directly walkable provenance, and atomic external-snapshot acknowledgements containing the committed event/application/work-unit/repository/snapshot tuple.";

export const GAD_MEMBERS = [...GAD_RUNTIME_METHOD_NAMES, "collectChannelEnvelopePages"];

/** Runtime-only GAD helper documented beside the generated service catalog. */
const GAD_RUNTIME_ONLY_METHOD_CATALOG = {
  collectChannelEnvelopePages: {
    signature:
      'collectChannelEnvelopePages(input: { channelId, window?, payloadKind? }, options: { maximumItems: number | "all"; pageSize?: number }, readPage: gad.inspectChannelEnvelopes | gad.readChannelEnvelopes): Promise<Array<{ items, pageInfo }>>',
    description:
      "Follow pageInfo.previous (tail/before) or pageInfo.next (after) through bounded pages until maximumItems are collected or the window is exhausted, returning the pages in ascending sequence order. Forward collection stays bound to the first page's snapshot watermark; a store that claims more data without progress fails instead of looping.",
    argumentNames: ["input", "options", "readPage"],
  },
};

export const BLOBSTORE_MEMBERS = [
  ...BLOBSTORE_METHOD_NAMES,
  "putBytes",
  "getBytes",
  "readText",
  "putPathTree",
];

export const WEBHOOKS_MEMBERS = [
  "createSubscription",
  "listSubscriptions",
  "revokeSubscription",
  "rotateSecret",
];

export const EXTENSIONS_MEMBERS = ["use", "invoke", "invokeProvider", "on", "status", "update"];
export const NOTIFICATIONS_MEMBERS = ["show", "dismiss"];
export const PANEL_TREE_MEMBERS = [
  "self",
  "get",
  "rootOwners",
  "roots",
  "rootsForOwner",
  "children",
  "page",
  "walk",
  "path",
  "search",
  "parent",
  "navigate",
  "navigateHistory",
];

const PANEL_TREE_GROUP_SCHEMA = {
  oneOf: [
    {
      type: "object",
      properties: {
        kind: { const: "roots" },
        ownerUserId: { type: ["string", "null"] },
      },
      required: ["kind", "ownerUserId"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { kind: { const: "children" }, parentSlotId: { type: "string" } },
      required: ["kind", "parentSlotId"],
      additionalProperties: false,
    },
  ],
};

const PANEL_TREE_NODE_SCHEMA = {
  type: "object",
  description: "Bounded immutable panel-tree projection; use handle.observe() for live state.",
  properties: {
    slotId: { type: "string" },
    parentSlotId: { type: ["string", "null"] },
    ownerUserId: { type: ["string", "null"] },
    title: { type: "string" },
    createdAt: { type: "number" },
    childCount: { type: "number" },
    source: { type: "string" },
    kind: { enum: ["workspace", "browser"] },
    contextId: { type: "string" },
  },
  required: ["slotId", "parentSlotId", "ownerUserId", "title", "createdAt", "childCount"],
  additionalProperties: true,
};

const PANEL_HANDLE_SCHEMA = {
  type: "object",
  description:
    "Live panel handle. `id` is the durable panel-tree slot id; PanelHandle has no separate `slotId` field. Scalar fields are last-observed descriptors; methods include observe(), stateArgs, focus(), archive(), and CDP automation.",
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    source: { type: "string" },
    kind: { enum: ["workspace", "browser"] },
    parentId: { type: ["string", "null"] },
  },
  required: ["id", "title", "source", "kind", "parentId"],
  additionalProperties: true,
};

const PANEL_TREE_ENTRY_SCHEMA = {
  type: "object",
  properties: {
    node: PANEL_TREE_NODE_SCHEMA,
    handle: PANEL_HANDLE_SCHEMA,
  },
  required: ["node", "handle"],
  additionalProperties: false,
};

export const PANEL_TREE_METHOD_CATALOG = {
  self: {
    signature: "self(): PanelHandle",
    description: "Return a synchronous handle for the panel that owns this runtime.",
    argumentNames: [],
    argsSchema: { type: "array", maxItems: 0, prefixItems: [] },
  },
  get: {
    signature: 'get(id: string, kind?: "workspace" | "browser"): PanelHandle',
    description: "Return a synchronous handle for an exact panel slot id.",
    argumentNames: ["id", "kind"],
    argsSchema: {
      type: "array",
      prefixItems: [{ type: "string" }, { enum: ["workspace", "browser"] }],
      minItems: 1,
      maxItems: 2,
    },
  },
  rootOwners: {
    signature: "rootOwners(input?: PanelTreePageWindow): Promise<PanelRuntimeTreeRootOwnerPage>",
    description:
      "List visible root ownership bands for intentional cross-owner inspection. Iterate result.owners; the return value itself is not iterable.",
    argumentNames: ["input"],
    argsSchema: {
      type: "array",
      prefixItems: [
        {
          type: "object",
          properties: { cursor: { type: "string" }, limit: { type: "number" } },
          additionalProperties: false,
        },
      ],
      maxItems: 1,
    },
    returnsSchema: {
      type: "object",
      properties: {
        revision: { type: "number" },
        owners: {
          type: "array",
          items: {
            type: "object",
            properties: {
              ownerUserId: { type: ["string", "null"] },
              rootCount: { type: "number" },
            },
            required: ["ownerUserId", "rootCount"],
            additionalProperties: false,
          },
        },
        nextCursor: { type: ["string", "null"] },
      },
      required: ["revision", "owners", "nextCursor"],
      additionalProperties: false,
    },
  },
  roots: {
    signature: "roots(input?: PanelTreePageWindow): Promise<PanelRuntimeTreePage>",
    description:
      "Read one bounded root-panel page for the current verified human subject. Ownership is host-derived; no owner id is accepted.",
    argumentNames: ["input"],
    argsSchema: {
      type: "array",
      prefixItems: [
        {
          type: "object",
          properties: { cursor: { type: "string" }, limit: { type: "number" } },
          additionalProperties: false,
        },
      ],
      maxItems: 1,
    },
  },
  rootsForOwner: {
    signature:
      "rootsForOwner(ownerUserId: string | null, input?: PanelTreePageWindow): Promise<PanelRuntimeTreePage>",
    description:
      "Read one bounded root-panel page for an ownership band returned by rootOwners(). Cross-owner workspace visibility is unchanged.",
    argumentNames: ["ownerUserId", "input"],
    argsSchema: {
      type: "array",
      prefixItems: [
        { type: ["string", "null"], description: "ownerUserId from rootOwners().owners." },
        {
          type: "object",
          properties: { cursor: { type: "string" }, limit: { type: "number" } },
          additionalProperties: false,
        },
      ],
      minItems: 1,
      maxItems: 2,
    },
  },
  children: {
    signature:
      "children(parentSlotId: string, input?: PanelTreePageWindow): Promise<PanelRuntimeTreePage>",
    description:
      "Read one bounded child-panel page for a parent slot. This is the ergonomic child traversal; no group discriminator is needed.",
    argumentNames: ["parentSlotId", "input"],
    argsSchema: {
      type: "array",
      prefixItems: [
        { type: "string", description: "Exact parent panel slot id." },
        {
          type: "object",
          properties: { cursor: { type: "string" }, limit: { type: "number" } },
          additionalProperties: false,
        },
      ],
      minItems: 1,
      maxItems: 2,
    },
  },
  page: {
    signature: "page(input: PanelTreePageInput): Promise<PanelRuntimeTreePage>",
    description:
      "Advanced sibling-page primitive. Prefer roots(input?), rootsForOwner(ownerUserId, input?), or children(parentSlotId, input?). Direct calls require group: {kind:'roots', ownerUserId} or {kind:'children', parentSlotId}.",
    argumentNames: ["input"],
    argsSchema: {
      type: "array",
      prefixItems: [
        {
          type: "object",
          properties: {
            group: PANEL_TREE_GROUP_SCHEMA,
            cursor: { type: "string" },
            limit: { type: "number" },
          },
          required: ["group"],
          additionalProperties: false,
        },
      ],
      minItems: 1,
      maxItems: 1,
    },
    returnsSchema: {
      type: "object",
      properties: {
        revision: { type: "number" },
        group: PANEL_TREE_GROUP_SCHEMA,
        entries: { type: "array", items: PANEL_TREE_ENTRY_SCHEMA },
        nextCursor: { type: ["string", "null"] },
      },
      required: ["revision", "group", "entries", "nextCursor"],
      additionalProperties: false,
    },
  },
  walk: {
    signature:
      "walk(rootSlotId: string, options: { limit: number }): AsyncIterableIterator<PanelRuntimeTreeWalkEntry>",
    description:
      "Breadth-first async iterator over the descendants of rootSlotId (root excluded), yielding at most `limit` entries of { node, handle, depth }. It follows cursors itself and, when the tree revision changes mid-walk, restarts from the root without yielding a slot twice. Receiving `limit` entries means the subtree may hold more.",
    argumentNames: ["rootSlotId", "options"],
    argsSchema: {
      type: "array",
      prefixItems: [
        { type: "string", description: "Exact slot id of the subtree root." },
        {
          type: "object",
          properties: { limit: { type: "integer", minimum: 1 } },
          required: ["limit"],
          additionalProperties: false,
        },
      ],
      minItems: 2,
      maxItems: 2,
    },
  },
  path: {
    signature: "path(id: string): Promise<PanelRuntimeTreePath | null>",
    argumentNames: ["id"],
    argsSchema: { type: "array", prefixItems: [{ type: "string" }], minItems: 1, maxItems: 1 },
    returnsSchema: {
      type: "object",
      nullable: true,
      properties: {
        revision: { type: "number" },
        entries: { type: "array", items: PANEL_TREE_ENTRY_SCHEMA },
      },
      required: ["revision", "entries"],
      additionalProperties: false,
    },
  },
  search: {
    signature: "search(input: PanelTreeSearchInput): Promise<PanelRuntimeTreeSearchPage>",
    description:
      "Return a bounded search page. Read `result.hits` (not `result.entries`); each hit contains `entry.node`, `entry.handle`, and hydrated ancestor entries.",
    argumentNames: ["input"],
    argsSchema: {
      type: "array",
      prefixItems: [
        {
          type: "object",
          properties: {
            query: { type: "string" },
            cursor: { type: "string" },
            limit: { type: "number" },
          },
          required: ["query"],
          additionalProperties: false,
        },
      ],
      minItems: 1,
      maxItems: 1,
    },
    returnsSchema: {
      type: "object",
      properties: {
        revision: { type: "number" },
        hits: {
          type: "array",
          items: {
            type: "object",
            properties: {
              entry: PANEL_TREE_ENTRY_SCHEMA,
              ancestors: { type: "array", items: PANEL_TREE_ENTRY_SCHEMA },
              ancestorsTruncated: { type: "boolean" },
            },
            required: ["entry", "ancestors"],
            additionalProperties: false,
          },
        },
        nextCursor: { type: ["string", "null"] },
      },
      required: ["revision", "hits", "nextCursor"],
      additionalProperties: false,
    },
    examples: [
      {
        args: [{ query: "trello", limit: 20 }],
        note: "Destructure `{ hits }` from the result and map `hit.entry`; ordinary tree pages use `entries`, search pages use `hits`.",
      },
    ],
  },
  parent: {
    signature: "parent(id: string): PanelHandle | null",
    description: "Return the cached parent handle, or explicit null for a root panel.",
    argumentNames: ["id"],
    argsSchema: { type: "array", prefixItems: [{ type: "string" }], minItems: 1, maxItems: 1 },
  },
  navigate: {
    signature:
      "navigate(id: string, source: string, options?: PanelNavigateOptions): Promise<PanelObservation>",
    argumentNames: ["id", "source", "options"],
    argsSchema: {
      type: "array",
      prefixItems: [
        { type: "string", description: "Exact panel slot id." },
        { type: "string", description: "Workspace-relative source or browser URL." },
        {
          type: "object",
          properties: {
            contextId: { type: "string" },
            env: { type: "object", additionalProperties: { type: "string" } },
            ref: { type: "string" },
            stateArgs: { type: "object", additionalProperties: true },
            signal: {
              type: "object",
              description:
                "AbortSignal that cancels readiness observation after navigation commits.",
            },
          },
          additionalProperties: false,
        },
      ],
      minItems: 2,
      maxItems: 3,
    },
  },
  navigateHistory: {
    signature:
      "navigateHistory(id: string, delta: -1 | 1, options?: PanelWaitOptions): Promise<PanelObservation | null>",
    description: "Move an exact panel slot one step through its navigation history.",
    argumentNames: ["id", "delta", "options"],
    argsSchema: {
      type: "array",
      prefixItems: [
        { type: "string", description: "Exact panel slot id." },
        { enum: [-1, 1] },
        {
          type: "object",
          properties: {
            signal: {
              type: "object",
              description: "AbortSignal that cancels readiness observation.",
            },
          },
          additionalProperties: false,
        },
      ],
      minItems: 2,
      maxItems: 3,
    },
  },
};

/**
 * The full portable surface — every key `createHostedRuntime` returns. Entries
 * whose description differs per target (workspace / openPanel /
 * getPanelHandle / panelTree) carry a neutral default here; panel & worker
 * manifests override those five with target-specific wording.
 */
export const portableExports: Record<string, RuntimeSurfaceEntry> = {
  formatRpcFailure: valueEntry(
    "Format an RPC failure, including nested causes and aggregate members, for a text-only display boundary. Use the structured error value for programmatic handling."
  ),
  PanelOperationError: valueEntry(
    "Structured error class thrown by panel create, navigation, reload, rebuild, and readiness operations. Inspect its failure provenance instead of parsing message text."
  ),
  id: valueEntry(),
  contextId: valueEntry(),
  rpc: valueEntry(
    "Portable RPC client. `rpc.call(targetId, methodDescriptor, args, options?)` requires an `RpcMethod` descriptor object; the method argument is never a method-name string. Import `mainRpcMethods` from `@vibestudio/service-schemas/mainRpc` for host methods, or the userland receiver's exported descriptor table. Export a receiver contract module even for disposable receivers: derive its table with `createReceiverRpcMethods` from `@vibestudio/shared/rpcMethods`, using an explicit `Pick` of the actual receiver type and its public method names. Names alone do not define a checked contract. Pass the complete positional argument array, including `[]` for a zero-argument method. Calls, streams, and readable streams share this descriptor contract."
  ),
  fs: valueEntry(
    "Per-context filesystem sandbox. Paths are context-root-relative. The semantic workspace records managed mutations before projection; moves preserve file identity and copies mint a new identity with exact copy provenance. Tracked-to-scratch renames, managed empty-directory mkdir, and open with write flags are rejected. Scratch mkdir and utimes remain direct filesystem operations. Platform-excluded paths and paths outside reserved workspace source roots are local scratch."
  ),
  callMain: valueEntry('Call a `main` (server) service method: callMain("fs.readFile", path).'),
  getParent: valueEntry("Get the parent panel handle, or null when there is no parent."),
  getParentWithContract: valueEntry("Get the parent handle typed by a panel contract, or null."),
  doTargetId: valueEntry("Build a unified RPC target ID for a Durable Object reference."),
  createDurableObjectServiceClient: valueEntry(
    "Resolve a Durable Object-backed service and call it through unified RPC."
  ),
  gatewayConfig: valueEntry("Gateway base URL and bearer token for Vibestudio service routes."),
  gatewayFetch: valueEntry(
    "Gateway-origin fetch helper. It accepts relative paths and absolute URLs on the configured gateway origin, then authenticates that request; cross-origin targets are rejected. Use credentials.fetch for external egress."
  ),
  openExternal: callableEntry(
    "externalOpen",
    "openExternal",
    'Call `await openExternal(url, options?)` from the initialized panel, plain-worker, or eval runtime to open the system browser. A Durable Object can call the same receiver through its public RPC client after importing `mainRpcMethods` from `@vibestudio/service-schemas/mainRpc`: `this.rpc.call("main", mainRpcMethods["externalOpen.openExternal"], [url, options])`. The call owns the approval prompt and resumes after the user decides.'
  ),
  createPanelSlot: valueEntry(
    "Commit a workspace or browser panel slot and promptly return its durable handle without focusing or waiting for activation, build, or application boot. Server reconciliation owns code activation after commit and recovers it across transient failure or restart. Pass a stable operationId when a workflow may retry: the same operation then resolves to the same durable slot. The returned handle can be observed for current lifecycle state.",
    CREATE_PANEL_SLOT_SIGNATURE
  ),
  openPanel: valueEntry(
    "Create a workspace or browser panel and return its handle after application boot-ready. Readiness has no fixed wall-clock deadline; pass options.signal when the caller owns cancellation. A stable operationId makes retries address the same durable slot. On PanelOperationError, inspect failure.provenance.panelId. " +
      PANEL_HANDLE_AUTOMATION_GUIDE,
    OPEN_PANEL_SIGNATURE
  ),
  getPanelHandle: valueEntry("Get a handle to a panel by id."),
  workers: namespaceEntry(
    WORKERS_MEMBERS,
    "Worker discovery, lifecycle, and manifest-declared service resolution. Use create/list/destroy for regular worker instances; listSources() returns every launchable source with its real manifest entry point and Durable Object classes.",
    undefined,
    WORKERS_RUNTIME_METHOD_CATALOG
  ),
  workspaces: namespaceEntry(
    ["create", "receipt"],
    "Create workspaces from exact inspected template pins and reconcile durable receipts. Available to panels, workers, eval and connected websites under ordinary caller authorization. Creation returns no routing credentials or authority over the new workspace."
  ),
  workspace: namespaceEntry(
    WORKSPACE_MEMBERS,
    "Workspace configuration, projects, and semantic source operations. Use build.listUnits() for declared source/build readiness, workers.listSources() for launchable workers, and runtime.supervision.list() for exact live entities.",
    "workspace"
  ),
  credentials: namespaceEntry(
    CREDENTIALS_MEMBERS,
    "Typed credential lifecycle and credentialed network access. Use resolveCredential({ url }) for host-owned audience matching; an unbound URL returns null without UI. Inventory summaries do not replace the resolver's binding and use policy. Use openWebSocketScope({ url, credentialId }) to own one credentialed WebSocket request under the authenticated originating invocation; opening does not authorize credential use. Use store(input) to persist a URL-bound credential, fetch(url, init?, { credentialId? }?) for credentialed HTTP and a standard Response, hookForUrl(url, { credentialId? }?) for a bound fetch function, gitHttp({ credentialId?, gitIntent? }) for smart-HTTP, and forAudience(descriptor) for a credential-bound handle. The underlying RPC transport is internal."
  ),
  browserData: namespaceEntry(
    BROWSER_DATA_MEMBERS,
    "Typed access to the manifest-declared browser-data provider: detection, import, secret-free summaries, approved sensitive reads, mutation, and export.",
    undefined,
    browserDataRuntimeCatalog
  ),
  git: namespaceEntry(
    GIT_MEMBERS,
    "Typed external Git operations routed through the workspace's configured gitInterop provider. Import and pull create unpublished semantic candidates; only ordinary VCS integration and explicit publication advance protected main. Declarations carry logical credential names resolved by the host, while credential-free remotes are anonymous-first. Pull dry-runs use isolated temporary state and do not mutate managed Git, semantic state, or the remote.",
    "gitInterop",
    gitRuntimeCatalog
  ),
  vcs: namespaceEntry(VCS_MEMBERS, VCS_DESCRIPTION, "vcs", VCS_RUNTIME_ONLY_METHOD_CATALOG),
  gad: namespaceEntry(
    GAD_MEMBERS,
    "Typed access to the workspace's canonical Graph and Data store: parameterized SQL, trajectory/channel lineage, integrity diagnostics, provenance, and bounded channel-envelope paging.",
    undefined,
    { ...gadRuntimeCatalog, ...GAD_RUNTIME_ONLY_METHOD_CATALOG }
  ),
  images: namespaceEntry(
    [
      "generate",
      "getJob",
      "cancel",
      "retry",
      "forgetJob",
      "deleteArtDirection",
      "getAsset",
      "readAsset",
      "importAsset",
      "retain",
      "release",
      "putArtDirection",
      "getArtDirection",
      "getBytes",
      "wait",
    ],
    "Workspace image assets and durable generation jobs. generate({requestId,prompt,references?,artDirection?}) returns a job; wait(job.id) observes completion. Store the resulting immutable asset reference in application state. GeneratedImage from @workspace/react displays assets in running panels without rebuilding. getBytes performs authenticated reads for custom renderers. retain/release manage application ownership; art direction versions provide reusable style briefs and reference assets."
  ),
  missions: namespaceEntry(
    [
      "overview",
      "list",
      "get",
      "getDefault",
      "listRuns",
      "getRun",
      "launch",
      "provisionDefault",
      "edit",
      "runNow",
      "cancel",
      "pause",
      "resume",
      "retire",
    ],
    "Durable automations (vibestudio.missions.v1). launch({name, charter}) and edit(missionId, {name?, charter?}) compile the charter's authority plan as the calling author, then call the missions controller, which verifies that plan; never compile by hand. edit recompiles only when the execution changes or a seeded default is customized. overview/list/get/listRuns/getRun read the ledger; runNow/cancel/pause/resume/retire control one automation. Agents launching work for themselves use the launch_automation tool instead."
  ),
  blobstore: namespaceEntry(
    BLOBSTORE_MEMBERS,
    'Per-workspace content-addressable blob store: putText/putBase64 store, getText/readText/getRange/getRangeBytes/getBase64 fetch, grep searches; returns a sha256 digest. readText is a portable alias of getText and both return string | null. Runtime-only putBytes(Uint8Array | ArrayBuffer) and getBytes(digest) losslessly bridge the wire\'s base64 representation; MIME metadata is not stored. Persist large artifacts/screenshots and return the digest. Immutable file trees: putPathTree({ "a/b.txt": text | bytes | { digest } }, opts?) stores a nested tree in one call; putTree/getTree store and read single tree objects, listTree/readFileAtTree walk a tree hash, diffTrees compares two trees.',
    "blobstore"
  ),
  webhooks: namespaceEntry(
    WEBHOOKS_MEMBERS,
    "Ergonomic owner-scoped webhook lifecycle, identical in panels, workers, DOs, and agent eval: createSubscription(request), listSubscriptions(), rotateSecret(subscriptionId, secret?), and revokeSubscription(subscriptionId). Each subscription has an explicit maxBodyBytes budget: relay defaults to its 1,500,000-byte transport ceiling, while direct defaults to the operator-configured host ceiling (16 MiB by default). Delivery events currently include rawBodyBase64, so the host ceiling also bounds that in-memory expansion. Agent eval delegates ownership and target-source checks to its host-verified owning runtime. Secrets are redacted from listings.",
    // Internal schema source only. The catalog projects these method schemas as
    // runtime:webhooks.* entries; the raw transport remains non-agent-facing.
    "webhookIngress",
    webhooksRuntimeCatalog
  ),
  extensions: namespaceEntry(EXTENSIONS_MEMBERS, undefined, "extensions"),
  templates: namespaceEntry(
    ["inspect", "inspectAuthoring", "authoringParts", "publishAuthoring"],
    "Exact source inspection and publication through the admitted template receiver.",
    undefined,
    templatesRuntimeCatalog
  ),
  notifications: namespaceEntry(NOTIFICATIONS_MEMBERS, undefined, "notification"),
  problemReports: namespaceEntry(
    Object.keys(problemReportsMethods),
    "Local problem reports owned by the calling user. create a manual draft, appendNarrative/patchNarrative with host-assigned section IDs and caller-derived authorship, prepare to freeze sanitized bytes (returns { revision, submissionId, digest, bytes }), and send(reportId, revision, digest) to request upload; agent callers wait for a one-time human approval of that exact report. Consent and other trusted-human controls reject agent callers.",
    "problemReports"
  ),
  panelTree: namespaceEntry(PANEL_TREE_MEMBERS, undefined, undefined, PANEL_TREE_METHOD_CATALOG),
  services: valueEntry(
    "Portable raw service namespace: services.<svc>.<method>(...) is always the server service <svc>, dispatched through the caller-scoped main service boundary, even when a runtime binding shares the name (services.blobstore is the raw blobstore service, the blobstore binding is the curated client). The client contract is shared by panels, workers, Durable Objects, and eval; Durable Objects bind clients to their own instance RPC."
  ),
  hosts: valueEntry("Portable owner-scoped attached-host access for development sessions."),
  runtime: namespaceEntry(
    Object.keys(runtimeMethods),
    "Portable typed runtime lifecycle and supervision client for the current workspace context.",
    "runtime"
  ),
};

/** The portable key set (= Object.keys of what createHostedRuntime returns). */
export const PORTABLE_KEYS = Object.keys(portableExports);

/** Entries whose description differs per target (panel/worker override). */
export const PER_TARGET_DESCRIPTION_KEYS = [
  "workspace",
  "createPanelSlot",
  "openPanel",
  "getPanelHandle",
  "panelTree",
] as const;
