# Client hosts, clients and launchable client apps: refactor plan

Status: proposal (2026-10-16). Nothing here is implemented yet. Pre-release, so
every name, wire format and manifest field below may break without migration
shims; persisted state from older dev instances is discarded, not converted.

Decided (2026-10-16):

- **Clients live in the System workspace only.**
- **Desktop runs one host process with many client windows,** provided that
  clients don't contend with each other and work moves off the Electron main
  process (section 5.1.1).
- **App Store distribution does not constrain the design.** The iOS host exposes
  the same client API as Android. Store policy is a later distribution question
  (section 13).

## 1. The target in one picture

```
 ┌────────────────────────── HOSTS (root projects, native, ship in a binary) ─────────────────────────┐
 │  desktop host          terminal host          android host             ios host                    │
 │  (Electron main)       (Node CLI)             (RN native + host rt)    (RN native + host rt)       │
 │  ─────────────── every host runs @vibestudio/client-host-core (TypeScript) ───────────────         │
 │  device identity · pairing · physical connection · launch gate · client delivery + verification   │
 │  host descriptor · capability modules · intent/launch-surface projection · notification actions   │
 └───────┬──────────────────────┬────────────────────────┬────────────────────────┬──────────────────┘
         │ runtime "web"        │ runtime "terminal"     │ runtime "react-native" │ runtime "react-native"
         ▼                      ▼                        ▼                        ▼
 ┌──────────────── CLIENTS (System workspace units `clients/*`, built, admitted, integrity-verified) ──┐
 │  desktop-browser       terminal-browser        mobile-browser (one source, android + ios bundles)  │
 │  chat-desktop          chat-terminal           chat-mobile                                         │
 └───────┬──────────────────────┬────────────────────────┬────────────────────────────────────────────┘
         │ browsers host…       │                        │
         ▼                      ▼                        ▼
   panels (WebContentsView)   terminal apps (PTY)     panels (WebView)
```

- A **host** is trusted native code that ships with a binary release. It owns the
  device, the connection and the operating-system integration, and it knows nothing
  about any client's UI.
- A **client** is a workspace unit that a host downloads, verifies and runs as the
  top-level program on the device. The browsers are clients. The chat apps are
  clients. A browser is a client that additionally hosts panels or terminal apps.
- A client is built for one **runtime** (`web`, `react-native`, `terminal`). A host
  advertises which runtimes it can run. The mobile browser is one `react-native`
  client that both the Android and iOS hosts run: the build already emits one
  Metro bundle per platform from one source, and the host ABI is shared.
- Clients declare **intents** (open, open-conversation, ask, share-in…). Each host
  projects those declarations onto its platform's mechanisms: launcher
  shortcuts, App Intents, `.desktop` files, jump lists, CLI subcommands, and so on.
  That one declaration is how "launchable client apps integrate tightly into each
  host platform" without per-client native code.

## 2. Vocabulary (and what it replaces)

| New term | Meaning | Replaces |
|---|---|---|
| Host | Trusted native program per platform: desktop, terminal, android, ios | "native host", Electron main, CLI terminal command, `apps/mobile` native shell |
| Host descriptor | `{host, hostVersion, runtimes: {runtime: hostAbi}, capabilities[]}` sent at connect | `clientPlatform`, `NativeAppHost`, implicit per-target assumptions |
| Runtime | Execution environment a client is built for: `web`, `react-native`, `terminal` | `WorkspaceAppTarget` (`electron`/`react-native`/`terminal`), `AppPrincipalTarget` (`react-native-app`/`terminal-app`) |
| Host ABI | Versioned contract between a host and clients of one runtime: `web-host-N`, `rn-host-N`, `terminal-host-N` | `rnHostAbi` (RN only), `TERMINAL_BROWSER_HOST_CONTRACT_VERSION` (checked inside the client), nothing for Electron |
| Client | Workspace unit kind `client` under `clients/` | Unit kind `app`, `apps/` |
| Browser | A client that hosts panels / terminal apps | "shell", "terminal browser", "mobile app" |
| Default client | The client a host opens when nothing more specific was asked | `hostTargets.<target>.app` |
| Client intent | Manifest-declared entry point a host can project onto OS surfaces | nothing (new) |
| ClientHost (server) | Server registry: candidates, admission, release, rollback, launch | `AppHost` (2,599 lines) |

The word "app" stops naming a unit kind. The README already uses "apps" for the
things people build and open, which are panels. Today the same word also means
"privileged chrome bundle", and that clash is a constant source of confusion
(`docs/terminal-app-units-design.md` spends a paragraph saying terminal apps are
not "apps"). After this refactor, "app" is only a user-facing word.

## 3. Where we are, and why it is weird

These are the facts the plan rests on, condensed from a full mapping of both
repositories. Paths are relative to this repo unless prefixed `system/` or `base/`
(the template checkouts).

**One concept, three unrelated pipelines.** `system/meta/vibestudio.yml` maps
`hostTargets.{electron,react-native,terminal}` to `apps/shell`, `apps/mobile` and
`apps/terminal-browser`. Each target has its own build path, delivery path,
principal model, trust check and update model:

| | Electron shell | Mobile | Terminal browser |
|---|---|---|---|
| Build | `buildPanel` plus app branches (`src/server/buildV2/builder.ts:3497`, `:3577`, `:3598`, `:3885`) | extension provider runs Metro per platform (`system/extensions/react-native/index.ts`) | `buildTerminalApp` esbuild Node ESM (`builder.ts:4644`) |
| Contract check | almost none (`appBuildContract.ts`) | ABI, integrity, per-platform primaries | exactly one `.mjs` |
| Delivery | HTTP `/_a/<buildKey>/…` into a WebContentsView | `auth.getMobileAppBootstrap` + `gateway.fetch` chunks, SHA-256 checked natively | `gateway.fetch` to a 0600 temp file, `import()`; **no integrity check** |
| Principal | one shared app entity (`appHost.ts:1862`) | `DeviceAppPrincipals` `app:<source>:<deviceId>` | same as mobile |
| Updates | server-chosen `prompt` / `immediate`, "Load update" | `supervision:changed` + `appUpdatePrompt` | new `buildKey` noticed on re-grant |
| ABI check | none | `rn-host-5` in bootstrap | inside the client module (`terminal-browser/src/index.ts:17`) |

**The host knows client UI.** `src/main/menu.ts:363-651` hard-codes Settings,
Bookmarks, History and other browser surfaces; `SHELL_SURFACE_KINDS` lives in the
host. A browser change can need a binary release.

**Clients hold host secrets.** The mobile product bundle owns the Iroh transport
(`system/apps/mobile/src/services/mobileTransport.ts`) and reads the keychain
(`native-module-policy.json` allows `react-native-keychain` in
`pushNotifications.ts`). The boundary between trusted host and delivered client is
enforced by a build-time import allowlist, not by the runtime.

**Host-target resolution happens in four places:** `getHostTargetDecl`,
`HostLaunchClient.launch`, `prepareHostTarget`, and AppHost's own candidate
matching (about eight `name === x || source === normalize(x)` lookups).

**Shared chrome is written three times.** The approvals queue UI exists as
`ConsentApprovalBar` (desktop), `ApprovalSheet` / `WorkspaceApprovalSurface`
(mobile) and `approvals/approvalsClient.ts` + overlay (terminal). The same goes for
connection state, workspace switching and update prompts.

**Chat is already half-portable.** `base/packages/agentic-core/src/chat-store` is
framework-free (`ChatHostController`, `ChatSession`). The DOM panel
(`base/packages/agentic-chat`) and the Ink terminal chat
(`base/packages/terminal-chat`) both sit on top of it. `terminal-chat`'s bootstrap
input (`runtime/bootstrap.ts:38`: `rpc`, `contextId`, `sessionId`, state store,
`ChatFiles`) is already host-agnostic. Mobile has **no** native chat: it renders
the chat panel in a WebView. Its only native agent UI is Quickfire, drawn through
`quickfire-core/ui`'s skinnable primitives.

**Dead or vestigial code** found during the survey: `ensureElectronReady` (tests
only), `bakeDist` + `resources/baked-app` + `loadBakedApp`,
`getTerminalAppArtifactBaseUrl`, `HostTargetSelection*`, `build.mobileUpdateStatus`
(no client), `vibestudio:openFileDialog` (no preload), `panelPreload`'s
`openFolderDialog` / `openExternal` (their handlers reject panels), and
`appPreload.native.notifications`, which targets a non-existent main service.

**Docs out of step with code:** the Iroh pairing format is called
"compact-v3"/"compact-v4" in docs but `IROH_REACH_VERSION` is 5; the terminal host
contract is "version 2" in `docs/terminal-handover.md` but 3 in code; the
workspace-switch prefix is `Ctrl-B w` in `terminalCommand.ts:60` and
`Ctrl-Space w` in `docs/cli.md`. These go away in the doc sweep (section 11).

## 4. Target architecture

### 4.1 Hosts and `@vibestudio/client-host-core`

There are four hosts. Each is a root project.

| Host | Process model | Runtimes it runs | Notes |
|---|---|---|---|
| desktop | Electron main (Node) | `web` | One process; many client windows |
| terminal | `vibestudio` CLI (Node) | `terminal` | One client per terminal; the CLI owns the TTY |
| android | Kotlin native + a headless **host JS runtime** (Hermes) | `react-native` | Client runtimes are separate RN instances |
| ios | Swift/ObjC native + a headless host JS runtime | `react-native` | Same JS host core as Android |

**Principle: the host owns the device. A client owns only its UI and its principal
sessions.** The host owns:

- the device credential and endpoint identity;
- pairing and recovery;
- the one physical connection per reach;
- the launch gate;
- client delivery, integrity and activation;
- operating-system integration.

A client never sees the device credential. It receives principal-scoped sessions and
a versioned host API.

All four hosts run one TypeScript package, `@vibestudio/client-host-core`, so this
logic is written once:

- `HostDescriptor` construction and capability negotiation.
- The launch state machine (`clients.launch`, section 4.5) and approval relay for
  the launch gate.
- `ClientArtifactCache`: content-addressed store keyed by `sha256-…` integrity,
  fetch through `gateway.fetch` with resumable ranges, verification before
  activation, garbage collection by retained build keys. Storage is a port: Node fs
  for desktop and terminal, the existing native asset store for mobile.
- Principal grant acquisition (`auth.grantClientPrincipal`) and session opening on
  the host-owned connection.
- Update observation (`supervision:changed`) feeding a host-specific adoption policy.
- Intent resolution: an incoming deep link or OS shortcut becomes
  `{client, intent, params}`.
- Notification-action relay (section 4.7.3).

It runs in Electron main, in the Node CLI, and in the mobile **host runtime**.

The mobile host runtime is the bootstrap JS that already exists (`apps/mobile/index.js`,
1,163 lines). Today it hands over the process to the product bundle and stops. In
the target, it stays alive and headless as the device owner. Client bundles run in
their own RN instances.

**Why a mobile host runtime instead of native transport:** the session protocol
(control stream, session open/close, per-RPC streams; see
`docs/architecture/transport-sessions.md`) is implemented in TypeScript
(`packages/rpc`, `packages/iroh-transport`). Porting it to Kotlin and Swift would
make three implementations. Keeping it in one host JS runtime keeps one.

Mobile session plumbing:
- The native Iroh module keeps the QUIC connection.
- The host runtime owns the control stream and opens logical sessions.
- Each client runtime receives a *session-scoped stream capability*: it may open
  RPC streams only for session IDs the host granted it. The native module enforces
  that.
- Per-RPC traffic does not hop through the host runtime.

This replaces today's arrangement, where the product bundle owns the transport and
reads the keychain.

### 4.2 Runtimes and host ABIs

Each runtime has one versioned host ABI. The ABI is the complete contract a client
may rely on: globals, bridge methods and lifecycle.

- `web-host-N`
  - Provides: the client preload bridge (`__vibestudioClient`), the transport, and
    capability-gated host modules.
  - Today's `appPreload.ts` surface, reduced to what section 5.1 keeps.
- `terminal-host-N`
  - Provides: the `TerminalBrowserHost` contract (`packages/shell-core/src/terminal/terminalBrowserHost.ts`,
    currently v3), renamed `TerminalClientHost`.
  - Additions: `files` with local consent, `clipboard`, `notify`, `intent` (launch
    params), and `state` (client-scoped persisted state).
- `rn-host-N`
  - Provides: the host modules a client RN instance may call, plus the session
    capability above.
  - `native-module-policy.json` stops being a build-time allowlist over raw native
    packages. Instead, the client bundle can only import `@vibestudio/rn-client-api`.
    Every native module a client may reach is exposed through that API and gated by
    host capability at runtime.
  - Raw sensitive modules (keychain, Iroh, FCM token) are not registered in client
    instances at all.

The manifest declares `hostAbi`. The **host** checks it before executing anything,
on every runtime. The terminal-browser's self-check inside the module goes away.

### 4.3 The client unit

```jsonc
// system/clients/chat-terminal/package.json
"vibestudio": {
  "client": {
    "id": "chat",                       // shared across runtime variants of one product
    "runtime": "terminal",              // web | react-native | terminal
    "hostAbi": "terminal-host-1",
    "entry": "src/index.ts",            // web: renderer page; RN: root component module
    "title": "Chat", "icon": "assets/icon.png",
    "capabilities": {                   // host affordances; required vs optional
      "required": ["device-session"],
      "optional": ["notifications", "local-files", "clipboard"]
    },
    "intents": [ … ],                   // section 4.7
    "integration": { … }                // per-host hints (window size, terminal command name)
  },
  "authority": { "requests": [ … ] }    // unchanged authority model
}
```

**Kind and layout**
- `BuildableUnitKind` `"app"` becomes `"client"`.
- `apps/` becomes `clients/` in `WORKSPACE_SOURCE_DIRS` and `WORKSPACE_IMPORT_PARENT_DIRS`.
- The package scope becomes `@workspace-clients/`.

**One runtime per unit.** The three toolchains (DOM esbuild, Metro, Node esbuild)
have disjoint dependency sets (react-dom, react-native, ink). Mixing them in one
`package.json` would make one build produce three unrelated artifact graphs.

**`id`** ties runtime variants into one product. It serves:
- runtime-agnostic deep links: `vibestudio://c/chat/...` opens whichever chat
  variant runs on this host;
- "install on my other devices";
- notification routing.

The unique key is `(workspace, id, runtime)`. ClientHost rejects duplicates at
reconcile.

**Removed fields:** `startupModules`, `rnComponentName`, `nativeModulePolicy`, and
the `main/preload/window` prohibitions disappear from `validateAppBlock`. Each is
either replaced (`entry`, `hostAbi`, the RN client API) or no longer needed.

### 4.4 Trust, principals, authority

**Where clients live.** Clients live in the **System** workspace. This keeps
today's rule (`hostedDeclarations` drops app declarations outside System) and
matches the request: "from system workspace to a runnable client app".

**`trust.clients`** replaces `trust.chromeApps`. It lists the clients allowed the
device-level capabilities:
- `device-session`: the device shell session for routed workspaces;
- `panel-hosting`;
- `terminal-app-hosting`;
- `approval-surface`;
- `hub-control`.

The browsers and the three chat clients are all listed. A trusted client owns the
device surface, and it is the thing that renders approvals, so the invariant
"approvals an agent can't fake" still rests on admitted, integrity-verified System
code.

**One principal model**
- Every running client instance is `client:<id>:<runtime>:<deviceId>`, granted by
  `auth.grantClientPrincipal`.
- The grant is one-use and bound to the requesting endpoint and to the exact build
  (`buildKey`, `executionDigest`).
- The Electron shared app entity goes away; the desktop browser becomes a
  device-scoped principal like the others.
- `DeviceAppPrincipals` is renamed and generalized.
- `AppPrincipalTargetSchema` is deleted.

**Clients from other workspaces** (for example, someone vibe-codes a client in
Personal) are out of scope by decision. ClientHost keeps rejecting client
declarations outside System. Allowing them would require a host-composed approval
overlay that a non-trusted client cannot draw over:
- desktop: an overlay view (the infrastructure exists);
- mobile: a host-runtime sheet;
- terminal: a host compositor.

The capability split above already separates "may render approvals" from "is a
client", so lifting that rule later does not reopen this model.

### 4.5 One launch and delivery pipeline

Resolution moves server-side into one RPC. `HostLaunchClient`'s client-side
config reading, `prepareHostTarget` and AppHost's matching all collapse into it:

```
clients.launch({ host: HostDescriptor, select: {default} | {id, intent?} | {source} , rollbackTo? })
  → { state: "approval-required", approval }       // install review, RN preflight, capability consent
  | { state: "preparing", progress }               // build / required extensions
  | { state: "ready", client: { source, id, runtime, buildKey, executionDigest, hostAbi,
                                artifacts: [{ path, role, platform?, integrity }],
                                grantedCapabilities, deniedOptional } }
  | { state: "unavailable", reason }               // no candidate for this runtime/ABI, etc.
```

The host then:
1. checks `hostAbi`;
2. fetches missing artifacts into `ClientArtifactCache` and verifies each `integrity`;
3. calls `auth.grantClientPrincipal`;
4. instantiates the client with its host API.

`clients.launch` is a pushed/awaited state machine. The Electron launch gate's
500 ms `get-state` polling goes away.

What changes per host:
- **Desktop.** Clients load from the verified cache through a host-registered
  protocol (`vs-client://<buildKey>/…`, `protocol.handle`), not from
  `http://127.0.0.1/_a/…`. That gives Electron the same integrity guarantee mobile
  has, the same code path for local and remote servers, and offline cold start of
  the last verified build. The remote-mode asset facade stays for **panels** only.
- **Terminal.** Clients import from the verified cache. The temp-file dance and the
  missing integrity check go away.
- **Mobile.** Today's `bundleDelivery.ts` becomes the RN storage port of the shared
  cache.

Integrity becomes part of every client build contract, not just React Native's.
`validateAppBuildContract` becomes `validateClientBuildContract` with one rule set:
- every artifact has an integrity value;
- exactly one primary per platform;
- runtime-specific shape checks.

### 4.6 Updates

The server announces; the host decides.
- `supervision:changed` carries the new ready build.
- `appAdoptionPolicy` (server-side, per target) is deleted.

Each host's `client-host-core` applies its own policy:
- **Desktop:** prompt, then swap the window's view; this keeps the existing pending-update persistence.
- **Terminal:** offer a restart at a safe point; otherwise use the new build at next launch.
- **Mobile:** prompt, then reload that client's RN instance only, not the whole app.

"Load update" stops being Electron-only.

### 4.7 Intents and launch surfaces: the integration model

This is the core of "tightly integrate launchable client apps into each host
platform".

**Declaration.** A client declares intents in data. Each host projects them onto
whatever its platform offers. No client ships native code, and no host knows a
specific client.

```jsonc
"intents": [
  { "name": "open",              "kind": "foreground" },                       // implicit for every client
  { "name": "open-conversation", "kind": "foreground",
    "params": { "channel": "string" }, "dynamic": "chat.recentConversations" },
  { "name": "ask",               "kind": "background",
    "params": { "prompt": "text" }, "handler": "vibestudio.channel.v1#ask",
    "result": "text-stream" },
  { "name": "share-in",          "kind": "foreground",
    "accepts": ["text/*", "image/*", "application/pdf"] }
]
```

#### 4.7.1 Foreground intents

The host launches (or focuses) the client and passes `{intent, params}` through the
host ABI. Rules:
- An already-running client receives the intent as an event.
- Deep links use one runtime-agnostic grammar:
  - `vibestudio://c/<id>/<intent>?…`
  - `https://vibestudio.app/c/<id>/<intent>#…` (App Links and Universal Links)
- The host resolves `<id>` to the variant for its own runtime.
- The existing `vibestudio://panel` and pairing links become intents of the
  browser (`open-panel`) and of the host itself (`pair`).

#### 4.7.2 Background intents

These run **server-side**, never as client code on the device. The host:
1. calls `clients.invokeIntent({id, intent, params})` on the device session;
2. receives the declared result type;
3. renders it with platform UI: a Siri response, a notification, stdout, a widget
   snapshot.

This is what makes "Ask Vibestudio" from Siri, from an Android tile, from a desktop
global shortcut, and `echo … | vibestudio chat ask` the same feature.

The handler is a workspace service method named by the manifest. It is subject to
the client principal's authority, so the same review and grants apply.

#### 4.7.3 Notification actions

Notification actions are server-defined and relayed by the host. They work the same
way:
- A notification carries `{notificationId, actions: [{id, title, input?: "text"}]}`.
- The host renders native actions: reply fields on Android `RemoteInput`, iOS
  `UNTextInputNotificationAction`, macOS `hasReply` and Windows toast input.
- The host returns the person's choice with `notifications.respond(notificationId,
  actionId, text?)`.
- The producer (agent channel, approval queue) handles it.

Today's approve/deny background handlers in the mobile product bundle
(`backgroundHandlers.ts`, `notificationCategories.ts`) move out of client code
entirely. Approving from a lock screen should not require a client JS runtime.

#### 4.7.4 Dynamic entries

`"dynamic": "<service method>"` lets a host ask for a small list (recent
conversations, pinned channels) to populate shortcut menus, jump lists, App
Intents entity queries and widgets.

The host caches the result on device with the client's integration snapshot. It
refreshes the cache on launch and on a server event, not by timer.

#### 4.7.5 Host projection matrix

| Surface | desktop | terminal | android | ios |
|---|---|---|---|---|
| Install / remove a launcher for a client | `.desktop` file (Linux), Start-menu `.lnk` with its own AppUserModelID (Windows), launcher `.app` in `~/Applications` (macOS) | `vibestudio <command>` plus an optional `~/.local/bin` shim | pinned shortcut (`ShortcutManagerCompat.requestPinShortcut`) | App Shortcut / Shortcuts-app home-screen action via App Intents; Control Center control (iOS 18) |
| Per-client OS identity while running | window AUMID (Windows); Linux and macOS: see spike S1 | terminal title / tab | own Recents task with label and icon (`FLAG_ACTIVITY_NEW_DOCUMENT` + `TaskDescription`) | own scene on iPad (multi-scene); single window on iPhone |
| Static and dynamic shortcut menus | Dock menu (macOS), jump list (Windows), `.desktop` `Actions=` (Linux) | shell completions | launcher long-press dynamic shortcuts | Home-screen quick actions (`shortcutItems`) |
| Background `ask` | global shortcut → host mini-prompt window (optional `tray`) | `vibestudio chat ask "…"` / stdin, streamed to stdout | Quick Settings tile, widget | Siri / Shortcuts / Action button App Intent, interactive widget |
| Share-in | drag onto dock or taskbar icon (`open-file`); macOS Services | `vibestudio chat --attach FILE`, stdin | `ACTION_SEND` intent filter on the host, routed to clients that accept the type | share extension → App Group inbox → host |
| Notifications with reply | macOS `hasReply`, Windows toast input, Linux portal where supported | OSC 9 / OSC 777 / OSC 99 desktop notifications, bell | conversation notifications, `RemoteInput`, bubbles | `UNTextInputNotificationAction` |
| Glanceable status | tray / badge (`app.setBadgeCount`) | title / bell | Glance widget | WidgetKit widget, Live Activity for a running agent turn (APNs push updates) |

**Installing a launcher** is a host-mediated, person-initiated action. A browser or
chat client calls `host.integration.install({id})`; the host confirms in its own UI
and writes the OS artifact. The host records every integration it wrote in host
state and removes it when the client is uninstalled or retired. That cleanup is
reconciled on the `clients:changed` event, not by scanning on a timer.

### 4.8 Server: ClientHost replaces AppHost

`src/server/appHost.ts` (2,599 lines) becomes `src/server/clients/` with three
parts:

- **`clientRegistry.ts`**
  - Declarations, candidates (`listClients({runtime, hostAbi})`), admission,
    release and rollback. Runtime-agnostic, on top of the existing `UnitHost`.
  - Resolves the default client from `clients.defaults` in
    `system/meta/vibestudio.yml`:

    ```yaml
    clients:
      - source: clients/desktop-browser
      - …
    defaults:          # per host, not per runtime: android and ios may differ later
      desktop: clients/desktop-browser
      terminal: clients/terminal-browser
      android: clients/mobile-browser
      ios: clients/mobile-browser
    requiresExtensions:
      react-native: [extensions/react-native]
    trust:
      clients: [clients/desktop-browser, clients/terminal-browser, clients/mobile-browser,
                clients/chat-desktop, clients/chat-terminal, clients/chat-mobile]
    ```

- **`clientLaunchService.ts`**
  - `clients.launch`, `clients.invokeIntent`, `clients.list`,
    `clients.integrationSnapshot`.
  - `auth.grantClientPrincipal`.
- **`clientBuildContract.ts`**

**Deleted:**
- the per-target special cases: `ensureElectronReady`, `prepareElectronArtifact`,
  `electronReadinessSnapshot`, the literal three-target loop in `prepareRelease`,
  and Electron-only update notices;
- `ReactNativeAppAdapter`'s duplicate readiness;
- the dead items from section 3.

Readiness is generic. "Required extensions are active and the client's build is
admitted and ready" is the same check for every runtime.

**Status values** are made consistent. `isCapabilityActiveStatus` is used
everywhere instead of the `"running"` checks in principal registration and
bootstrap.

### 4.9 Builds

`buildApp`'s `APP_TARGET_ADAPTERS` becomes `CLIENT_RUNTIME_ADAPTERS`:

- **`web`** gets a first-class `buildClientPage`. It shares the browser-bundle core
  with `buildPanel` through an extracted function, not through app branches inside
  `buildPanel`. Output: a page plus assets, all with integrity.
- **`terminal`** is a self-contained Node ESM bundle. It shares `bundleNodeProgram`
  with extensions and terminal apps (the extraction proposed in
  `docs/terminal-app-units-design.md`), minus the runtime-deps projection, because
  a client must run outside the workspace sandbox. Output: one primary `.mjs` with
  integrity.
- **`react-native`** stays an extension provider (`system/extensions/react-native`).
  Output: per-platform primary bundles plus assets, as today. Spike S5 asks whether
  shipping Hermes bytecode instead of minified source is worth it.

## 5. Per-host design

### 5.1 Desktop host

**Layout and structure.** Move `src/main`, `src/preload` and `src/bootstrap` to
`hosts/desktop/`. Split the 3,625-line `src/main/index.ts` along the boundaries the
new model gives it:
- startup and connection: `serverSession`, already separate;
- the client-host-core adapter;
- the window/client manager;
- permission policy;
- the protocol and intent router;
- the updater;
- OS integration.

**Many clients, one process.** A `ClientWindow` replaces the singleton
`ApplicationWindowController` + `AppOrchestrator` pairing:
- Each client instance owns one `BaseWindow` and one top-level `WebContentsView`.
- Clients with `panel-hosting` also get the `ViewManager` / `PanelView` machinery.
  The chat client does not.
- One process keeps one Iroh endpoint and one physical connection. Two processes
  with the same endpoint identity would supersede each other (see
  "Recovery" in `docs/architecture/transport-sessions.md`).

**Cutting the host ↔ browser coupling**
- The application menu becomes client-contributed through the `native-menus`
  capability. The host keeps only a minimal role menu (Edit/Window/Quit) and asks
  the focused client for the rest. `SHELL_SURFACE_KINDS` and the hard-coded
  Settings/Bookmarks/History entries leave the host.
- The `"shell"` caller identity that conflates the bootstrap launch gate with
  hosted chrome is split:
  - the launch gate is host UI with its own sender identity;
  - every client is a client principal.

  This removes the special cases at `index.ts:2776-2805` and `:3013-3059`.
- `window-management` is renamed to what it gates (`theme`, `devtools`), or split
  per API.

**Capabilities and the bridge**
- New desktop capabilities: `global-shortcut`, `tray`, `badge`,
  `notifications.reply`, `integration.install`. Each is host-mediated and appears
  in the capability catalog with `hosts: ["desktop"]`.
- The dead bridges listed in section 3 are removed. Whatever is still needed goes
  behind a capability on `__vibestudioClient`.

**OS launchers**
- **Linux:** `~/.local/share/applications/vibestudio-<ws>-<id>.desktop` with
  `Exec=vibestudio --client <id>`.
- **Windows:** Start-menu `.lnk` with `System.AppUserModel.ID` set, plus
  `BaseWindow.setAppDetails({appId})` per client window. Each client then gets its
  own taskbar group and jump list.
- **macOS:** a generated launcher `.app` (Info.plist + icon + a tiny exec stub that
  opens `vibestudio://c/<id>/open`). The window still belongs to the Vibestudio Dock
  icon unless spike S1 finds a sound per-client Dock identity.

**Second-instance and protocol handling** already exist (`protocolHandler.ts`,
single-instance lock). They become the intent router.

#### 5.1.1 One process, no contention: what leaves the Electron main process

**Where the work runs today.** There is no `utilityProcess` anywhere in `src/main`.
Every byte of every renderer's server RPC goes through main:
- `IpcDispatcher` (`src/main/ipcDispatcher.ts:179`) relays `vibestudio:rpc:send`
  envelopes;
- `desktopIrohConnectionSupervisor.ts` runs the native Iroh endpoint and the
  session mux in main;
- the remote asset facade (`startPanelAssetFacade`) is an HTTP server in main.

`ipcResponsiveness.ts` exists because a blocked main loop already shows up as
queued, slow IPC. Adding a second and third client window on top of this would
multiply that contention.

**The rule.** Main does only what Electron requires to happen in main:
- window and view lifecycle;
- OS integration (menus, Dock, tray, jump lists, notifications, global shortcuts,
  protocol and second-instance events);
- permission and media prompts;
- `protocol.handle`;
- the APIs bound to `webContents` (debugger/CDP attach, find-in-page, print,
  downloads' `DownloadItem`).

Everything else moves out.

**Connection process** (`utilityProcess.fork`, one per desktop host):
- The Iroh endpoint, loopback WebSocket clients and the logical-session mux.
- `client-host-core`: launch, the artifact cache and integrity hashing,
  principal grants, update observation.
- The panel asset facade.
- `HubProcessManager` (spawning the detached local server).
- The persistence that currently runs in main, such as history recording and
  browser import. P0 spike S7 produces the exact inventory.

The device credential and endpoint secret are read only here.

**Direct ports, no relay.**
1. When main creates a client or panel view, it asks the connection process to open
   that principal's session.
2. It hands the renderer a `MessagePortMain` connected straight to that session
   (`MessageChannelMain`). Main transfers the port once and never sees the traffic.
3. The session is already bound server-side to the principal, so the connection
   process never trusts claims from a renderer.

**What still uses IPC to main.** The small set of Electron-local services: view,
menu, the window parts of the app service, and panel-shell operations that touch
`webContents`. `IpcDispatcher` shrinks to that local dispatch, and its relay path
is deleted.

**Isolation between clients**
- Each client window has its own renderer process (already true for every
  `WebContentsView`). A crashed or busy client cannot stall another, and
  `rendererRecovery.ts` handles per-view crashes.
- The connection process schedules sessions fairly. Each logical session already
  has its own QUIC streams, so one client's streaming chat does not queue behind
  another's bulk fetch.

**Connection-process loss** is an authoritative terminal event, not a timeout:
1. Main observes the process exit.
2. Every session settles with that failure.
3. Main restarts the process.
4. Sessions recover through the existing `resubscribe` / `cold-recover` semantics
   (`docs/architecture/transport-sessions.md`).

Windows stay open and show the workspace-unavailable state from `connection-core`.

**What remains in main, and is watched.** CDP traffic must pass through main,
because `webContents.debugger` lives there. Main forwards those messages without
parsing them and keeps the bytes out of main's own logic. If profiling shows CDP
screenshots or tracing contend, the fix is a bounded, flow-controlled forwarding
path, measured, not more work in main.

**Gate.** A multi-client load scenario must keep the main event-loop lag and IPC
latency within a budget agreed in P0:
- desktop browser with several panels;
- chat client streaming a long turn;
- a CDP-driven panel.

It is measured with the System `skills/performance` workflow and the existing
responsiveness reporter.

### 5.2 Terminal host

Move `src/cli/terminal/*` to `hosts/terminal/`. The CLI depends on it.

**Commands**
- `vibestudio terminal` opens the default client (the terminal browser).
- `vibestudio open <id> [intent] [--param …]` opens any terminal client.
- Clients may declare `integration.terminal.command`. That registers
  `vibestudio <command>` (for example `vibestudio chat`) when the name does not
  collide with a built-in CLI command. ClientHost rejects collisions at reconcile,
  against a host-published reserved list.
- `vibestudio clients link <id> [--name vchat]` writes a shim to `~/.local/bin`.
  `unlink` removes it.

**Non-interactive mode.** When stdin or stdout is not a TTY and the intent is
`background`, the host runs `clients.invokeIntent` and streams the result to
stdout. No client module is loaded. `git diff | vibestudio chat ask "review this"`
works as a consequence of section 4.7.2, not as a chat-specific feature.

**`TerminalClientHost` (ABI `terminal-host-1`)** is today's v3 contract plus:
- `intent` (launch params);
- `files` (local filesystem, consent per path, the existing 8 MB-limited
  upload/download plus local read for attachments);
- `clipboard` (OSC 52 write through the host, so clients stop hand-rolling it);
- `notify` (OSC 9 / 777 / 99 by detected terminal);
- `state` (client-scoped persisted settings, today `terminalApps.get/setSettings`).

`guardTerminal` / TTY restore stays host-owned.

**Credentials.** The CLI device credential file stays as it is (0600 atomic). The
desktop host uses OS secret storage where available. That alignment is a separate,
optional item, not in this plan.

### 5.3 Android host

Move `apps/mobile/android` to `hosts/android/`. The shared RN JS (host runtime,
`index.js`, Metro config, `metroNativeBoundary.cjs`, the `mobile-iroh` package)
moves to `hosts/react-native/`. Android points at it through
`react-native.config.js` project paths (spike S4 verifies autolinking with that
split).

**Host runtime and client instances**
- The host runtime is a headless RN instance started by `MainApplication` that owns
  the device (section 4.1).
- Each client is its own RN instance, loading a verified bundle from the cache.
- A client opened from a pinned shortcut, share or notification starts as its own
  document task (`FLAG_ACTIVITY_NEW_DOCUMENT | FLAG_ACTIVITY_MULTIPLE_TASK` on a
  `ClientActivity`). Each task carries a `TaskDescription` (title, icon from the
  client's integration snapshot), so chat and the browser appear as separate cards
  in Recents.
- Memory per extra Hermes instance must be measured (spike S3). When memory is
  tight, a background client instance is destroyed and cold-started from cache;
  durable state lives server-side anyway.

**Platform integration**
- **Pinned shortcuts** are the "install" for Android. Dynamic shortcuts are filled
  from intents with `dynamic` sources. A WebAPK-style separate install is not
  available outside Chrome, and Android has nothing better for a single APK.
- **Share target:** one `ACTION_SEND` / `ACTION_SEND_MULTIPLE` filter on the host.
  The host shows a chooser among clients whose `share-in` accepts the MIME type.
  Direct share targets come from conversation shortcuts.
- **Conversation notifications** (`MessagingStyle` + long-lived conversation
  shortcuts), direct reply through `RemoteInput` relayed by
  `notifications.respond`, and **bubbles**. A bubble's activity is a `ClientActivity`
  showing the chat client with the conversation intent.
- **Quick Settings tile** (`TileService`), declared once in the host. It invokes
  the default "ask" intent or opens the chat client.
- **Glance widget** rendering the integration snapshot (recent conversations, an
  Ask button).
- The existing items stay host-owned: USB provisioning, loopback OAuth, verified App
  Links and WebView profiles.

### 5.4 iOS host

Move `apps/mobile/ios` to `hosts/ios/`. It shares `hosts/react-native` with Android.

**Host runtime and clients**
- The same host-runtime / client-instance split as Android.
- Clients map to UIScenes:
  - on iPad, each client may be its own scene (multi-window);
  - on iPhone, one scene at a time, and switching swaps the scene's root view
    without discarding a still-warm client instance.

**App Intents.** The iOS version of "install" is generic App Intents compiled into
the host once:
- `OpenClientIntent(client: ClientEntity, intent: ClientIntentEntity?)`
- `AskIntent(client: ClientEntity, prompt: String)`

Both are backed by dynamic `EntityQuery`s over the integration snapshot. An
`AppShortcutsProvider` exposes "Ask Vibestudio" and "Open \(client) in Vibestudio"
with `updateAppShortcutParameters()` after the snapshot changes.

These surface in Siri, Spotlight, the Shortcuts app, the Action button and Control
Center controls. From Shortcuts, a person can add any of them to the Home Screen
with its own name and icon. Home-screen quick actions (`shortcutItems`) are set
from the snapshot.

**WidgetKit, Live Activities and notifications**
- A WidgetKit extension reads the snapshot from an App Group container written by
  the host runtime. An interactive widget button runs `AskIntent` / `OpenClientIntent`.
- A Live Activity shows a running agent turn. The server pushes updates over APNs
  ActivityKit tokens; the host registers the token through `notifications.*`.
- `UNTextInputNotificationAction` categories are generated from server-declared
  actions.

**Share extension.** A small native UI writes the shared items to the App Group
inbox and posts a local notification. The host runtime ingests the inbox on its next
activation and routes the items to the chosen client's `share-in`.

A share extension cannot reuse the host's QUIC connection. Dialing from the
extension with the same endpoint identity would supersede the app's connection, so
the extension never dials.

**App Store policy** (guidelines 2.5.2 and 4.7) does not constrain this design (by
decision). The iOS host exposes the same `rn-host` API and capabilities as Android.
TestFlight and self-built distribution are the targets.

If Store distribution becomes a goal later, the refactor already narrows the
question:
- client bundles reach only a declared, capability-gated host API;
- the host owns all native surfaces.

A Store build would therefore be a host-side capability profile, not a redesign.

## 6. Client kits: shared chrome so a new client is small

New System packages, one per runtime, built on shared headless cores.

| Headless core (no UI) | `client-kit-web` | `client-kit-native` | `client-kit-terminal` |
|---|---|---|---|
| `approvals-core`: queue, protected inputs, decisions (from `terminal-browser/src/approvals`, `ConsentApprovalBar`, `ApprovalSheet`) | approval bar + dialogs | approval sheet | approvals overlay |
| `connection-core`: workspace availability, reconnect state | banner | banner | status line |
| `workspace-core`: list, switch, selected workspace | switcher | drawer | picker |
| `client-update-core`: pending update, apply | prompt | prompt | prompt |
| `provider-signin-core`: OAuth start/paste-back | flow | flow (`ASWebAuthenticationSession` / loopback via host) | flow (existing paste-back) |

Both browsers and chat clients use the kits. Extracting them from the three
browsers is part of the refactor. They have to be extracted before any chat client
exists, or the chat clients would become the fourth copy.

`approvals-core` must keep the terminal browser's guarantee that protected inputs
are typed only into trusted chrome.

## 7. Proving it: the chat clients

All three chat clients sit on the existing headless core
(`agentic-core/chat-store`, `chat-presentation`, `pubsub`). They connect to the
selected workspace (Personal by default) over the trusted device session, like the
browsers. They do **not** host panels:
- inline interactive UI that is a panel opens in the browser through a host intent
  (`open-panel` on the browser client);
- or, on desktop and mobile, it opens in an embedded single-panel view where the
  kit offers one (a later item, not needed for the proof).

### 7.1 `clients/chat-terminal` (first: smallest, proves the whole pipeline)

- **Contents.** `@workspace/terminal-chat` (already Ink over the headless core) plus
  `client-kit-terminal`.
- **Wiring.** `runTerminalChat`'s bootstrap input is supplied by the host:
  - `rpc`: the client principal's session;
  - `state`: `host.state`;
  - `files`: `host.files`, the **local** cwd, which the terminal-app variant cannot
    offer because it runs in the workspace sandbox.
- **Terminal integration.** `integration.terminal.command: "chat"`. It also declares
  `ask` as a background intent.
- **Shared code.** `base/terminal-apps/chat` keeps existing and shares
  `terminal-chat`. The terminal app is the "chat as a tab of the terminal browser,
  running in the workspace" form; the client is the "chat as the program in this
  terminal" form.
- **Acceptance:**
  - `vibestudio chat` on a fresh instance pairs, launches, reviews and runs.
  - Approvals appear in the client's overlay.
  - `echo hi | vibestudio chat ask` streams a reply.
  - Ctrl-C restores the terminal.
  - A rebuilt client is offered at a safe point.

### 7.2 `clients/chat-desktop`

- **Contents.** `@workspace/agentic-chat` (the DOM UI already used by the chat
  panel) plus `client-kit-web`. It is a single-window client, with a conversation
  list beside the transcript.
- **Panel adapter.** `ChatHostPorts` is implemented against the client host instead
  of the panel runtime. This is a sibling of `createPanelHostPorts()` in
  `base/panels/chat/index.tsx:100`. Moving `ChatHostPorts` adapters next to
  `ChatHostController` makes both the panel and the client thin.
- **Integration:**
  - "Install Chat" adds an OS launcher (section 5.1);
  - a global shortcut opens a compact ask window (background `ask` intent, streamed);
  - notifications with reply;
  - a Dock menu or jump list of recent conversations.
- **Acceptance:**
  - launched from the OS launcher, it runs as its own window with its own taskbar
    identity on Windows;
  - conversations, approvals and an update swap work;
  - the browser and chat run side by side in one process over one connection.

### 7.3 `clients/chat-mobile`

- **The work.** This is the one real new UI. Today mobile chat is the DOM panel in a
  WebView.
- **Contents.** `@workspace/agentic-chat-native`: an RN renderer over the same
  `ChatSession` and `chat-presentation` derivations. Start from
  `quickfire-core/ui`'s skin primitives, which already render an agent conversation
  natively on mobile. Generalize them where the transcript needs more (markdown,
  tool cards, attachments, forks). Inline UI cards that are panels render in a
  WebView card through the kit.
- **Integration:**
  - pinned shortcut (Android);
  - App Intents / Shortcuts (iOS);
  - share-in;
  - conversation notifications with reply;
  - Quick Settings tile / Action button "Ask";
  - widgets and Live Activity are phase 6, not required for the proof.
- **Acceptance (Android emulator, end to end):**
  - the pinned shortcut opens chat as its own Recents task next to the browser;
  - replying from a notification while the client is not running works;
  - sharing a text to Vibestudio routes to chat.
- **Acceptance (iOS simulator):** the same flow minus push, using the runbook in
  `docs/iphone-app-handover-2026-09-29.md`. Automated iOS smoke remains unsupported
  (`scripts/cli/mobile-smoke.mjs:2110`). Building it is item P5.7.

## 8. Repository and template layout

```
vibestudio/
  hosts/
    core/            @vibestudio/client-host-core   (new; from HostLaunchClient, bundleDelivery, grant code)
    desktop/         from src/main, src/preload, src/bootstrap
    terminal/        from src/cli/terminal (+ terminalLaunchGate, openExternalBrowser)
    react-native/    from apps/mobile/{index.js, connectLinkRouter.js, metro*}, packages/mobile-iroh
    android/         from apps/mobile/android
    ios/             from apps/mobile/ios
  src/server/clients/                           (from appHost.ts, deviceAppPrincipals.ts, reactNativeAppAdapter.ts)
  packages/headless-renderer/                   (from apps/headless-host: it is the server's panel renderer, not a client host)
  services/webhook-relay/                       (from apps/webhook-relay: a Cloudflare service)
  # apps/ is gone

vibestudio-templates/system/
  clients/desktop-browser    (from apps/shell)
  clients/terminal-browser   (from apps/terminal-browser)
  clients/mobile-browser     (from apps/mobile)
  clients/chat-desktop | chat-terminal | chat-mobile     (new)
  packages/client-kit-{web,native,terminal}, approvals-core, connection-core, …  (extracted)
  extensions/react-native    (unchanged role: RN build provider)
```

The Electron `--headless-host` mode (`startupInvocation.ts`) and
`apps/headless-host` share a name but nothing else. The rename to
`headless-renderer` ends the "two headless hosts" confusion.

## 9. Phases, dependency graph, parallelism

```
P0 decisions + spikes ─┬─▶ P1 mechanical moves ─▶ P2 model cut ─┬─▶ P3 delivery + host core ─┬─▶ P5 chat clients ─▶ P6 deep integration
                       │                                         └─▶ P4 client kits ──────────┘          ▲
                       └──────────── S1–S5 results feed P3 (mobile host runtime) and P6 ──────────────────┘
```

**P0. Decisions and spikes** (section 12). These run in parallel, are
investigation-only, and each has a written outcome.

**P1. Mechanical moves, no behavior change**
- *Host repo:* `apps/` → `hosts/`, `services/`, `packages/headless-renderer`; `src/main` etc. → `hosts/desktop`.
- *Templates:* `apps/*` → `clients/*`; package names.
- *Shared fixes:* build configs, electron-builder paths, CI workflows (`check:workflows`), Metro roots.
- *Gate:* full build + unit tests + `check:*` + Android smoke unchanged.
- *Ordering:* first, because every later diff then lands at its final path.
- *Edit ownership:* host repo and templates are disjoint and can be edited in
  parallel, with one coordinated cut of the System template release pin.

**P2. Model cut (hard break)**
- *Contract and manifest:* `UnitKind client`; manifest schema; `HostDescriptor`;
  capability catalog keyed by host; `trust.clients`; `clients.defaults`.
- *Server:* ClientHost; `clients.launch`; `auth.grantClientPrincipal`; deletion of
  `AppPrincipalTarget`, `hostTargets`, the per-target special cases and the dead code.
- *Hosts:* the three existing hosts adapt to `clients.launch` without yet changing
  their delivery mechanics.
- *Gate:* all three browsers launch through the new path; system tests green.
- *Parallelism:* the server and shared-schema work blocks the host adaptations.
  The three host adaptations are then independent.

**P3. Uniform delivery and `client-host-core`** (needs P2)
- *Package:* extract `client-host-core`; `ClientArtifactCache` with storage ports;
  integrity for all runtimes.
- *Desktop:* the `vs-client://` protocol, plus the **connection utility process**
  with per-session `MessagePort`s. `client-host-core`, Iroh, the asset facade and
  the hub spawner move into it, and the main-process relay is deleted
  (section 5.1.1; depends on S7).
- *Desktop gate:* the multi-client main-loop budget.
- *Terminal:* verified import.
- *Mobile:* the **host runtime + client-instance split** with the session-scoped
  stream capability. This is the largest item; it depends on S3.
- *Updates:* host-side update policy.
- *Parallelism:* the package work comes first. Then the desktop, terminal and mobile
  adapters are independent.

**P4. Client kits** (needs P2; parallel with P3)
- *Cores:* extract `approvals-core`, `connection-core`, `workspace-core`,
  `client-update-core` and `provider-signin-core`.
- *Browsers:* rebase the three browsers on the kits.
- *Gate:* behavior parity in each browser, and its existing system tests pass.
- *Parallelism:* one owner per runtime kit after the cores land.

**P5. Chat clients** (needs P3 + P4)
- *Clients:* `chat-terminal` first, then `chat-desktop` and `chat-mobile` in parallel.
- *Foundations:* `ChatHostPorts` adapters move next to the core;
  `agentic-chat-native` is built.
- *Intents and launchers:* the intent schema and `clients.invokeIntent`, the
  foreground-intent router in each host, `notifications.respond`, and launcher
  install/remove on all hosts (sections 4.7, 5.x first rows).
- *Tests:* P5.7, the iOS simulator smoke runner.

**P6. Deep integration** (after the proof; each item independent)
- Dynamic shortcut menus and jump lists, Android bubbles/tile/widget, iOS
  widgets/Live Activities/Controls/share extension, desktop tray and badges, and
  terminal shims and completions.
- Each item is its own small plan and test.

Serialization justification. These are the only real edges:
- P1 → P2: shared files. Moving and rewriting the same files concurrently causes
  conflicts.
- P2 → P3/P4: the shared schema.
- P3 → P5: chat clients need the host APIs.
- P4 → P5: chat clients need the kits, or they duplicate chrome.

## 10. Verification

- **Unit and contract tests.**
  - `clientBuildContract` per runtime;
  - `clients.launch` state machine;
  - principal grant binding (endpoint, build);
  - capability negotiation (required missing ⇒ `unavailable`; optional ⇒ denied
    list);
  - intent parameter validation;
  - integration-artifact bookkeeping (install, remove, reconcile on retire).
- **Template tests** run through `pnpm test:userland -- --template system --filter …`
  and `pnpm type-check:userland -- --template system`. They are never run inside
  the template checkout. `pnpm check:template-checkout-hygiene` must stay clean.
- **System tests** go through `pnpm system-test --instance clients-<phase> …`,
  following the AGENTS.md procedure.
  - New tests are added in `system/workers/system-test-runner`:
    - `client-launch-terminal`: node-pty driven, includes `chat ask` piping;
    - `client-launch-desktop`: via `scripts/development-client-executor.mjs`, a
      headless Electron client;
    - `client-intent-background`;
    - `client-update-swap`.
  - Existing browser tests are the parity gate for P1–P4.
- **Mobile.**
  - Android: extend `mobile-smoke` to launch a second client from a pinned-shortcut
    intent and assert a separate task; reply from a notification.
  - iOS: P5.7 builds the simulator smoke that `mobile-smoke.mjs:2110` currently
    refuses.
- **Performance.**
  - Use the System template `skills/performance` workflow, not generic web-perf.
  - Measure cold start before and after for desktop (cache-loaded client versus
    HTTP), terminal, and Android (extra host runtime).
  - Measure the memory of two RN instances.
  - A regression budget is agreed in P0.
- **Gates.** `check:unit-authority`, `check:pair-authority`, `check:agent-docs`,
  `check:workspace-template-release` and `check:workflows` are all updated and kept
  in the final publication gate.

## 11. Things to delete or rewrite (checklist)

**Code**
- `AppHost`, `APP_UNIT_DESCRIPTOR`, `AppRegistryEntry`.
- `appAdoptionPolicy`, `notifyAppUpdateAvailable`'s Electron branch.
- `ensureElectronReady`, `prepareElectronArtifact`, `electronReadinessSnapshot`.
- `bakeDist`, `resources/baked-app`, `loadBakedApp`.
- `getTerminalAppArtifactBaseUrl`, `HostTargetSelection*`, `mobileUpdateStatus`.
- `AppPrincipalTargetSchema`, `WorkspaceAppTarget`, `NativeAppHost`, `HostTarget`.
- `APP_CAPABILITIES_BY_TARGET` and `APP_CAPABILITIES_BY_NATIVE_HOST`.
- `HostLaunchClient`'s client-side config resolution.
- In the desktop host: `vibestudio:openFileDialog`, the panel-preload dead
  bridges, `appPreload.native.notifications`, and the hard-coded menu entries.
- In the mobile client bundle: the client-side transport ownership
  (`mobileTransport.ts`), keychain access, background push handlers, and the
  `native-module-policy.json` allowlist mechanism.
- The terminal-browser's in-module host contract check.

**Docs and skills** (sweep in the same change that renames each surface)
- Skills: `system/apps/{shell,mobile}/SKILL.md`, the template `about/` pages and any
  skill naming `apps/`.
- Repo docs:
  - `docs/terminal-apps.md`, `docs/terminal-app-units-design.md`,
    `docs/terminal-handover.md`, `docs/cli.md`, `docs/ios-integration-plan.md`;
  - `apps/mobile/README.md` → `hosts/react-native/README.md`;
  - `README.md`'s "Desktop, server and phone" section;
  - the generated agent CLI docs.
- Fix the stale reach version (v5), the terminal contract version and the prefix-key
  documentation during the sweep.

## 12. Spikes (P0) and risks

| ID | Question | Why it matters | Exit criterion |
|---|---|---|---|
| S1 | Per-client OS identity for windows in **one** Electron process: Linux X11 `WM_CLASS` / Wayland `app_id` per toplevel; macOS per-client Dock icon (Chrome's app-shim approach as reference) | Determines whether "Chat" can look like its own app on Linux and macOS while sharing the device connection | Working prototype or a documented "not without a second process", plus the recommended fallback (launcher-only identity) |
| S2 | Windows `setAppDetails` on `BaseWindow` + AUMID shortcuts, jump lists per AUMID | Expected to work; confirm with Electron version in use | Prototype |
| S3 | Two concurrent RN instances (headless host runtime + client) on RN 0.79, old architecture on Android / Fabric on iOS; memory per Hermes instance; native session-scoped stream capability | The largest structural change in the plan | Prototype on both platforms with measured memory and startup |
| S4 | Split `hosts/android` / `hosts/ios` sharing `hosts/react-native` with autolinking intact | Layout requested; RN CLI assumes a single project root | Both build from the split layout in CI |
| S5 | Hermes bytecode (`.hbc`) for client bundles instead of minified source | Startup on mobile; currently only a syntax check runs (`hermesc -dump-ast`) | Measured cold-start delta; adopt only if material |
| S7 | Inventory of work in the Electron main process today (profile with the performance skill under a multi-window load): what moves to the connection process, what must stay; prototype `utilityProcess` + `MessageChannelMain` per-session ports | Precondition for one-process/many-windows without contention (section 5.1.1) | Inventory, a measured lag/IPC-latency baseline and the budget for the P3 gate |
| S6 | iOS App Intents with dynamic `EntityQuery` + `updateAppShortcutParameters` from an RN host; App Group snapshot for WidgetKit | Validates the iOS projection design | Simulator prototype |

**Risks**
- **The mobile host-runtime split (S3).** If two RN instances prove too costly, the
  fallback is a single client at a time. The host runtime stays alive; switching
  clients reloads one instance. That keeps every principle except concurrent
  Recents tasks.
- **The desktop connection process.** Moving the transport out of main touches
  every renderer's RPC path. It lands behind the existing system tests as the parity
  gate and is measured against the S7 baseline.
- **The scale of the P1 move.** It touches CI, packaging and every import path. It
  should land as one atomic mechanical change with no behavior edits.
- **macOS Dock identity (S1).** This may simply not be achievable without a second
  process. Launcher-only identity is the honest fallback, not a hack around it.

## 13. Decisions

- **D1. Where clients live. Decided: System only.** Trust comes from
  `trust.clients`. Clients in other workspaces are out of scope (section 4.4).
- **D2. Desktop process model. Decided: one host process, many client windows.**
  The condition is no contention between clients, which section 5.1.1 meets with the
  connection utility process, per-session ports and the main-loop gate. Per-client
  OS identity is limited to what S1 establishes.
- **D3. Mobile concurrency.** Recommended: a host runtime plus per-client RN
  instances, so chat and the browser are separate Recents tasks and clients never
  touch the credential. The fallback is one client at a time. Spike S3 settles it.
- **D4. iOS distribution. Decided: not a design constraint.** The iOS host exposes
  the same client API as Android. TestFlight and self-built distribution are the
  targets.
- **D5. Naming.** `client` as the unit kind, and "browser" for the panel-hosting
  clients (`desktop-browser`, `terminal-browser`, `mobile-browser`). "App" stays a
  user-facing word only.
