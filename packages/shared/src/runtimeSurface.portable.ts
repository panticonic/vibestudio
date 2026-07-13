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

import { namespaceEntry, valueEntry, type RuntimeSurfaceEntry } from "./runtimeSurface.js";
import gadRuntimeCatalog from "./generated/gadRuntimeCatalog.json";
import { blobstoreMethods } from "./serviceSchemas/blobstore.js";
import { GAD_RUNTIME_METHOD_NAMES } from "./gadRuntimeMethods.js";
import { gitInteropMethods } from "./serviceSchemas/gitInterop.js";

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

export const WORKSPACE_MEMBERS = [
  "list",
  "getActive",
  "getActiveEntry",
  "getConfig",
  "create",
  "delete",
  "setInitPanels",
  "setConfigField",
  "switchTo",
  "sourceTree",
  "findUnitForPath",
  "units",
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

export const GIT_MEMBERS = Object.keys(gitInteropMethods);

export const VCS_MEMBERS = [
  "edit",
  "commit",
  "discardEdits",
  "readFile",
  "listFiles",
  "revert",
  "status",
  "log",
  "diff",
  "resolveHead",
  "workspaceViewWithRepoAt",
  "merge",
  "abortMerge",
  "pendingMerge",
  "push",
  "pushStatus",
  "previewBuild",
  "commitEdits",
  "fileHistory",
  "commitAncestors",
  "editsByActor",
  "editsByTurn",
  "editsByInvocation",
  "forkRepo",
  "contextStatus",
  "rebaseContext",
  "recall",
];

export const VCS_DESCRIPTION =
  "Workspace GAD VCS (edit → commit → push): vcs.edit records tracked WORKING edits (no commit/build); vcs.commit folds them into a messaged snapshot per repo; push is the only main-advance (fast-forward-only, build-gated — diverged pushes reject, reconcile with vcs.merge). vcs.previewBuild builds working content on demand; status/fileHistory/commitEdits expose provenance.";

export const GAD_MEMBERS = [...GAD_RUNTIME_METHOD_NAMES];

export const BLOBSTORE_MEMBERS = [...Object.keys(blobstoreMethods), "putBytes", "readText"];

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
  id: valueEntry(),
  contextId: valueEntry(),
  rpc: valueEntry("Portable RPC client (the full createRpcClient)."),
  fs: valueEntry(
    "Per-context filesystem sandbox. Paths are context-root-relative. For valid workspace-repo paths, writeFile, appendFile, truncate, chmod, unlink/rmdir/rm, copyFile destinations, and supported renames into or within repos route through GAD working edits; tracked-to-scratch renames and open with write flags are rejected. mkdir and utimes remain direct filesystem operations. Platform-ignored paths and paths outside reserved workspace source roots are local scratch.",
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
  openPanel: valueEntry("Open a workspace or browser panel and return a PanelHandle."),
  listPanels: valueEntry("List open panels."),
  getPanelHandle: valueEntry("Get a handle to a panel by id."),
  workers: namespaceEntry(
    WORKERS_MEMBERS,
    "Worker discovery, lifecycle, and manifest-declared service resolution. Use create/list/destroy for regular worker instances; listSources() returns every launchable source with its real manifest entry point and Durable Object classes."
  ),
  workspace: namespaceEntry(WORKSPACE_MEMBERS),
  credentials: namespaceEntry(
    CREDENTIALS_MEMBERS,
    "Typed credential lifecycle and credentialed network access. Use store(input) to persist a URL-bound credential, fetch(url, init?, { credentialId? }?) for credentialed HTTP and a standard Response, hookForUrl(url, { credentialId? }?) for a bound fetch function, gitHttp({ credentialId?, gitIntent? }) for smart-HTTP, and forAudience(descriptor) for a credential-bound handle. The underlying RPC transport is internal."
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
    "Per-workspace content-addressable blob store: putText/putBase64 store, getText/readText/getRange/getRangeBytes/getBase64 fetch, grep searches; returns a sha256 digest. readText is a portable alias of getText and both return string | null. Runtime-only putBytes(Uint8Array | ArrayBuffer) losslessly encodes bytes through putBase64; MIME metadata is not stored. Persist large artifacts/screenshots and return the digest. Immutable file trees: putTree/getTree store and read tree objects, listTree/readFileAtTree walk a tree hash, diffTrees compares two trees.",
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
