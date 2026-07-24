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
 * the old `requestApproval`/`revokeApproval`/`listApprovals` aliases (use
 * `approvals.*`) — both removed everywhere.
 */

import {
  namespaceEntry,
  valueEntry,
  type RuntimeSurfaceEntry,
} from "@vibestudio/shared/runtimeSurface";
import gadRuntimeCatalog from "./generated/gadRuntimeCatalog.json";
import { blobstoreMethods } from "../blobstore.js";
import { GAD_RUNTIME_METHOD_NAMES } from "@vibestudio/shared/gadRuntimeMethods";
import { gitInteropMethods } from "../gitInterop.js";
import { vcsMethods } from "../vcs.js";
import { workspaceMethods } from "../workspace.js";

// --- shared namespace member arrays (single source of truth) ---
export const WORKERS_MEMBERS = [
  "listSources",
  "create",
  "list",
  "destroy",
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
  ...new Set(Object.keys(workspaceMethods).map((method) => method.split(".")[0]!)),
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
  "getPasswords",
  "getPasswordForSite",
  "addPassword",
  "updatePassword",
  "deletePassword",
  "updatePasswordLastUsed",
  "addNeverSavePassword",
  "isNeverSavePassword",
  "getNeverSavePasswordOrigins",
  "removeNeverSavePassword",
  "getFormFillSuggestions",
  "addFormFillValue",
  "updateFormFillValue",
  "markFormFillValueUsed",
  "deleteFormFillValue",
  "clearFormFillValues",
  "getSearchEngines",
  "setDefaultEngine",
  "applyCookieMutations",
  "getCookieSnapshot",
  "getCookiesForOrigin",
  "clearCookiesForOrigin",
  "clearAllCookies",
  "endBrowserSession",
  "getCookieSiteSummary",
  "flushCookieProjection",
  "getCookieProjectionDiagnostics",
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
  "exportPasswords",
  "exportCookies",
];

export const GIT_MEMBERS = Object.keys(gitInteropMethods);

export const VCS_MEMBERS = Object.keys(vcsMethods);

export const VCS_DESCRIPTION =
  "Simple semantic version control: exact event/application state, expressive edit/move/copy records, incremental local integration, whole-chain commit/discard, and directly walkable provenance.";

export const GAD_MEMBERS = [...GAD_RUNTIME_METHOD_NAMES];

export const BLOBSTORE_MEMBERS = [
  ...Object.keys(blobstoreMethods),
  "putBytes",
  "getBytes",
  "readText",
];

export const WEBHOOKS_MEMBERS = [
  "createSubscription",
  "listSubscriptions",
  "revokeSubscription",
  "rotateSecret",
];

export const EXTENSIONS_MEMBERS = ["use", "invoke", "invokeProvider", "on", "list", "reload"];
export const APPROVALS_MEMBERS = ["request", "revoke", "list"];
export const NOTIFICATIONS_MEMBERS = ["show", "dismiss"];
export const PANEL_TREE_MEMBERS = [
  "self",
  "get",
  "list",
  "roots",
  "children",
  "parent",
  "navigate",
];

/**
 * The full portable surface — every key `createHostedRuntime` returns. Entries
 * whose description differs per target (workspace / openPanel / listPanels /
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
    "Per-context filesystem sandbox. Paths are context-root-relative. The semantic workspace records managed mutations before projection; moves preserve file identity and copies mint a new identity with exact copy provenance. Tracked-to-scratch renames, managed empty-directory mkdir, and open with write flags are rejected. Scratch mkdir and utimes remain direct filesystem operations. Platform-excluded paths and paths outside reserved workspace source roots are local scratch.",
    "fs"
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
    "Fetch helper that prefixes gateway-relative paths and adds Authorization: Bearer."
  ),
  openExternal: valueEntry(),
  openPanel: valueEntry(
    "Open a workspace or browser panel and return a PanelHandle only after application boot-ready."
  ),
  listPanels: valueEntry("List open panels."),
  getPanelHandle: valueEntry("Get a handle to a panel by id."),
  workers: namespaceEntry(
    WORKERS_MEMBERS,
    "Worker discovery, lifecycle, and manifest-declared service resolution. Use create/list/destroy for regular worker instances; listSources() returns every launchable source with its real manifest entry point and Durable Object classes.",
    undefined,
    WORKERS_RUNTIME_METHOD_CATALOG
  ),
  workspace: namespaceEntry(
    WORKSPACE_MEMBERS,
    "Workspace configuration, registered-unit/build-health, projects, and semantic source operations. workspace.units.list() reports registered units and their build state; it is not the catalog of launchable worker types. Use workers.listSources() for launchable workers and workers.list() for running worker instances.",
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
    "Typed external Git operations routed through the workspace's configured gitInterop provider.",
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
    "Ergonomic owner-scoped webhook lifecycle, identical in panels, workers, DOs, and agent eval: createSubscription(request), listSubscriptions(), rotateSecret(subscriptionId, secret?), and revokeSubscription(subscriptionId). Agent eval delegates ownership and target-source checks to its host-verified owning runtime. Secrets are redacted from listings.",
    // Internal schema source only. The catalog projects these method schemas as
    // runtime:webhooks.* entries; the raw transport remains non-agent-facing.
    "webhookIngress"
  ),
  extensions: namespaceEntry(EXTENSIONS_MEMBERS, undefined, "extensions"),
  approvals: namespaceEntry(APPROVALS_MEMBERS),
  notifications: namespaceEntry(NOTIFICATIONS_MEMBERS, undefined, "notification"),
  panelTree: namespaceEntry(PANEL_TREE_MEMBERS),
};

/** The portable key set (= Object.keys of what createHostedRuntime returns). */
export const PORTABLE_KEYS = Object.keys(portableExports);

/** The five entries whose description differs per target (panel/worker override). */
export const PER_TARGET_DESCRIPTION_KEYS = [
  "workspace",
  "openPanel",
  "listPanels",
  "getPanelHandle",
  "panelTree",
] as const;
