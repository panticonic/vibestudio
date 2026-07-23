# Worker Runtime API

Credentials are URL-bound and may only be used through host-mediated egress.

## Worker Runtime Surface

<!-- BEGIN GENERATED: worker-runtime-surface -->
Generated from `runtimeSurface.worker.ts`. Use `await help()` at runtime for the live surface.

| Export | Kind | Members | Description |
|--------|------|---------|-------------|
| `id` | value |  |  |
| `contextId` | value |  |  |
| `rpc` | value |  | Portable RPC client (the full createRpcClient). |
| `fs` | value |  | Per-context filesystem sandbox. Paths are context-root-relative. The semantic workspace records managed mutations before projection; moves preserve file identity and copies mint a new identity with exact copy provenance. Tracked-to-scratch renames, managed empty-directory mkdir, and open with write flags are rejected. Scratch mkdir and utimes remain direct filesystem operations. Platform-excluded paths and paths outside reserved workspace source roots are local scratch. |
| `callMain` | value |  | Call a `main` (server) service method: callMain("fs.readFile", path). |
| `parent` | value |  | This runtime's parent panel handle (a no-panel handle when there is none). |
| `getParent` | value |  | Get the parent panel handle, or null when there is no parent. |
| `getParentWithContract` | value |  | Get the parent handle typed by a panel contract, or null. |
| `doTargetId` | value |  | Build a unified RPC target ID for a Durable Object reference. |
| `createDurableObjectServiceClient` | value |  | Resolve a Durable Object-backed service and call it through unified RPC. |
| `gatewayConfig` | value |  | Gateway base URL and bearer token for Vibestudio service routes. |
| `gatewayFetch` | value |  | Fetch helper that prefixes gateway-relative paths and adds Authorization: Bearer. |
| `openExternal` | value |  |  |
| `workers` | namespace | `listSources`, `create`, `list`, `destroy`, `listServices`, `resolveService`, `resolveDurableObject`, `durableObjectService` | Worker discovery, lifecycle, and manifest-declared service resolution. Use create/list/destroy for regular worker instances; listSources() returns every launchable source with its real manifest entry point and Durable Object classes. |
| `credentials` | namespace | `store`, `connect`, `configureClient`, `requestCredentialInput`, `getClientConfigStatus`, `deleteClientConfig`, `listStoredCredentials`, `inspectStoredCredentials`, `revokeCredential`, `resolveCredential`, `fetch`, `hookForUrl`, `gitHttp`, `forAudience` | Typed credential lifecycle and credentialed network access. Use store(input) to persist a URL-bound credential, fetch(url, init?, { credentialId? }?) for credentialed HTTP and a standard Response, hookForUrl(url, { credentialId? }?) for a bound fetch function, gitHttp({ credentialId?, gitIntent? }) for smart-HTTP, and forAudience(descriptor) for a credential-bound handle. The underlying RPC transport is internal. |
| `browserData` | namespace | `detectBrowsers`, `getOpenTabs`, `openTabsAsPanels`, `startImport`, `getImportHistory`, `getProfileImportState`, `previewImport`, `getCookieDomains`, `getHistoryDomains`, `getPasswordOrigins`, `getAutofillFieldNames`, `getDomainReadiness`, `getAutocompleteDebug`, `getBookmarks`, `addBookmark`, `updateBookmark`, `deleteBookmark`, `moveBookmark`, `searchBookmarks`, `getHistory`, `deleteHistoryEntry`, `deleteHistoryRange`, `clearAllHistory`, `searchHistory`, `searchHistoryForAutocomplete`, `recordHistoryVisit`, `updateHistoryTitle`, `getPasswords`, `getPasswordForSite`, `addPassword`, `updatePassword`, `deletePassword`, `updatePasswordLastUsed`, `addNeverSavePassword`, `isNeverSavePassword`, `getNeverSavePasswordOrigins`, `removeNeverSavePassword`, `getAutofillSuggestions`, `getSearchEngines`, `setDefaultEngine`, `getPermissions`, `setPermission`, `exportBookmarks`, `exportPasswords`, `exportCookies`, `exportAll`, `getCookies`, `deleteCookie`, `clearCookies` | Typed access to the manifest-declared browser-data provider: detection, import, secret-free summaries, approved sensitive reads, mutation, and export. |
| `git` | namespace | `setSharedRemote`, `removeSharedRemote`, `setUpstream`, `removeUpstream`, `detachUpstream`, `setAutoPush`, `upstreamStatus`, `pushUpstream`, `pullUpstream`, `publishRepo`, `createDisposableRemote`, `publishToDisposableRemote`, `pushDisposableRemote`, `inspectDisposableRemote`, `removeDisposableRemote`, `commitMapping`, `importProject`, `completeWorkspaceDependencies` | Typed external Git operations routed through the workspace's configured gitInterop provider. |
| `vcs` | namespace | `edit`, `move`, `copy`, `integrate`, `revert`, `commit`, `discard`, `importSnapshot`, `push`, `status`, `compare`, `inspect`, `neighbors`, `history`, `blame`, `resolveRepository`, `readFile`, `listFiles` | Simple semantic version control: exact event/application state, expressive edit/move/copy records, incremental local integration, whole-chain commit/discard, and directly walkable provenance. |
| `gad` | namespace | `rawSql`, `query`, `status`, `ensureBlob`, `listUserNotificationsForMe`, `acknowledgeUserNotification`, `putUserNotification`, `deleteUserNotification`, `getTrajectoryBranchHead`, `listTrajectoryEvents`, `appendChannelEnvelope`, `appendChannelEnvelopeWithRegistryMutation`, `listMessageTypes`, `getMessageType`, `getChannelEnvelope`, `getTrajectoryForEnvelope`, `listPublishedEnvelopesForTrajectory`, `getEnvelopesForTrajectory`, `getPublishedArtifactsForTurn`, `getPrivateLineageForPublishedEnvelope`, `getDownstreamConsumers`, `readChannelEnvelopes`, `inspectChannelEnvelopes`, `listStoredValueRefs`, `inspectStorageDiagnostics`, `inspectPublicationIntegrity`, `inspectTurnState`, `inspectInvocationState`, `inspectChannelRoster`, `inspectAgentHealth`, `validateGadHashes`, `clearDirtyAfterValidation`, `checkGadIntegrity`, `rebuildTrajectoryProjections` | Typed access to the workspace's canonical Graph and Data store: parameterized SQL, trajectory/channel lineage, integrity diagnostics, provenance, and bounded channel-envelope paging. |
| `blobstore` | namespace | `has`, `stat`, `putText`, `getText`, `getRange`, `getRangeBytes`, `grep`, `putBase64`, `getBase64`, `putTree`, `getTree`, `listTree`, `readFileAtTree`, `diffTrees`, `materializeTree`, `delete`, `list`, `putBytes`, `getBytes`, `readText` | Per-workspace content-addressable blob store: putText/putBase64 store, getText/readText/getRange/getRangeBytes/getBase64 fetch, grep searches; returns a sha256 digest. readText is a portable alias of getText and both return string \| null. Runtime-only putBytes(Uint8Array \| ArrayBuffer) and getBytes(digest) losslessly bridge the wire's base64 representation; MIME metadata is not stored. Persist large artifacts/screenshots and return the digest. Immutable file trees: putTree/getTree store and read tree objects, listTree/readFileAtTree walk a tree hash, diffTrees compares two trees. |
| `webhooks` | namespace | `createSubscription`, `listSubscriptions`, `revokeSubscription`, `rotateSecret` | Ergonomic owner-scoped webhook lifecycle, identical in panels, workers, DOs, and agent eval: createSubscription(request), listSubscriptions(), rotateSecret(subscriptionId, secret?), and revokeSubscription(subscriptionId). Agent eval delegates ownership and target-source checks to its host-verified owning runtime. Secrets are redacted from listings. |
| `extensions` | namespace | `use`, `invoke`, `invokeProvider`, `on`, `list`, `reload` |  |
| `approvals` | namespace | `request`, `revoke`, `list` |  |
| `notifications` | namespace | `show`, `dismiss` |  |
| `workspace` | namespace | `getInfo`, `getActive`, `getConfig`, `validateConfig`, `setInitPanels`, `setConfigField`, `getAgentsMd`, `listSkills`, `readSkill`, `sourceTree`, `ensureContextFolder`, `findUnitForPath`, `units`, `recurring`, `heartbeats`, `hostTargets`, `projects` | Workspace catalog, source tree, and unit helpers. Does not include panelTree; use runtime.panelTree for panel-tree handles. |
| `openPanel` | value |  | Open a workspace or browser panel and return a PanelHandle. |
| `listPanels` | value |  | Alias for runtime.panelTree.list(). |
| `getPanelHandle` | value |  | Alias for runtime.panelTree.get(id, kind?). |
| `panelTree` | namespace | `self`, `get`, `list`, `roots`, `children`, `parent`, `navigate` | Runtime property, not workspace.panelTree. Signatures: self(): PanelHandle; get(id): PanelHandle; list(): Promise<PanelHandle[]>; roots(): Promise<PanelHandle[]>; children(id): Promise<PanelHandle[]>; parent(id): PanelHandle \| null; navigate(id, source, opts?): Promise<{ id, title }>. Use list/roots/children/get for existing panels; navigate replaces an existing panel slot; openPanel creates a new panel. self/get are sync; async methods refresh metadata as needed. |
| `handleRpcPost` | value |  |  |
| `destroy` | value |  |  |
<!-- END GENERATED: worker-runtime-surface -->

Existing panel handles are non-owned; do not call `handle.navigate`,
`handle.reload`, or `handle.close` unless requested. Use
`handle.navigate(source, opts)` or `panelTree.navigate(id, source, opts)` only
when replacing that specific slot is the requested behavior. Clean up temporary
panels opened by the worker.

For panel navigation options, `contextId` changes the target panel's
filesystem/storage context and `ref` selects the code build. Never rely on
`contextId` to imply `ctx:<contextId>`; pass `ref` explicitly when replacing a
panel with context-branch code.

A context is the complete workspace branch across every repository. Repository
or vault selection is ordinary state inside that branch. Panels, their channels,
and agents launched from them share the panel's host-bound context; never put a
second authoritative context in `stateArgs`. New branches come only from the
explicit fork/clone/subagent lifecycle APIs. A panel may move to an existing
branch only through `panel.switchContext(contextId, opts?)` or an explicit
panel-tree navigation carrying `contextId`.

For workers and Durable Objects, the owning `contextId` also selects the
default semantic working state. Omit `ref` to follow that context; use `ref: "main"` only
to pin protected main, or another explicit immutable selector deliberately.

## Worker Lifecycle and Environment Bindings

Discover launchable sources with `await workers.listSources()`. The result
includes every regular and Durable Object worker, its workspace `source`, the
manifest's actual `entry`, and `classes` (empty for a regular worker). Use the
returned `entry` or read `<source>/package.json`; do not assume `index.ts`.

Launch and retire a regular worker through the portable typed client (which
delegates to the canonical runtime entity service):

```ts
const handle = await workers.create("workers/my-worker", {
  key: `probe-${crypto.randomUUID()}`,
  contextId: ctx.contextId,
  env: { NON_SECRET_PROBE: "configured" },
});

try {
  // Exercise the worker here.
} finally {
  await workers.destroy(handle);
}
```

Extra `env` values are string bindings delivered through the second argument of
the worker's `fetch(request, env, ctx)` handler. Read them from `env` (typed as
`WorkerEnv`), not from Node's `process.env`.

A resolved `runtime.createEntity` call proves that the host accepted the env
configuration and started the worker. It does not prove that the running worker
observed a value. For an end-to-end check, expose one intentionally non-secret
probe from the worker under test and call it through the returned `targetId`:

```ts
import {
  createWorkerRuntime,
  handleWorkerRpc,
  type ExecutionContext,
  type WorkerEnv,
} from "@workspace/runtime/worker";

let exposedForWorker: string | null = null;

export default {
  async fetch(request: Request, env: WorkerEnv, _ctx: ExecutionContext) {
    const runtime = createWorkerRuntime(env);
    if (exposedForWorker !== env.WORKER_ID) {
      runtime.rpc.expose("observeConfiguredValue", () => ({
        value: typeof env["NON_SECRET_PROBE"] === "string" ? env["NON_SECRET_PROBE"] : null,
      }));
      exposedForWorker = env.WORKER_ID;
    }
    const rpcResponse = handleWorkerRpc(runtime, request);
    if (rpcResponse) return rpcResponse;
    return new Response("ready");
  },
};
```

```ts
const observed = await rpc.call<{ value: string | null }>(
  handle.targetId,
  "observeConfiguredValue",
  []
);
if (observed.value !== "configured") throw new Error("Worker env mismatch");
```

Keep a probe narrow and remove it from production code. Never expose the full
`env` object or accept an arbitrary key: env may contain bearer tokens and other
secrets. Do not add env fields to `runtime.listEntities` or entity handles.

## Userland Services

Read [`skills/capabilities/SKILL.md`](../capabilities/SKILL.md) before exposing or
consuming a service. Workspace service declarations are resolved from the exact
caller's live semantic `meta/vibestudio.yml`; the same declaration set feeds live
service/API docs. They are deliberately not compiled into a static product census.

Worker package.json only carries `vibestudio.durable.classes` (workerd binding).
Workspace-level singletons, services, and HTTP routes live in
`meta/vibestudio.yml`. Resolve services by name/protocol through
`workers.resolveService(...)`; do not hardcode `workers/foo`, DO class names,
or `/_r/w/...` paths in callers. Before starting an eval, use the agent tools
`docs_search`/`docs_open` when the live contract is not already known. They are not
exports from `@workspace/runtime`; inside eval, use the documented `workers.*` and
`rpc.*` runtime APIs. `workers.listServices()` rows for workspace-owned services
include a `docsId` for that same live catalog; pass that id to the agent's
`docs_open` tool instead of scanning the provider source for methods. A declaration
in another context is neither visible nor callable here.

If installed code consumes the service, declare an exact
`workspace-service:<name>` request in its authority manifest. The request may precede
the provider's presence in this checkout; build-time service enumeration is not the
authority boundary. Runtime resolution still requires a matching live declaration,
exact provider EV, caller-context visibility, and grant. Never use
`workspace-service:*` in an installed-unit request or add the service to a generated
product authority catalog.

Worker packages may declare simple string overrides in top-level `overrides`.
BuildV2 forwards those overrides, plus overrides from transitive workspace
packages, into generated external-deps installs. Prefer package-local overrides
for broken or missing transitive npm versions; changing an override invalidates
the dependency cache.

**Durable Object-backed service** — add to `workspace/meta/vibestudio.yml`:

```yaml
singletonObjects:
  - source: workers/my-store
    className: MyStore
    key: main

services:
  - source: workers/my-store
    name: my-store
    protocols: [example.my-store.v1]
    authority:
      principals: [user, code]
    durableObject: { className: MyStore } # key joined from singletonObjects
```

Resolve and call it:

```ts
const svc = await workers.resolveService("example.my-store.v1");
if (svc.kind !== "durable-object") throw new Error("Expected DO service");
await rpc.call(svc.targetId, "methodName", [arg]);
```

**Stateless worker service** — add to `meta/vibestudio.yml`:

```yaml
routes:
  - source: workers/my-api
    path: /api
    worker: true

services:
  - source: workers/my-api
    name: my-api
    protocols: [example.my-api.v1]
    authority:
      principals: [user, code]
    worker: { routePath: /api }
```

Resolve and fetch it:

```ts
const svc = await workers.resolveService("example.my-api.v1");
if (svc.kind !== "worker") throw new Error("Expected worker service");
await gatewayFetch(`${svc.routeBasePath}/jobs`, { method: "POST", body: JSON.stringify(payload) });
```

A `services[].durableObject` or `routes[].durableObject` referencing a DO
class with no matching `singletonObjects` row is rejected at workspace-load
time. Stateless service routes are live only while the canonical worker
instance is running.

## Durable Object-backed App Databases

Use a Durable Object as the default database for user-facing workspace apps,
panels, and long-lived agent workflows when data must be shared outside one
agent eval. The eval `db` is private to that agent's EvalDO; it is good for
scratch analysis and resumable diagnostics, but it is not an application
database for panels, apps, workers, or other agents.

Canonical shape:

1. Create `workers/<store>` with a `DurableObjectBase` subclass.
2. Store durable rows in the DO's SQLite database through `this.sql`.
3. Expose narrow app methods with explicit
   `@rpc({ principals, effect: { kind: "workspace-service" }, tier, sensitivity })`
   contracts; the effect must be a literal object so the exact build can document it
   without executing provider code. Do not expose a
   raw SQL console to normal UI callers.
4. Declare a `services:` entry in `meta/vibestudio.yml` with the principal
   families that may resolve the service.
5. Call it from eval, panels, inline UI, apps, workers, or other DOs with
   `workers.resolveService(protocol, objectKey?)` and `rpc.call(...)`.

Minimal store:

```ts
import { DurableObjectBase, rpc } from "@workspace/runtime/worker";

type TodoRow = {
  id: string;
  title: string;
  done: number;
  updated_at: string;
};

export class TodoStore extends DurableObjectBase {
  static override schemaVersion = 1;

  protected override createTables(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS todos (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        done INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      )
    `);
  }

  protected override requiredTables(): readonly string[] {
    return ["todos"];
  }

  @rpc({
    principals: ["user", "code"],
    effect: { kind: "workspace-service" },
    tier: "open",
    sensitivity: "write",
  })
  upsertTodo(input: { id?: string; title: string; done?: boolean }): { id: string } {
    this.ensureReady();
    const id = input.id ?? crypto.randomUUID();
    this.sql.exec(
      `INSERT INTO todos (id, title, done, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         done = excluded.done,
         updated_at = excluded.updated_at`,
      id,
      input.title,
      input.done ? 1 : 0,
      new Date().toISOString()
    );
    return { id };
  }

  @rpc({
    principals: ["user", "code"],
    effect: { kind: "workspace-service" },
    tier: "open",
    sensitivity: "read",
  })
  listTodos(): Array<{ id: string; title: string; done: boolean; updatedAt: string }> {
    this.ensureReady();
    return (
      this.sql.exec(`SELECT * FROM todos ORDER BY updated_at DESC`).toArray() as TodoRow[]
    ).map((row) => ({
      id: row.id,
      title: row.title,
      done: row.done === 1,
      updatedAt: row.updated_at,
    }));
  }
}
```

Declare it. A `singletonObjects` row gives the service a default object key
(`main` below); omit the singleton only when the service is intentionally a
factory and every caller will pass an explicit `objectKey`.

```yaml
singletonObjects:
  - source: workers/todo-store
    className: TodoStore
    key: main

services:
  - source: workers/todo-store
    name: todo-store
    title: Todo Store
    protocols: [example.todos.v1]
    authority:
      principals: [user, code]
    durableObject:
      className: TodoStore
```

Call it from eval, a panel, an inline UI component, an app, a worker, or
another DO:

```ts
import { rpc, workers } from "@workspace/runtime";

const svc = await workers.resolveService("example.todos.v1");
if (svc.kind !== "durable-object") throw new Error("Expected DO service");

await rpc.call(svc.targetId, "upsertTodo", [{ title: "Write storage docs" }]);
const todos = await rpc.call(svc.targetId, "listTodos", []);
```

For a partitioned store, use the optional second argument:

```ts
const projectStore = await workers.resolveService("example.todos.v1", projectId);
```

That resolves `do:<source>:<className>:<projectId>` and creates or activates a
separate SQLite database for that object key. Use stable, user-meaningful keys
such as workspace id, project id, document id, or account id. Do not use a
random key unless the app really wants a new isolated database.

The declaration and receiver must both admit the caller:

- `services[].authority` controls which authenticated principal families may
  resolve the service in this exact context.
- Each method's `@rpc` contract independently enforces principals, tier,
  receiver relationships, and the concrete resource. Gated and critical
  methods additionally require a sealed unit request; a request still grants nothing.

For sensitive shared resources, add a user decision inside the DO method with
`approvals.request(...)`; do not use approvals for ordinary private app rows.

For a running Vibestudio system—including agent eval—exercise the real object
through `workers.resolveService(...)` / `workers.resolveDurableObject(...)` and
separate `rpc.call(...)` calls as shown above. This is the integration path: it
uses workerd, the live declaration, the method's `@rpc` authority contract,
and the object's persistent SQLite database.

Prefer `resolveService(...)` whenever a service exists. Raw
`resolveDurableObject(...)` may address workspace worker DO classes, but
product-internal DOs remain closed behind their reviewed static host catalog.
Workspace-built DOs are admitted dynamically from the caller's live semantic
declarations and still require exact source/class/object-key receiver authority.
An exported class is not a class-wide grant, and another key is another resource.

For fast Vitest-only unit coverage, keep storage logic in methods like the above
and use `createTestDO(...)` in a co-located worker test. That helper is
intentionally test-only: it creates an in-memory sql.js-backed object in the
test process and does not exercise service resolution, workerd persistence, or
the RPC/policy boundary. Do not import `createTestDO` from agent eval or
production panel/worker/DO code.

## Durable Object Schema Epochs

`DurableObjectBase` owns SQLite schema lifecycle. Define the one exact current
schema in `createTables`; never interpret or translate an older shape in a
handler:

```ts
export class MyStoreDO extends DurableObjectBase {
  // Bump this for any schema-shape change. It identifies one exact pre-release
  // epoch; it is not a sequence of layouts the current code can read.
  static override schemaVersion = 2;

  // Idempotent declarations for the exact CURRENT schema. These may rerun to
  // complete an interrupted initialization of this same epoch.
  protected override createTables(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY, label TEXT NOT NULL, archived INTEGER DEFAULT 0
    )`);
  }

  // Optional validation before this epoch is recorded as ready.
  protected override requiredTables(): readonly string[] {
    return ["items"];
  }
}
```

For any table, column, index, trigger, view, or virtual-table shape change, bump
`schemaVersion` and change only the current declarations. On the next
`fetch()`/`alarm()`, an instance at an older epoch discards all of its
non-framework SQLite objects and every application key in the base `state`
table, then creates and validates the current schema from empty storage. The
base handles FTS/virtual-table shadows as part of that whole-object reset.

There is deliberately no `migrate` hook. Do not add `ALTER` sequences, old
table readers, selected-row preservation, compatibility flags, or per-version
drop lists. A current-epoch activation may rerun idempotent `createTables` after
an interrupted initialization; that is crash recovery, not old-schema support.
An instance stamped with a newer epoch refuses to start, preventing an older
binary from silently destroying storage.

## Durable Object RPC Exposure & Authorization

DO methods are reachable over RPC only when explicitly opted in, and the
workspace realm enforces a per-method caller policy (default-deny). Two layers,
kept separate — both required. Full design: [`docs/capability-approval-design.md`](../../../docs/capability-approval-design.md).

### Layer 1 — `@rpc` exposure (which methods are callable)

A method with no `@rpc` is private to the DO and cannot be invoked over the
relay; forgetting `@rpc` fails loud ("not exposed"). Mark every method a caller
should reach.

### Layer 2 — `@rpc({ principals, effect, tier, sensitivity })` receiver policy

The RPC relay is open between authenticated participants, so the recipient must
gate. Every relay-reachable workspace method declares the authenticated principal
families it accepts (`"host" | "user" | "code"`), its effect, reviewed tier, and
sensitivity. Missing policy is default-deny. A workspace service method normally
uses the literal `effect: { kind: "workspace-service" }`; do not hide it behind a
constant or factory because live docs are extracted from the exact source build
without executing that source.

```ts
import { rpc } from "@workspace/runtime/worker";

export class MyStoreDO extends DurableObjectBase {
  @rpc({ principals: ["user", "code"], effect: { kind: "workspace-service" }, tier: "gated", sensitivity: "write" })
  async addItem(label: string): Promise<{ id: string }> { ... }

  @rpc({ principals: ["host"], effect: { kind: "runtime-intrinsic" }, tier: "open", sensitivity: "write" })
  async onWebhookDelivery(event: WebhookEvent): Promise<void> { ... }

  private bumpCounter(): void { ... }       // no @rpc — unreachable over RPC
}
```

Use `user` for direct user/session actions, `code` for installed workspace code and
agents, and `host` only for trusted host lifecycle traffic. Listing a principal is
only the receiver floor: the caller's sealed manifest, live grant, mission/context
constraints, and service admission still have to agree.

### Identity-level tightening (inline)

The kind floor is coarse — _any_ DO is `"do"`. When a method must accept only ONE
specific caller (this agent's own EvalDO, the agent's own PubSubChannel, a known
class), add an inline check ON TOP of the floor using the server-authenticated
caller, which cannot be forged:

```ts
@rpc({ principals: ["code"], effect: { kind: "workspace-service" }, tier: "gated", sensitivity: "write" })
async onChannelOp(channelId: string): Promise<void> {
  await this.assertOwnEvalCaller(channelId); // only THIS agent's own EvalDO
  ...
}
// this.rpcCallerId / this.rpcCallerKind / this.caller are server-set from the
// validated token. (Server-realm DOs like EvalDO use a coarser per-DO
// `assertInboundAllowed` override instead of @rpc policies.)
```

### When to add a USER-APPROVAL gate

Reachability (Layers 1–2) answers "may this caller reach the method"; it never
asks the user. For a _userland-useful but sensitive_ action, require a user
decision:

- **Built-in host actions** (credentials, external opens, git writes, project
  imports, webhooks, publishing main, spawning workers): call the existing
  runtime API and let Vibestudio's built-in capability-permission flow prompt — do
  NOT re-implement approval.
- **Custom shared resources** your worker exposes to other userland callers: use
  `runtime.approvals.request(...)` (see "Userland Approval Prompts" below).

Never cache an approval result or invent your own grant scope — the host owns
persistence, scope (once/session/version), and revocation.

## Store

```ts
const stored = await credentials.store({
  label: "Example API",
  audience: [{ url: "https://api.example.com/", match: "origin" }],
  injection: {
    type: "header",
    name: "authorization",
    valueTemplate: "Bearer {token}",
  },
  material: { type: "bearer-token", token },
});
```

## OAuth Without Returning Tokens

Use `credentials.connect()` for OAuth. The host owns the redirect,
browser handoff, callback validation, token exchange, encrypted storage, and
initial use grant. For provider secrets/config, use
`credentials.configureClient()` and pass `clientConfigId`.

```ts
const stored = await credentials.connect({
  flow: {
    type: "oauth2-auth-code-pkce",
    authorizeUrl: "https://auth.example.com/oauth/authorize",
    tokenUrl: "https://auth.example.com/oauth/token",
    clientId: "public-client-id",
    scopes: ["read"],
  },
  credential: {
    label: "Example API",
    audience: [{ url: "https://api.example.com/", match: "origin" }],
    injection: {
      type: "header",
      name: "authorization",
      valueTemplate: "Bearer {token}",
    },
  },
  browser: "external", // or "internal" for an app browser panel
});
```

Use `type: "oauth2-device-code"` when redirect-based flows can't reach the
server — providers that won't accept a Tailscale `*.ts.net` redirect URI,
headless installs, or when the user wants to authorize on a different device.
The server displays the `user_code` on the trusted approval bar while it
polls the token endpoint. See [api-integrations
SKILL.md](../api-integrations/SKILL.md#device-code-flow) for the full
provider compatibility matrix.

## Use

```ts
await credentials.fetch("https://api.example.com/v1/items", undefined, {
  credentialId: stored.id,
});
```

## Userland Approval Prompts

Workers can ask the user for provider-defined decisions through the runtime's
approval helpers. Use this when a worker exposes its own security-gated service
to other userland callers and needs a human decision that Vibestudio cannot model
as a built-in credential or capability permission.

Do not call `approvals.request()` before actions the worker or agent can already
take through normal runtime APIs. Context filesystem work, eval work, panel
operations, browser automation, git/runtime APIs, external opens, and credential
use are protected by the outer Vibestudio permission model where approval is
required.

```ts
import { createWorkerRuntime } from "@workspace/runtime/worker";

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext) {
    const runtime = createWorkerRuntime(env);

    const decision = await runtime.approvals.request({
      subject: {
        id: "team-x:calendar-write",
        label: "Team X calendar write access",
      },
      title: "Allow calendar writes?",
      summary: "This custom calendar worker wants to let the caller create Team X events.",
      details: [
        { label: "Caller", value: request.headers.get("x-caller") ?? "unknown" },
        { label: "Operation", value: "Create calendar events" },
      ],
      options: [
        { value: "allow", label: "Allow", tone: "primary" },
        { value: "deny", label: "Deny", tone: "danger" },
      ],
    });

    if (decision.kind !== "choice" || decision.choice !== "allow") {
      return new Response("Not approved", { status: 403 });
    }

    return new Response("Approved");
  },
};
```

Every non-dismiss choice is persisted by the server under the verified issuer
worker and `subject.id`. Subsequent calls with the same `subject.id` return the
stored choice immediately. Use `runtime.approvals.revoke(subjectId)` to forget a
decision, and `runtime.approvals.list()` to inspect decisions owned by the same
worker.

```ts
await runtime.approvals.revoke("team-x:calendar-write");
const grants = await runtime.approvals.list();
```

Keep `subject.id` stable and provider-owned. It must be 1-128 chars using only
letters/numbers/`._:/-`, and cannot start with `shell:`, `server:`, `system:`,
or `@`. Options must have unique values; `dismiss` is reserved. Treat
`approvals.request()` as a userland policy gate for custom shared resources only.
For host-mediated actions such as external browser opens, credentials, git
writes, project imports, or webhooks, call the existing runtime API and let
Vibestudio's built-in permission flow handle the prompt and trust scope. For
ordinary context file edits and test temp directories, do not prompt.

## Agent Debug Port

Use GAD first for durable trajectory state, then the agent's activation-local
debug snapshot when a channel appears stuck:

```ts
const health = await gad.inspectAgentHealth({ channelId: chat.channelId });
const debug = await chat.callMethod(agentParticipantId, "getDebugState", {});
console.log(JSON.stringify(debug, null, 2).slice(0, 4000));
```

`getDebugState` contains only already-loaded loop state plus local SQLite
outboxes. A loop with `loaded: false` is not hydrated through GAD; use `health`
for the durable answer. See `../../../docs/agent-debug-port.md` for the exact
contract.

`chat.callMethod` is scoped to the current channel. To inspect a standard agent
debug method for another channel, resolve that channel's DO and use its
read-only inspection path:

```ts
const channel = await workers.resolveService("vibestudio.channel.v1", targetChannelId);
const debug = await rpc.call(channel.targetId, "inspectAgent", [
  agentParticipantId,
  "getDebugState",
]);
```

The channel DO only exposes `getDebugState`, `getAgentSettings`, and
`inspectMethodSuspensions` through this route. It resolves the exact entity,
uses a dedicated read-only agent RPC rather than `onMethodCall`, and bounds the
probe to five seconds. A retired agent fails before inspection dispatch.

## Host Server Logs

Use `workspace.units.logs(name)` and `workspace.units.diagnostics(name)` for the
panel, worker, DO, extension, or app unit itself. Use `serverLog` when the
failure may be in the workspace server around that unit: build/reconcile,
workerd supervision, routing, RPC dispatch, gateway reconnects, idle exit, or
startup/shutdown.

```ts
const recent = await rpc.call("main", "serverLog.query", [{ level: "warn", limit: 100 }]);
const build = await rpc.call("main", "serverLog.query", [{ tag: "BuildV2", limit: 100 }]);
```

For live following, open `about/server-logs` or subscribe to
`server-log:append` as documented in `../server-logs/SKILL.md`.

## Blobstore (content-addressable bytes)

The per-workspace blobstore stores arbitrary content keyed by sha256 digest.
Use it for anything large or binary — model outputs, fetched documents,
generated artifacts, the object layer for a custom git-like format.

**Metadata via RPC** (uses the worker's existing `RPC_AUTH_TOKEN` automatically):

```ts
const exists = await callMain("blobstore.has", digest);
const meta = await callMain("blobstore.stat", digest); // { size, mtime } | null
```

**Streaming binary I/O via the gateway**:

```ts
// Writes are streaming — pass any Readable / ReadableStream as the body.
const put = await runtime.gatewayFetch("/_r/s/blobstore/blob", {
  method: "PUT",
  body,
});
const { digest, size } = await put.json();

const get = await runtime.gatewayFetch(`/_r/s/blobstore/blob/${digest}`);
// `get.body` is a ReadableStream of the original bytes.
```

`gatewayFetch` prefixes `GATEWAY_URL` and sends `Authorization: Bearer
<RPC_AUTH_TOKEN>`. Worker tokens are minted from the central `TokenManager`,
so the route's `caller-token` auth admits them.

`blobstore.delete` and `blobstore.list` are restricted to shell/server callers
and cannot be invoked from a worker — design the upper layer (e.g. a server
service) to own GC.

See [`docs/architecture/storage.md`](../../../docs/architecture/storage.md#blobstore-content-addressable-objects)
for the full design.
