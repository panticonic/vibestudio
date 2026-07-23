# Runtime API

Credentials are URL-bound and may only be used through host-mediated egress.

## Panel Runtime Surface

In panel component code, the host-injected `panel` object has two identity
layers: `panel.slotId` is the stable visible panel slot and is the correct
identity for panel-tree operations and PubSub/channel clients;
`panel.entityId`/`rpc.selfId` identify the current live runtime entity and can
change when the panel navigates or reopens. `panel` is not a portable export
from `@workspace/runtime` and must not be imported in server-side eval. Eval,
workers, and Durable Objects operate on visible panels through `getParent()`,
`openPanel()`, `getPanelHandle()`, and the `PanelHandle` values returned by
`panelTree`.

<!-- BEGIN GENERATED: panel-runtime-surface -->
Generated from `runtimeSurface.panel.ts`. Use `await help()` at runtime for the live surface.

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
| `workspace` | namespace | `getInfo`, `getActive`, `getConfig`, `validateConfig`, `setInitPanels`, `setConfigField`, `getAgentsMd`, `listSkills`, `readSkill`, `sourceTree`, `ensureContextFolder`, `findUnitForPath`, `units`, `recurring`, `heartbeats`, `hostTargets`, `projects` | Workspace catalog, source tree, and unit helpers. Does not include panelTree; import top-level panelTree for panel-tree handles. |
| `openPanel` | value |  |  |
| `listPanels` | value |  |  |
| `getPanelHandle` | value |  |  |
| `panelTree` | namespace | `self`, `get`, `list`, `roots`, `children`, `parent`, `navigate` | Top-level export, not workspace.panelTree. Signatures: self(): PanelHandle; get(id): PanelHandle; list(): Promise<PanelHandle[]>; roots(): Promise<PanelHandle[]>; children(id): Promise<PanelHandle[]>; parent(id): PanelHandle \| null; navigate(id, source, opts?): Promise<{ id, title }>. Use list/roots/children/get for existing panels; navigate replaces an existing panel slot; openPanel creates a new panel. self/get are sync; async methods refresh metadata as needed. |
| `Rpc` | value |  | RPC helpers namespace export. |
| `z` | value |  | Zod export. |
| `defineContract` | value |  |  |
| `buildPanelLink` | value |  |  |
| `buildPanelDeepLink` | value |  |  |
| `buildPanelShareLink` | value |  |  |
| `parseContextId` | value |  |  |
| `isValidContextId` | value |  |  |
| `getInstanceId` | value |  |  |
| `normalizePath` | value |  |  |
| `getFileName` | value |  |  |
| `resolvePath` | value |  |  |
| `createGatewayFetch` | value |  | Create a gateway-authenticated fetch helper from an explicit config. |
| `panel` | namespace | `entityId`, `slotId`, `parentId`, `env`, `setTitle`, `getInfo`, `focusPanel`, `getTheme`, `onThemeChange`, `onFocus`, `onConnectionError`, `onChildCreated`, `reopen`, `stateArgs` | Panel-only affordances: identity (entityId/slotId/parentId/env), semantic display title (setTitle(title, { explicit? })), introspection (getInfo/getTheme/onThemeChange/onFocus/onConnectionError), lifecycle (focusPanel/onChildCreated/reopen), and stateArgs (get/set/setForPanel). |
| `journal` | namespace | `Journal`, `with`, `current` | Panel operation journaling: journal.Journal (class), journal.with(journal, fn), journal.current(). |
| `agentApi` | value |  |  |
| `adblock` | namespace | `getStats`, `isActive`, `getStatsForPanel`, `isEnabledForPanel`, `setEnabledForPanel`, `resetStatsForPanel`, `getPanelUrl`, `addToWhitelist`, `removeFromWhitelist` |  |
<!-- END GENERATED: panel-runtime-surface -->

Workspace source is one semantic VCS over exact event/application states. Read
[vibestudio-vcs](../vibestudio-vcs/SKILL.md) before source mutation,
comparison, commit, external import, or publication. Use `git` only for external
remote transport; cross that boundary with one exact `vcs.importSnapshot`
rather than ordinary local edits. One coherent non-Git source snapshot may
contain several repositories when partial visibility would be incorrect. A Git
import has exactly one repository and one provenance boundary so unrelated remotes never
share a misleading source coordinate.
For external Git smart HTTP, construct `GitClient` from `@vibestudio/git` with
`credentials.gitHttp()`.
For workspace-managed external repo declarations, startup auto-import, branches,
approvals, and private repo retries, see
`skills/onboarding/EXTERNAL_GIT_PROJECTS.md`.

### Filesystem capability discovery

The context filesystem surface is the same from eval, panels, workers, and
Durable Objects. In eval, `fs` is injected; portable code imports `fs` from
`@workspace/runtime`. Use `await help("fs")` for the authoritative live method
list and `await help("fs.<method>")` for its arguments and examples.

`lstat()`, `readlink()`, and `realpath()` inspect symbolic links.
`symlink(target, path, type?)` creates them in context-local scratch. Both the
link and resolved target are confined to the virtual context root;
absolute-looking targets are interpreted relative to that root and stored as
contained relative targets. Link creation under a GAD workspace repo is
rejected because GAD states do not represent link entries. `chown()` remains
absent; use `copyFile()` when the destination must be tracked workspace source.

## Current Workspace

Import `workspace` from `@workspace/runtime` to inspect the current workspace
and its registered runtime units:

```ts
import { contextId, workspace } from "@workspace/runtime";

const active = await workspace.getActive();
const units = await workspace.units.list();

console.log({ contextId, active });
console.log(
  "Unit sample:",
  units.slice(0, 5).map((unit) => unit.id)
);
```

`workspace.getActive()` returns the current workspace id. Use
`workspace.units.*` for source unit inspection, diagnostics, logs, versions,
restart, and rollback. Workspace catalog operations belong to the human
shell's stable hub session and are intentionally absent from runtime eval.

Workspace host logs are exposed through the service catalog, not as an
`@workspace/runtime` namespace. Use `services.serverLog.tail/query/stats` in
eval, or raw RPC calls such as
`rpc.call("main", "serverLog.query", [{ level: "warn", limit: 100 }])`.
Live following uses
`rpc.stream("main", "events.watch", [["server-log:append"]], { signal })`,
normally through `EventsClient`; cancelling that response is the only
unsubscribe operation. Humans can open the `about/server-logs` viewer. See
[`server-logs`](../server-logs/SKILL.md) for the full contract and exact cleanup
pattern.

## Notifications

Use `notifications.show()` for host chrome notifications:

```ts
import { notifications } from "@workspace/runtime";

const id = await notifications.show({
  type: "info",
  title: "Notification test",
  message: "notification-show-marker",
});
```

`type` may be `info`, `success`, `warning`, `error`, or `consent`. The runtime
client defaults an omitted `type` to `info`; notification text belongs in
`message`.

## Webhook Subscriptions

The portable `webhooks` namespace is the ergonomic lifecycle API in panel,
worker, DO, and agent eval environments:

```ts
import { webhooks } from "@workspace/runtime";

const self = await agent.describe();
const created = await webhooks.createSubscription({
  label: "temporary lifecycle probe",
  target: {
    source: self.identity.source,
    className: self.identity.className,
    objectKey: self.identity.objectKey,
    method: "getDebugState",
  },
  delivery: { mode: "direct" },
  payload: { type: "json" },
  verifier: {
    type: "bearer",
    headerName: "Authorization",
    token: `probe-${crypto.randomUUID()}`,
    scheme: "Bearer",
  },
  response: {
    successStatus: 202,
    malformedPayload: "reject",
    dispatchError: "retry",
  },
});

try {
  const listed = await webhooks.listSubscriptions();
  const rotated = await webhooks.rotateSecret(created.subscriptionId);
  // Do not print or return rotated.secret. Store it only if the integration needs it.
  return { created: listed.some((row) => row.subscriptionId === created.subscriptionId) };
} finally {
  await webhooks.revokeSubscription(created.subscriptionId);
}
```

`listSubscriptions()` returns active subscriptions, so a successfully revoked
subscription disappears from the default list. Audit/history code can request
redacted tombstones explicitly with
`listSubscriptions({ includeRevoked: true })`.

Subscriptions are owner-scoped. For worker/DO callers (including agent eval),
`target.source` must be the caller's own source; `agent.describe().identity`
provides the correct source, class, and object key without guessing. A target is
only invoked if a public delivery arrives, so a create/list/rotate/revoke
lifecycle probe is harmless. `direct` requires a co-located public gateway;
`relay` requires the relay URL to be configured. If neither deployment surface
is available, report that concrete availability error rather than inventing a
target or switching to an unrelated service.

### Workspace semantic VCS

The `vcs` namespace is workspace-wide and schema-generated. Use
`await help("vcs")` for the live method list and exact arguments. Use the
[canonical VCS skill](../vibestudio-vcs/SKILL.md) for semantics instead of
copying a method catalog into this runtime guide.

Important routing rules:

- `status` returns the exact committed event and working event/application node;
- every context mutation carries `expectedWorkingHead` and `commandId`;
- `compare` classifies source changes against one exact target state;
- `integrate` appends local adopt/reconcile/decline decisions;
- `commit` and `discard` consume the complete local application chain;
- `move` and `copy` preserve explicit identity/content provenance;
- ordinary build and test services validate the current context; VCS does not
  expose a second preview-build path;
- `push` publishes one already-committed exact event after protected checks.

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
initial use grant. If the provider has client secrets or other setup material,
collect it with `credentials.configureClient()` and pass `clientConfigId`
to `connect`.

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

## Use

```ts
await credentials.fetch("https://api.example.com/v1/items", undefined, {
  credentialId: stored.id,
});
```

## Durable Object-backed App Databases

For shared application data, use a worker Durable Object with SQLite
(`this.sql`) and expose narrow RPC methods. Do not use the eval `db` for panel
or app state that another runtime needs to read; eval `db` is private to the
agent's EvalDO.

Resolve the service by protocol or name, optionally pass an object key for a
partitioned database, then call the DO target:

```ts
import { rpc, workers } from "@workspace/runtime";

const store = await workers.resolveService("example.todos.v1", "project-123");
if (store.kind !== "durable-object") throw new Error("Expected DO service");

await rpc.call(store.targetId, "upsertTodo", [{ title: "Ship the app" }]);
const rows = await rpc.call(store.targetId, "listTodos", []);
```

The worker must also admit the caller in two places: the manifest service
`policy.allowed` gate and each exposed DO method's `@rpc({ callers })` gate.
See [workspace-dev/WORKERS.md](../workspace-dev/WORKERS.md#durable-object-backed-app-databases)
for the schema, declaration, partition-key, and testing recipe.

## Unified Panel Handles

Use `panelTree` and `PanelHandle` from panels, workers, and DOs. In panel
code, `panelTree` is imported directly from `@workspace/runtime`; it is not
`workspace.panelTree`:

> **Headless tree root:** a genuinely headless eval has a tree but no initial
> panel node, so `await getParent()` returns `null`. If the workflow needs a
> child, create an owned root first and parent the target explicitly:
> `const root = await openPanel("about/new", { parentId: null });` then
> `const child = await openPanel(source, { parentId: root.id });`. Close `root`
> when done to clean the subtree. Do not throw merely because `getParent()` is
> null, and do not use the truthiness of the compatibility `parent` handle.

```ts
import { panelTree, openPanel } from "@workspace/runtime";

const created = await openPanel("https://example.com", { focus: true });
const same = panelTree.get(created.id);
const parent = panelTree.self().parent();
const parentInfo = parent ? await parent.getInfo() : null;
const roots = await panelTree.roots();

const all = await panelTree.list();
const existing = all.find((handle) => handle.source === "panels/spectrolite");
const byKnownSlot = panelTree.get("panel-slot-id");
await byKnownSlot.refresh(); // hydrate title/source/parent/runtime entity metadata
await byKnownSlot.navigate("panels/spectrolite", { contextId: "ctx-vault" }); // state/files only; code remains the default/current build
await byKnownSlot.navigate("panels/spectrolite", {
  contextId: "ctx-vault",
  ref: "ctx:ctx-vault",
}); // only when intentionally building code from that context branch
```

### Eval And Visible Panel Perspective

In server-side eval, `panelTree.self()` is the EvalDO runtime, not the visible
chat panel. Use `parent`/`getParent()` for the owner agent's nearest visible
panel ancestor, and use `panelTree.list()/roots()/children()` to inspect the
visible panel tree the user is talking about. If you need the chat attached to a
parent or sibling panel, read that target panel's state args:

For the complete root/child verification and cleanup pattern, see
`EVAL.md#eval-perspective`.

```ts
import { gad, panelTree, rpc, workers } from "@workspace/runtime";

const panels = await panelTree.list();
const target = panels.find((panel) => panel.id === "panel-slot-id");
const stateArgs = target ? await target.stateArgs.get<Record<string, unknown>>() : {};
const channelId = String(stateArgs.channelName ?? stateArgs.channelId ?? "");

const health = channelId ? await gad.inspectAgentHealth({ channelId }) : null;

// Optional read-only agent debug for a DO-backed agent in that channel.
const channel = channelId ? await workers.resolveService("vibestudio.channel.v1", channelId) : null;
const debug =
  channel?.kind === "durable-object"
    ? await rpc.call(channel.targetId, "inspectAgent", [
        "do:workers/agent-worker:AiChatWorker:agent-key",
        "getDebugState",
      ])
    : null;
```

Do not assume `chat.channelId` names the target panel's channel unless the user
explicitly means the current chat where the agent is responding.

`openPanel()` creates a panel owned by the workflow. Handles
from `list`/`roots`/`children`/`get` are existing panels; do not call
`handle.navigate`, `handle.reload`, or `handle.close` unless requested. Inside
the current panel, prefer `reopen({ contextId, stateArgs })` for
self-replacement of state/files. `contextId` does not select code provenance;
pass an explicit `ref` on ref-capable navigation APIs when code should come from
a context branch.

For web automation, use an owned browser panel from `openPanel("https://...")`.
Do not use the current chat panel, a parent chat panel, or another workspace
panel as a disposable browser target. `handle.cdp.navigate(url)` and
`page.goto(url)` replace/navigate the panel they target; use them only on the
browser panel you intentionally opened or on a panel the user explicitly asked
you to replace.

`PanelHandle` combines metadata, RPC, lifecycle, state, tree, and CDP:

```ts
await same.refresh();
await same.focus();
const state = await same.stateArgs.set({ mode: "review" });
// set() merges a patch and returns the full authoritative state.
// Use null to remove a key: await same.stateArgs.set({ mode: null });
await same.call.someExposedMethod();

const page = await same.cdp.lightweightPage();
await page.title();
page.url(); // string, synchronous like Playwright
await same.click("button");
```

`openPanel(source, { focus: true })` assigns a renderer and focuses the created
panel. Without focus, call `await handle.ensureLoaded()` before interactive CDP
work; it waits for a usable renderer target, while `handle.isLoaded()` reports
whether a runtime lease exists. Readable `handle.snapshot()` ensures a target is
loaded and falls back to a bounded host-captured DOM snapshot when the panel does
not expose `_agent.snapshot` (older connected hosts use the accessibility tree).

`same.cdp.lightweightPage()` returns a Playwright-style page driven by our own
lightweight, workerd-native CDP client (`@workspace/cdp-client`). It is the
single browser-automation surface — there is no separate "full Playwright" tier,
and you do not import or install any `playwright*` package. The page exposes
locators (`page.locator`, `page.getByRole`, `page.getByText`, `page.getByLabel`,
…), auto-waiting actions (`click`, `fill`, `check`, `selectOption`, …), reads
(`innerText`, `count`, `isVisible`, `getAttribute`, …), and page-level methods
(`goto`, `screenshot`, `waitForSelector`, `evaluate`, …). For protocol-level
work, `import { CdpConnection } from "@workspace/cdp-client"` and connect with
`(await same.cdp.getCdpEndpoint())`. There is no generic `same.cdp.page()` alias.

`openPanel`/`panelTree`/`PanelHandle` are part of the portable runtime surface
from `@workspace/runtime`; they work from server-side eval, panels, workers, and
DOs. The `handle.cdp.*` automation is workerd-native and runs over a WebSocket
to the panel's CDP endpoint, so eval can open or discover a panel and drive its
browser target directly.

CDP and structural operations are approval-gated on first use per requester
runtime entity and target panel. Privileged shell/about targets use a severe
danger-tone approval. CDP transparently loads unloaded targets after approval;
RPC and `_agent` introspection do not auto-load; call `handle.ensureLoaded()`
first. It refreshes metadata for `handle.call.*` / `emit(...)`. A target held by
a mobile/non-CDP host rejects CDP access.

## Userland Approval Prompts

Use `approvals.request()` only when custom userland code exposes a shared resource
to other panels, workers, DOs, or extensions and needs a user decision that
Vibestudio cannot represent as a built-in permission. The shell verifies the
issuer identity (`callerId`/`callerKind`) and shows the user a trusted consent
prompt for that custom resource.

Do **not** call `approvals.request()` for ordinary actions the caller can already
perform: context filesystem reads/writes/removes, eval work, panel operations,
browser automation, git/runtime APIs, external opens, credential use, and other
host-mediated capabilities are already protected by Vibestudio's outer permission
systems where needed.

```ts
import { approvals } from "@workspace/runtime";

const result = await approvals.request({
  subject: {
    id: "team-x:calendar-write",
    label: "Team X calendar write access",
  },
  title: "Allow calendar writes?",
  summary: "A custom calendar service wants to let this caller create Team X events.",
  warning: "Only allow this for teams you administer.",
  details: [
    { label: "Team", value: "Team X" },
    { label: "Operation", value: "Create calendar events" },
  ],
});

if (result.kind === "choice" && result.choice === "allow") {
  // Continue with the gated action.
}
```

By default the prompt shows **Allow once**, **Allow this session**, **Trust this version**, and **Deny**. Positive choices return `choice: "allow"`; deny returns `choice: "deny"`.

For a custom prompt, opt into `promptOptions: "choices"` and supply options.
If you omit `options`, the host shows a simple allow/deny prompt.

```ts
const result = await approvals.request({
  subject: { id: "team-x:calendar-write", label: "Team X calendar write access" },
  title: "Allow calendar writes?",
  promptOptions: "choices",
  options: [
    { value: "allow", label: "Allow", tone: "primary" },
    { value: "deny", label: "Deny", tone: "danger" },
  ],
});

if (result.kind === "choice" && result.choice === "allow") {
  // Continue with the gated action.
}
```

Decision caching is server-managed. Scoped prompts remember session and version
choices according to the selected scope. Custom `choices` prompts remember every
non-dismiss choice for the verified issuer and `subject.id`; the next identical
request resolves immediately with the stored choice and no prompt. Dismissal is
not remembered.

```ts
const grants = await approvals.list();
await approvals.revoke("team-x:calendar-write");
```

Use stable, provider-owned `subject.id` values such as
`team-x:calendar-write`. IDs must be 1-128 chars, use only
letters/numbers/`._:/-`, and cannot start with `shell:`, `server:`,
`system:`, or `@`. Option values must be unique, 1-40 chars, and use only
letters/numbers/`_-`; `dismiss` is reserved.

Do not use `approvals.request()` as a general confirmation dialog or a defensive
wrapper around actions the agent/runtime can already take. For host capabilities
that already have a Vibestudio permission flow, use `openExternal()`,
`credentials.*`, `git.*`, `vcs.*`, or the relevant runtime API so the host can apply the
right trust scope and audit model.

## Workspace VCS operations

Read [vibestudio-vcs](../vibestudio-vcs/SKILL.md) and the live `help("vcs")`
schema. That skill is the single maintained workflow source for semantic edits,
comparison/integration, commit/remainder handling, move/copy, external snapshot
import (including coherent non-Git multi-repository bootstrap), counteraction-based
revert, provenance, typed recovery, and protected publication.
