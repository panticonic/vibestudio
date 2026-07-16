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
| `fs` | value |  | Per-context filesystem sandbox. Paths are context-root-relative. For valid workspace-repo paths, writeFile, appendFile, truncate, chmod, unlink/rmdir/rm, copyFile destinations, and supported renames into or within repos route through GAD working edits; tracked-to-scratch renames and open with write flags are rejected. mkdir and utimes remain direct filesystem operations. Platform-ignored paths and paths outside reserved workspace source roots are local scratch. |
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
| `git` | namespace | `setSharedRemote`, `removeSharedRemote`, `setUpstream`, `removeUpstream`, `detachUpstream`, `setAutoPush`, `upstreamStatus`, `pushUpstream`, `pullUpstream`, `publishRepo`, `createDisposableRemote`, `publishToDisposableRemote`, `pushDisposableRemote`, `inspectDisposableRemote`, `removeDisposableRemote`, `resetExportMarker`, `commitMapping`, `importProject`, `completeWorkspaceDependencies` | Typed external Git operations routed through the workspace's configured gitInterop provider. |
| `vcs` | namespace | `edit`, `commit`, `discardEdits`, `readFile`, `listFiles`, `revert`, `status`, `log`, `diff`, `resolveHead`, `workspaceViewWithRepoAt`, `merge`, `abortMerge`, `pendingMerge`, `push`, `pushStatus`, `previewBuild`, `commitEdits`, `fileHistory`, `commitAncestors`, `editsByActor`, `editsByTurn`, `editsByInvocation`, `forkRepo`, `contextStatus`, `rebaseContext`, `recall` | Workspace GAD VCS (edit → commit → push): vcs.edit records tracked WORKING edits (no commit/build); vcs.commit folds them into a messaged snapshot per repo; push is the only main-advance (fast-forward-only, build-gated — diverged pushes reject, reconcile with vcs.merge). vcs.previewBuild builds working content on demand; status/fileHistory/commitEdits expose provenance. |
| `gad` | namespace | `rawSql`, `query`, `status`, `ensureBlob`, `listUserNotificationsForMe`, `acknowledgeUserNotification`, `putUserNotification`, `deleteUserNotification`, `getTrajectoryBranchHead`, `listTrajectoryEvents`, `appendChannelEnvelope`, `appendChannelEnvelopeWithRegistryMutation`, `listMessageTypes`, `getMessageType`, `getChannelEnvelope`, `getTrajectoryForEnvelope`, `listPublishedEnvelopesForTrajectory`, `getEnvelopesForTrajectory`, `getPublishedArtifactsForTurn`, `getPrivateLineageForPublishedEnvelope`, `getDownstreamConsumers`, `readChannelEnvelopes`, `inspectChannelEnvelopes`, `listStoredValueRefs`, `inspectStorageDiagnostics`, `inspectPublicationIntegrity`, `inspectTurnState`, `inspectInvocationState`, `inspectChannelRoster`, `inspectAgentHealth`, `listGadBranchFiles`, `diffGadStates`, `readGadFileAtState`, `getGadStateProducer`, `validateGadHashes`, `clearDirtyAfterValidation`, `checkGadIntegrity`, `rebuildTrajectoryProjections`, `provenanceForFile`, `provenanceForSession`, `provenanceForClaim` | Typed access to the workspace's canonical Graph and Data store: parameterized SQL, trajectory/channel lineage, integrity diagnostics, provenance, and bounded channel-envelope paging. |
| `blobstore` | namespace | `has`, `stat`, `putText`, `getText`, `getRange`, `getRangeBytes`, `grep`, `putBase64`, `getBase64`, `putTree`, `getTree`, `listTree`, `readFileAtTree`, `diffTrees`, `materializeTree`, `delete`, `list`, `putBytes`, `readText` | Per-workspace content-addressable blob store: putText/putBase64 store, getText/readText/getRange/getRangeBytes/getBase64 fetch, grep searches; returns a sha256 digest. readText is a portable alias of getText and both return string \| null. Runtime-only putBytes(Uint8Array \| ArrayBuffer) losslessly encodes bytes through putBase64; MIME metadata is not stored. Persist large artifacts/screenshots and return the digest. Immutable file trees: putTree/getTree store and read tree objects, listTree/readFileAtTree walk a tree hash, diffTrees compares two trees. |
| `webhooks` | namespace | `createSubscription`, `listSubscriptions`, `revokeSubscription`, `rotateSecret` | Ergonomic owner-scoped webhook lifecycle, identical in panels, workers, DOs, and agent eval: createSubscription(request), listSubscriptions(), rotateSecret(subscriptionId, secret?), and revokeSubscription(subscriptionId). Agent eval delegates ownership and target-source checks to its host-verified owning runtime. Secrets are redacted from listings. |
| `extensions` | namespace | `use`, `invoke`, `invokeProvider`, `on`, `list`, `reload` |  |
| `approvals` | namespace | `request`, `ask`, `revoke`, `list` |  |
| `notifications` | namespace | `show`, `dismiss` |  |
| `workspace` | namespace | `list`, `getActive`, `getActiveEntry`, `getConfig`, `create`, `delete`, `setInitPanels`, `setConfigField`, `switchTo`, `sourceTree`, `findUnitForPath`, `units` | Workspace catalog, source tree, and unit helpers. Does not include panelTree; use runtime.panelTree for panel-tree handles. |
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
  ref: `ctx:${ctx.contextId}`, // omit only when intentionally using main
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
        value:
          typeof env["NON_SECRET_PROBE"] === "string" ? env["NON_SECRET_PROBE"] : null,
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

Worker package.json only carries `vibestudio.durable.classes` (workerd binding).
Workspace-level singletons, services, and HTTP routes live in
`workspace/meta/vibestudio.yml`. Resolve services by name/protocol through
`workers.resolveService(...)`; do not hardcode `workers/foo`, DO class names,
or `/_r/w/...` paths in callers.

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
    policy:
      allowed: [panel, app, do, worker, server]
    durableObject: { className: MyStore } # key joined from singletonObjects
```

Resolve and call it:

```ts
const svc = await workers.resolveService("example.my-store.v1");
if (svc.kind !== "durable-object") throw new Error("Expected DO service");
await rpc.call(svc.targetId, "methodName", [arg]);
```

**Stateless worker service** — add to `workspace/meta/vibestudio.yml`:

```yaml
routes:
  - source: workers/my-api
    path: /api
    worker: true

services:
  - source: workers/my-api
    name: my-api
    protocols: [example.my-api.v1]
    policy:
      allowed: [panel, app, do, worker, server]
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
3. Expose narrow app methods with `@rpc({ principals: [...] })`; do not expose a
   raw SQL console to normal UI callers.
4. Declare a `services:` entry in `workspace/meta/vibestudio.yml` with
   `authority.principals` for the authenticated principals that may resolve it.
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

  @rpc({ principals: ["user", "code"] })
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

  @rpc({ principals: ["user", "code"] })
  listTodos(): Array<{ id: string; title: string; done: boolean; updatedAt: string }> {
    this.ensureReady();
    return (this.sql.exec(`SELECT * FROM todos ORDER BY updated_at DESC`).toArray() as TodoRow[])
      .map((row) => ({
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

Two authority gates must both admit the host-attested grant:

- `services[].authority.principals` controls which principal classes may
  resolve the service.
- `@rpc({ principals: [...] })` controls which principal classes may invoke
  each exposed DO method. Use `@rpc({ requires })` when the method needs a
  compositional capability or relationship instead of a principal-only floor.

For sensitive shared resources, add a user decision inside the DO method with
`approvals.request(...)`; do not use approvals for ordinary private app rows.

For a running Vibestudio system—including agent eval—exercise the real object
through `workers.resolveService(...)` / `workers.resolveDurableObject(...)` and
separate `rpc.call(...)` calls as shown above. This is the integration path: it
uses workerd, the declared service authority, the method's `@rpc` authority,
and the object's persistent SQLite database.

For fast Vitest-only unit coverage, keep storage logic in methods like the above
and use `createTestDO(...)` in a co-located worker test. That helper is
intentionally test-only: it creates an in-memory sql.js-backed object in the
test process and does not exercise service resolution, workerd persistence, or
the RPC/policy boundary. Do not import `createTestDO` from agent eval or
production panel/worker/DO code.

## Durable Object Schema & Migrations

`DurableObjectBase` owns SQLite schema lifecycle — never run `CREATE TABLE` /
`ALTER TABLE` ad hoc in handlers. Define the schema declaratively and version
it:

```ts
export class MyStoreDO extends DurableObjectBase {
  // Bump this when the schema changes. Persisted per-instance; instances
  // upgrade lazily on their next request.
  static override schemaVersion = 2;

  // Idempotent CREATE TABLE IF NOT EXISTS statements for the CURRENT schema.
  // Runs on every init (fresh and upgraded instances alike).
  protected override createTables(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY, label TEXT NOT NULL, archived INTEGER DEFAULT 0
    )`);
  }

  // Step persisted data forward when an instance is below schemaVersion.
  // Runs BEFORE createTables(), once, inside init. Make each step idempotent.
  protected override migrate(fromVersion: number, _toVersion: number): void {
    if (fromVersion < 2) {
      this.sql.exec(`ALTER TABLE items ADD COLUMN archived INTEGER DEFAULT 0`);
    }
  }

  // Optional: tables that must exist before the version is recorded as ready.
  // Failed validation throws and retries on the next request.
  protected override requiredTables(): readonly string[] {
    return ["items"];
  }
}
```

Rules of thumb:

- **Additive changes** (new table, new nullable/defaulted column) — bump
  `schemaVersion`, add the `ALTER` to `migrate`, update `createTables`.
- **Never** renumber or reuse versions; an instance whose stored version is
  *newer* than the code's `schemaVersion` refuses to start (downgrade guard).
- Schema init is lazy (first `fetch()`/`alarm()`) and retried on failure, so a
  throwing migration surfaces in `workspace.units.diagnostics` for the source
  and the instance stays on its old version until fixed.

## Durable Object RPC Exposure & Authorization

DO methods are reachable over RPC only when explicitly opted in, and the
workspace realm enforces per-method compositional authority (default-deny). Two layers,
kept separate — both required. Full design: [`docs/capability-approval-design.md`](../../../docs/capability-approval-design.md).

### Layer 1 — `@rpc` exposure (which methods are callable)

A method with no `@rpc` is private to the DO and cannot be invoked over the
relay; forgetting `@rpc` fails loud ("not exposed"). Mark every method a caller
should reach.

### Layer 2 — `@rpc({ principals | requires })` authority (who may call it)

The RPC relay is open between authenticated participants, so the recipient must
gate. **In the workspace realm, every relay-reachable method MUST declare
`@rpc({ principals: [...] })` or `@rpc({ requires })`**. A bare `@rpc` exposes
the method to registration but grants nobody authority to invoke it. Principal
classes are `"host" | "user" | "device" | "code" | "entity"`; transport roles
such as panel, DO, app, agent, and extension do not confer authority.

```ts
import { rpc } from "@workspace/runtime/worker";

export class MyStoreDO extends DurableObjectBase {
  @rpc({ principals: ["user", "code"] })  // authenticated user or exact code artifact
  async addItem(label: string): Promise<{ id: string }> { ... }

  @rpc({ principals: ["host"] })           // exact host only (webhook/alarm)
  async onWebhookDelivery(event: WebhookEvent): Promise<void> { ... }

  private bumpCounter(): void { ... }       // no @rpc — unreachable over RPC
}
```

Typical floors: user-facing code → `["user", "code"]`; autonomous exact code
→ `["code"]`; bound external agents → `["entity", "code"]`; host-dispatched
webhooks/alarms/lifecycle → `["host"]`. Admin/destructive methods should use a
`requires` expression that combines capability and workspace-role facts.

### Identity-level tightening (inline)

Principal classes are deliberately broad. When a method must accept only one
entity, code artifact, channel, or relationship, declare a `requires`
expression when possible and validate operation-specific ownership against the
server-attested caller context:

```ts
@rpc({ principals: ["code"] })
async onChannelOp(channelId: string): Promise<void> {
  await this.assertOwnEvalCaller(channelId); // only THIS agent's own EvalDO
  ...
}
// this.rpcCallerId / this.rpcCallerKind / this.caller are server-set from the
// validated invocation grant. Server-realm DOs use the same canonical
// authority evaluator at their direct-dispatch boundary.
```

### When to add a USER-APPROVAL gate

Reachability (Layers 1–2) answers "may this caller reach the method"; it never
asks the user. For a *userland-useful but sensitive* action, require a user
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

The default AI agent worker exposes a read-only participant method named
`getDebugState`. Use it when a channel appears stuck, especially after
`turn.opened` with no assistant message, tool call, or `turn.closed` event:

```ts
const debug = await chat.callMethod(agentParticipantId, "getDebugState", {});
console.log(JSON.stringify(debug, null, 2).slice(0, 4000));
```

The response includes dispatcher state, runner phase, persisted pending work,
channel checkpoints, and recent lifecycle/debug events. Do not add sleeps or
timeouts to diagnose these stalls; inspect the debug state and fix the blocked
operation. See `../../../docs/agent-debug-port.md` for the full field guide.

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
`inspectMethodSuspensions` through this route.

## Host Server Logs

Use `workspace.units.logs(name)` and `workspace.units.diagnostics(name)` for the
panel, worker, DO, extension, or app unit itself. Use `serverLog` when the
failure may be in the workspace server around that unit: build/reconcile,
workerd supervision, routing, RPC dispatch, gateway reconnects, idle exit, or
startup/shutdown.

```ts
const recent = await rpc.call("main", "serverLog.query", [
  { level: "warn", limit: 100 },
]);
const build = await rpc.call("main", "serverLog.query", [
  { tag: "BuildV2", limit: 100 },
]);
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
