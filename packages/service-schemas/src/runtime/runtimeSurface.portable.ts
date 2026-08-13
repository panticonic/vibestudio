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
 * Includes `callMain` + `parent`/`getParent`/`getParentWithContract` (portable as
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
import gadRuntimeCatalog from "./generated/gadRuntimeCatalog.json";
import { GAD_RUNTIME_METHOD_NAMES } from "@vibestudio/shared/gadRuntimeMethods";
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
  "Use `const session = await handle.cdp.session(); const page = session.page` for multi-step automation. The session records the immutable panel generation; after rebuild/navigation call `await session.refresh()` and use the returned session instead of replaying an uncertain action. For a one-off read, `await handle.cdp.page()` remains available and returns a Promise, not a page proxy. " +
  'For a one-call host image use `await handle.cdp.screenshot({ format: "png" })`. ' +
  "For host-captured logs since panel creation use `await handle.cdp.consoleHistory()` (live page console events are separate).";

// --- shared namespace member arrays (single source of truth) ---
export const WORKERS_MEMBERS = [
  "listSources",
  "create",
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
const WORKERS_RUNTIME_METHOD_CATALOG = {
  listSources: {
    signature: "listSources(): Promise<WorkerSourceInfo[]>",
    description:
      "List every launchable worker source with its manifest entry point and Durable Object classes. Use this to inspect runnable units; do not guess index.ts or class names.",
    argsSchema: { type: "array", maxItems: 0, prefixItems: [] },
    examples: [{ args: [] }],
  },
  create: {
    signature: "create(source: string, options?: WorkerCreateOptions): Promise<WorkerEntityHandle>",
    description:
      "Launch a regular worker through the canonical entity lifecycle in the caller's current semantic workspace context. Pass contextId only to deliberately target another context; key, env, stateArgs, and ref are optional.",
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
  list: {
    signature: "list(): Promise<WorkerEntityInfo[]>",
    description: "List live regular-worker instances and their canonical entity handles.",
    argsSchema: { type: "array", maxItems: 0 },
    examples: [{ args: [] }],
  },
  destroy: {
    signature: "destroy(entity: RuntimeEntityReference): Promise<void>",
    description:
      "Retire a runtime entity through the canonical lifecycle. Pass the handle from workers.create, a disposable target from workers.resolveDurableObject, or either canonical id. Resolving a shared service does not transfer ownership; retire only entities whose lifecycle you own.",
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
    argsSchema: { type: "array", minItems: 1, maxItems: 1 },
    examples: [{ args: [{ source: "workers/notes", className: "NotesDO", objectKey: "scratch" }] }],
  },
  restoreStorageBackup: {
    signature:
      "restoreStorageBackup(target: DurableObjectStorageTarget, operationId: string, intent: string): Promise<{ operationId: string }>",
    description:
      "Back up the current files and restore a verified named backup to the same exact target.",
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
    argsSchema: { type: "array", maxItems: 0, prefixItems: [] },
    examples: [{ args: [] }],
  },
  resolveService: {
    signature:
      "resolveService(query: string, objectKey?: string | null): Promise<ResolvedWorkspaceService>",
    description:
      "Resolve a manifest-declared service by name or protocol in the caller's exact semantic context. Installed callers must also declare the exact workspace-service:<name> capability in package.json; resolution never grants authority by itself.",
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
    examples: [{ args: ["example.notes.v1"] }],
  },
  resolveDurableObject: {
    signature:
      "resolveDurableObject(source: string, className: string, objectKey: string): Promise<ResolvedDurableObjectTarget>",
    description:
      "Resolve and activate a concrete Durable Object target when no workspace service declaration exists. Prefer resolveService whenever a declared service is available. For a disposable object whose lifecycle you own, pass the returned target directly to workers.destroy after clearing any test data.",
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
  "store",
  "connect",
  "configureClient",
  "requestCredentialInput",
  "getClientConfigStatus",
  "deleteClientConfig",
  "listStoredCredentials",
  "summarizeStoredCredentials",
  "inspectStoredCredentials",
  "revokeCredential",
  "resolveCredential",
  "fetch",
  "hookForUrl",
  "gitHttp",
  "forAudience",
];

export const BROWSER_DATA_MEMBERS = [
  "getBrowserEnvironment",
  "listImportHosts",
  "listImportSources",
  "previewImport",
  "startImport",
  "startSensitiveImport",
  "cancelImport",
  "getImportJob",
  "listImportJobs",
  "listOpenTabs",
  "openTabsAsPanels",
  "getSitePreferences",
  "setSiteZoom",
  "getBookmarks",
  "addBookmark",
  "updateBookmark",
  "deleteBookmark",
  "moveBookmark",
  "searchBookmarks",
  "getHistory",
  "deleteHistoryEntry",
  "deleteHistoryRange",
  "clearAllHistory",
  "searchHistory",
  "searchHistoryForAutocomplete",
  "recordHistoryVisit",
  "updateHistoryTitle",
  "getSearchEngines",
  "setDefaultEngine",
  "listDownloads",
  "listDownloadRecords",
  "upsertDownloadRecord",
  "pauseDownload",
  "resumeDownload",
  "cancelDownload",
  "openDownload",
  "revealDownload",
  "putPageFavicon",
  "getPageFavicon",
  "exportBookmarks",
];

export const GIT_MEMBERS = [...GIT_INTEROP_METHOD_NAMES];

export const VCS_MEMBERS = [...VCS_METHOD_NAMES];

export const VCS_DESCRIPTION =
  "Simple semantic version control: exact event/application state, expressive edit/move/copy records, incremental local integration, whole-chain commit/discard, directly walkable provenance, and atomic external-snapshot acknowledgements containing the committed event/application/work-unit/repository/snapshot tuple.";

export const GAD_MEMBERS = [...GAD_RUNTIME_METHOD_NAMES];

export const BLOBSTORE_MEMBERS = [...BLOBSTORE_METHOD_NAMES, "putBytes", "getBytes", "readText"];

export const WEBHOOKS_MEMBERS = [
  "createSubscription",
  "listSubscriptions",
  "revokeSubscription",
  "rotateSecret",
];

export const EXTENSIONS_MEMBERS = ["use", "invoke", "invokeProvider", "on"];
export const NOTIFICATIONS_MEMBERS = ["show", "dismiss"];
export const PANEL_TREE_MEMBERS = [
  "self",
  "get",
  "rootOwners",
  "roots",
  "rootsForOwner",
  "children",
  "page",
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
    "Live panel handle. Scalar fields are last-observed descriptors; methods include observe(), stateArgs, focus(), close(), and CDP automation.",
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
    argsSchema: { type: "array", maxItems: 0, prefixItems: [] },
  },
  get: {
    signature: 'get(id: string, kind?: "workspace" | "browser"): PanelHandle',
    description: "Return a synchronous handle for an exact panel slot id.",
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
  path: {
    signature: "path(id: string): Promise<PanelRuntimeTreePath | null>",
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
      "Return a bounded page whose hits contain entry.node and entry.handle plus hydrated ancestor entries.",
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
  },
  parent: {
    signature: "parent(id: string): PanelHandle | null",
    description: "Return the cached parent handle, or explicit null for a root panel.",
    argsSchema: { type: "array", prefixItems: [{ type: "string" }], minItems: 1, maxItems: 1 },
  },
  navigate: {
    signature:
      "navigate(id: string, source: string, options?: PanelNavigateOptions): Promise<PanelObservation>",
    argsSchema: {
      type: "array",
      prefixItems: [{ type: "string" }, { type: "string" }, { type: "object" }],
      minItems: 2,
      maxItems: 3,
    },
  },
  navigateHistory: {
    signature:
      "navigateHistory(id: string, delta: -1 | 1, options?: PanelWaitOptions): Promise<PanelObservation | null>",
    description: "Move an exact panel slot one step through its navigation history.",
    argsSchema: {
      type: "array",
      prefixItems: [{ type: "string" }, { enum: [-1, 1] }, { type: "object" }],
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
  PanelOperationError: valueEntry(
    "Structured error class thrown by panel create, navigation, reload, rebuild, and readiness operations. Inspect its failure provenance instead of parsing message text."
  ),
  id: valueEntry(),
  contextId: valueEntry(),
  rpc: valueEntry("Portable RPC client (the full createRpcClient)."),
  fs: valueEntry(
    "Per-context filesystem sandbox. Paths are context-root-relative. The semantic workspace records managed mutations before projection; moves preserve file identity and copies mint a new identity with exact copy provenance. Tracked-to-scratch renames, managed empty-directory mkdir, and open with write flags are rejected. Scratch mkdir and utimes remain direct filesystem operations. Platform-excluded paths and paths outside reserved workspace source roots are local scratch."
  ),
  callMain: valueEntry('Call a `main` (server) service method: callMain("fs.readFile", path).'),
  parent: valueEntry("This runtime's parent panel handle (a no-panel handle when there is none)."),
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
    "Call `await openExternal(url, options?)` from `@workspace/runtime` in server-side eval, panel/client eval, worker, or Durable Object code to open the system browser. The call itself owns the approval prompt and resumes after the user decides."
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
  workspace: namespaceEntry(
    WORKSPACE_MEMBERS,
    "Workspace configuration, projects, and semantic source operations. Use build.listUnits() for declared source/build readiness, workers.listSources() for launchable workers, and runtime.supervision.list() for exact live entities.",
    "workspace"
  ),
  credentials: namespaceEntry(
    CREDENTIALS_MEMBERS,
    "Typed credential lifecycle and credentialed network access. Use store(input) to persist a URL-bound credential, fetch(url, init?, { credentialId? }?) for credentialed HTTP and a standard Response, hookForUrl(url, { credentialId? }?) for a bound fetch function, gitHttp({ credentialId?, gitIntent? }) for smart-HTTP, and forAudience(descriptor) for a credential-bound handle. The underlying RPC transport is internal."
  ),
  browserData: namespaceEntry(
    BROWSER_DATA_MEMBERS,
    "Typed access to the manifest-declared browser-data provider: detection, import, secret-free summaries, approved sensitive reads, mutation, and export."
  ),
  git: namespaceEntry(
    GIT_MEMBERS,
    "Typed external Git operations routed through the workspace's configured gitInterop provider. Import and pull create unpublished semantic candidates; only ordinary VCS integration and explicit publication advance protected main. Declarations carry logical credential names resolved by the host, while credential-free remotes are anonymous-first. Pull dry-runs use isolated temporary state and do not mutate managed Git, semantic state, or the remote.",
    "gitInterop"
  ),
  vcs: namespaceEntry(VCS_MEMBERS, VCS_DESCRIPTION, "vcs"),
  gad: namespaceEntry(
    GAD_MEMBERS,
    "Typed access to the workspace's canonical Graph and Data store: parameterized SQL, trajectory/channel lineage, integrity diagnostics, provenance, and bounded channel-envelope paging.",
    undefined,
    gadRuntimeCatalog
  ),
  blobstore: namespaceEntry(
    BLOBSTORE_MEMBERS,
    "Per-workspace content-addressable blob store: putText/putBase64 store, getText/readText/getRange/getRangeBytes/getBase64 fetch, grep searches; returns a sha256 digest. readText is a portable alias of getText and both return string | null. Runtime-only putBytes(Uint8Array | ArrayBuffer) and getBytes(digest) losslessly bridge the wire's base64 representation; MIME metadata is not stored. Persist large artifacts/screenshots and return the digest. Immutable file trees: putTree/getTree store and read tree objects, listTree/readFileAtTree walk a tree hash, diffTrees compares two trees.",
    "blobstore"
  ),
  webhooks: namespaceEntry(
    WEBHOOKS_MEMBERS,
    "Ergonomic owner-scoped webhook lifecycle, identical in panels, workers, DOs, and agent eval: createSubscription(request), listSubscriptions(), rotateSecret(subscriptionId, secret?), and revokeSubscription(subscriptionId). Each subscription has an explicit maxBodyBytes budget: relay defaults to its 1,500,000-byte transport ceiling, while direct defaults to the operator-configured host ceiling (16 MiB by default). Delivery events currently include rawBodyBase64, so the host ceiling also bounds that in-memory expansion. Agent eval delegates ownership and target-source checks to its host-verified owning runtime. Secrets are redacted from listings.",
    // Internal schema source only. The catalog projects these method schemas as
    // runtime:webhooks.* entries; the raw transport remains non-agent-facing.
    "webhookIngress"
  ),
  extensions: namespaceEntry(EXTENSIONS_MEMBERS, undefined, "extensions"),
  notifications: namespaceEntry(NOTIFICATIONS_MEMBERS, undefined, "notification"),
  panelTree: namespaceEntry(PANEL_TREE_MEMBERS, undefined, undefined, PANEL_TREE_METHOD_CATALOG),
  services: valueEntry(
    "Portable dynamic service namespace. Rich runtime clients are available by name; other services dispatch through the caller-scoped main service boundary. The same client is available in panels, workers, Durable Objects, and eval."
  ),
  hosts: valueEntry("Portable owner-scoped attached-host access for development sessions."),
  runtime: valueEntry(
    "Portable typed runtime lifecycle and supervision client for the current workspace context."
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
