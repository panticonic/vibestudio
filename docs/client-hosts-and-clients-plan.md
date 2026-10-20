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
- **Mobile runs one host runtime plus a separate RN instance per client** (settled
  by spike S3).

All P0 spikes ran on 2026-10-16. Section 12 has the results.

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

| New term            | Meaning                                                                                                    | Replaces                                                                                                              |
| ------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Host                | Trusted native program per platform: desktop, terminal, android, ios                                       | "native host", Electron main, CLI terminal command, `apps/mobile` native shell                                        |
| Host descriptor     | `{host, hostVersion, runtimes: {runtime: hostAbi}, capabilities[]}` sent at connect                        | `clientPlatform`, `NativeAppHost`, implicit per-target assumptions                                                    |
| Runtime             | Execution environment a client is built for: `web`, `react-native`, `terminal`                             | `WorkspaceAppTarget` (`electron`/`react-native`/`terminal`), `AppPrincipalTarget` (`react-native-app`/`terminal-app`) |
| Host ABI            | Versioned contract between a host and clients of one runtime: `web-host-N`, `rn-host-N`, `terminal-host-N` | `rnHostAbi` (RN only), `TERMINAL_BROWSER_HOST_CONTRACT_VERSION` (checked inside the client), nothing for Electron     |
| Client              | Workspace unit kind `client` under `clients/`                                                              | Unit kind `app`, `apps/`                                                                                              |
| Browser             | A client that hosts panels / terminal apps                                                                 | "shell", "terminal browser", "mobile app"                                                                             |
| Default client      | The client a host opens when nothing more specific was asked                                               | `hostTargets.<target>.app`                                                                                            |
| Client intent       | Manifest-declared entry point a host can project onto OS surfaces                                          | nothing (new)                                                                                                         |
| ClientHost (server) | Server registry: candidates, admission, release, rollback, launch                                          | `AppHost` (2,599 lines)                                                                                               |

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

|                | Electron shell                                                                                   | Mobile                                                                                 | Terminal browser                                                        |
| -------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Build          | `buildPanel` plus app branches (`src/server/buildV2/builder.ts:3497`, `:3577`, `:3598`, `:3885`) | extension provider runs Metro per platform (`system/extensions/react-native/index.ts`) | `buildTerminalApp` esbuild Node ESM (`builder.ts:4644`)                 |
| Contract check | almost none (`appBuildContract.ts`)                                                              | ABI, integrity, per-platform primaries                                                 | exactly one `.mjs`                                                      |
| Delivery       | HTTP `/_a/<buildKey>/…` into a WebContentsView                                                   | `auth.getMobileAppBootstrap` + `gateway.fetch` chunks, SHA-256 checked natively        | `gateway.fetch` to a 0600 temp file, `import()`; **no integrity check** |
| Principal      | one shared app entity (`appHost.ts:1862`)                                                        | `DeviceAppPrincipals` `app:<source>:<deviceId>`                                        | same as mobile                                                          |
| Updates        | server-chosen `prompt` / `immediate`, "Load update"                                              | `supervision:changed` + `appUpdatePrompt`                                              | new `buildKey` noticed on re-grant                                      |
| ABI check      | none                                                                                             | `rn-host-5` in bootstrap                                                               | inside the client module (`terminal-browser/src/index.ts:17`)           |

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

| Host     | Process model                                           | Runtimes it runs | Notes                                         |
| -------- | ------------------------------------------------------- | ---------------- | --------------------------------------------- |
| desktop  | Electron main (Node)                                    | `web`            | One process; many client windows              |
| terminal | `vibestudio` CLI (Node)                                 | `terminal`       | One client per terminal; the CLI owns the TTY |
| android  | Kotlin native + a headless **host JS runtime** (Hermes) | `react-native`   | Client runtimes are separate RN instances     |
| ios      | Swift/ObjC native + a headless host JS runtime          | `react-native`   | Same JS host core as Android                  |

**Principle: the host owns the device. A client owns only its UI and its principal
sessions.** The host owns:

- the device credential and device signing key (the key signs; it is never a transport endpoint);
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
- Each client runtime receives a _session-scoped stream capability_: it may open
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

**Where clients live.** Clients live in the **System** workspace: only the
System workspace constructs a ClientHost, and other workspaces have none. This
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

- Every running client instance is `client:<id>:<runtime>:<deviceId>`, a
  **device-level** identity. System's ClientHost vets the exact build
  (`buildKey`, `executionDigest`) with the pure `attest(deviceId, expected)` and
  **attests** it into the hub-owned identity store; the hub is the trust root and
  accepts attestations only from the System workspace of the device's user.
  `auth.grantClientPrincipal` attests and returns a reusable credential.
- The credential is not one-use and not per workspace: the principal is valid in
  every workspace, each of which admits it into its own entity cache on first
  use. The credential is bound to the device key and to the attested digest, so a
  re-attestation with a new build digest invalidates old credentials.
- Principals survive restarts of System and the hub. At start (once the client
  registry has settled) ClientHost lists the rows it attested and retires those
  whose client is no longer running, trusted or present, or whose build or
  capabilities differ from what it would attest now; the rest are kept.
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

#### 4.4.1 Granting device-level powers: how it works today, and the target

**Today (verified in code, 2026-10-16)**

_Where trust lives._ Device-level power is one manifest list,
`trust.chromeApps` in the System `meta/vibestudio.yml`. It is checked live on
every use:

- `AppHost.isTrustGatedCapabilityAuthorized` (`src/server/appHost.ts:1255`) strips
  a self-declared `panel-hosting` from any app not on the list.
- `effectiveCapabilities` projects only the vetted set onto
  `supervision:changed`.

_Manifest changes._ A change to the list arrives like any manifest change: a
protected-`main` publication of the `meta` repository. Every such publication goes
through the single gate, `createMainRefAdvanceGate` → `MainAdvanceApprovalGate.approve`
(`src/server/services/mainAdvanceApproval.ts:102`, `:599`). Hot reload then
re-seeds the trust registry from the newly published event, not from disk
(`docs/workspace-manifest-hot-reload.md`, "Apply Pipeline").

_The approval decision._ The gate has three outcomes.

| Publisher                                                                                                                   | What happens                                                                                                                 | Code                                                           |
| --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Trusted chrome with a person in front of it (`isInteractiveChrome`: the shell/bootstrap, or an app holding `panel-hosting`) | **Silent.** The click that started it is the consent. Unit admission is committed with the refs                              | `mainAdvanceApproval.ts:610`, `:743-760`; `chromeTrust.ts:105` |
| Anyone else (agent, panel, worker, DO, extension), and the publication changes `meta/`                                      | Prompt: `workspace.publish`, tier `gated`, card "Change workspace settings", with `configWrite: {repoPath: "meta", summary}` | `:788-806`, `:961-1000`                                        |
| `server` / `headless-host`                                                                                                  | Ordinary gate; there is no click                                                                                             | `chromeTrust.ts:90-104`                                        |

_How decisions are scoped._

- Each publication's authority resource is **exact** and unique:
  `workspace-source-change:publication:<publicationId>`, acquired with
  `resource: {kind: "exact", key}` (`rpcServer.ts:4713`).
- So a "Just once" or "Allow for this task" decision cannot carry over to a later
  publication: the agent is asked again for each one.
- Template composition cannot smuggle trust in. `trust` is a merged record whose
  slots are replaced, not unioned, so "a dependency cannot quietly add itself to
  something like `trust.chromeApps`" (`packages/workspace/src/templateManifestMerge.ts:30`).

**Gaps that the live-update goal exposes**

1. **The card doesn't say "power".** `metaChangeSummary` (`:1087`) renders
   "meta/vibestudio.yml changed". A publication that makes a client trusted looks
   exactly like renaming a service. The reviewer sees a diff, not "Chat Desktop will
   be able to render approvals and act as this device in every workspace".
2. **The tier is `gated`, not `critical`.**
   - `workspace.publish` is `AGENT_SCOPE_OFFERABLE` with `missionGrant: true`
     (`packages/shared/src/authority/receiverAuthorityPolicy.ts`). Automation
     target requests are registered for every gated, mission-grantable leaf
     (`authorityService.ts:340-363`).
   - Whether a standing mission or task-envelope rule could ever satisfy a
     _trust-changing_ publication depends on resource keys that a plan author
     controls. We could not rule it out by reading the code, and a privilege grant
     should not depend on that.
   - The authority model already has the right tool: the `critical` tier is "never
     a standing grant; fresh per-operation approval"
     (`capabilityClearance.ts:1-23`).
3. **Silent chrome can expand trust.** The click-is-consent path applies to _any_
   publication from interactive chrome, including one that changes `trust`. Today
   only the browsers hold `panel-hosting`. Under this plan, every trusted client
   (including the chat clients) is interactive chrome. "The click is the consent"
   is right for layout and settings. It is not right for "make another program
   able to approve things on my behalf".
4. **Revocation is check-time only.**
   - Removing a source from the list stops new checks immediately, because
     `hasAppCapability` reads live grants.
   - Already-open sessions and minted connection grants keep running until their
     next check. Nothing settles a running client whose trust was withdrawn.

**Target: one rule, enforced by the existing gate**

A publication whose candidate manifest changes the **effective device-level
capability set** of any client is a _trust change_, and a trust change is
`critical`. "Effective device-level capability set" means: the `trust.clients`
membership × the client's declared device-level capabilities, at the candidate
versus at the current main.

The implementation adds no new channel, only a classification inside
`MainAdvanceApprovalGate.approve`:

- **Classify.** The gate already composes the candidate view and resolves units.
  It also computes the **trust delta**: clients gaining or losing each device-level
  capability. That covers additions to `trust.clients`, removals, and a trusted
  client whose new version declares an additional device-level capability.
- **Escalate.** A non-empty delta raises the publication's authority tier to
  `critical`, with the fresh per-operation `confirm.critical` card.
  - No once, task, envelope, mission or "always" grant can satisfy it.
  - This applies to **every** publisher, including interactive chrome. The
    silent click-is-consent path is narrowed to publications with an empty trust
    delta.
  - The same classification runs for template-driven updates (template install or
    upgrade through the template exchange executor). A System template release
    that adds a trusted client is confirmed the same way.
- **Present.** The card gets a structured `trustChange` section in place of the
  `configWrite` one-liner. For each client it shows:
  - name, icon and runtime;
  - the device-level capabilities gained or lost, in plain language (from the
    capability catalog's copy);
  - the source and exact build it will be pinned to.

  The person approves exactly that delta. The approval's `preparedStateDigest`
  already binds it to the candidate state.

- **Apply.**
  - _Grant:_ after the confirmed publication lands, hot reload re-seeds trust
    exactly as today. The client's next `clients.launch` returns the new
    `grantedCapabilities`. A running instance of that client receives
    `supervision:changed` with its new effective set and re-requests its principal
    grant. No host restart.
  - _Revoke_ (removal, or a narrower declaration): this is an authoritative
    terminal event for the affected sessions, not a check-time drift. ClientHost:
    1. retires the client's principals in the hub, which revokes their
       credentials (every workspace, not only System);
    2. the hub closes their live sessions in every workspace with a typed
       `trust-revoked` reason;
    3. emits `clients:changed`.

    Hosts then close the client, or relaunch it without the capability if it
    declared the capability optional, and say why. Revoking a device or user
    in the hub retires that device's or user's principals the same way.

    A candidate manifest that does not validate is not a reason to refuse an
    unrelated publication: only clients listed in `trust.clients` (now or in the
    candidate) are examined, and an examined client with an invalid candidate
    manifest is treated as holding no device-level capabilities, reported as a
    diagnostic.

**Consequences for the development loop (section 7.4).** Developing a client that
needs device-level power is still a no-restart loop. It has exactly one `critical`
confirmation the first time the client joins `trust.clients`, and one more only if
a later version declares an additional device-level capability.

Ordinary edits are untrusted-delta publications: they follow the normal
`workspace.publish` review, or no prompt at all from the browser's own UI. A client
that needs no device-level power never meets the trust gate.

**Tests (P2)**

- Unit, `mainAdvanceApproval`:
  - the trust delta is computed for: add, remove, capability widening on a new
    version, unchanged;
  - a non-empty delta forces `critical` for agent, chrome, automation and template
    publishers;
  - no standing grant of any kind satisfies it;
  - an empty delta keeps today's behavior.
- Unit, ClientHost: withdrawal and retirement retire the client's principals
  through the hub port; startup reconcile keeps unchanged principals and retires
  those whose client is gone, untrusted or rebuilt.
- System test (part of `client-dev-loop`): an agent adds `hello-desktop` to
  `trust.clients` and gets a `confirm.critical` card naming the gained
  capabilities. Approving it makes the running client gain them live. Removing the
  client closes it with the stated reason. Server boot ID and host process ID are
  unchanged.

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

A pushed agent message carries a reply action (`actions: [{id, title, input: "text"}]`
in the `notification.pushUserInbox` request, `actionsJson` on the wire).

- The host renders the native reply field: Android `RemoteInput`, iOS
  `UNTextInputNotificationAction` in a category registered at launch. macOS `hasReply`
  and Windows toast input belong to the desktop host.
- The typed text is posted by the host itself, as the person, into the push's
  conversation (`sendAsCaller` on the channel target) over the device's own connection
  to the push's workspace. No client runs, and nothing round-trips to a producer.
- Failure is said on the notification, which keeps its reply action.

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

| Surface                                  | desktop                                                                                                                       | terminal                                                    | android                                                                                 | ios                                                                                              |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Install / remove a launcher for a client | `.desktop` file (Linux), Start-menu `.lnk` with its own AppUserModelID (Windows), launcher `.app` in `~/Applications` (macOS) | `vibestudio <command>` plus an optional `~/.local/bin` shim | pinned shortcut (`ShortcutManagerCompat.requestPinShortcut`)                            | App Shortcut / Shortcuts-app home-screen action via App Intents; Control Center control (iOS 18) |
| Per-client OS identity while running     | window AUMID (Windows); Linux and macOS: grouped under Vibestudio, launcher identity only (S1)                                | terminal title / tab                                        | own Recents task with label and icon (`FLAG_ACTIVITY_NEW_DOCUMENT` + `TaskDescription`) | own scene on iPad (multi-scene); single window on iPhone                                         |
| Static and dynamic shortcut menus        | Dock menu (macOS), jump list (Windows), `.desktop` `Actions=` (Linux)                                                         | shell completions                                           | launcher long-press dynamic shortcuts                                                   | Home-screen quick actions (`shortcutItems`)                                                      |
| Background `ask`                         | global shortcut → host mini-prompt window (optional `tray`)                                                                   | `vibestudio chat ask "…"` / stdin, streamed to stdout       | Quick Settings tile, widget                                                             | Siri / Shortcuts / Action button App Intent, interactive widget                                  |
| Share-in                                 | drag onto dock or taskbar icon (`open-file`); macOS Services                                                                  | `vibestudio chat --attach FILE`, stdin                      | `ACTION_SEND` intent filter on the host, routed to clients that accept the type         | share extension → App Group inbox → host                                                         |
| Notifications with reply                 | macOS `hasReply`, Windows toast input, Linux portal where supported                                                           | OSC 9 / OSC 777 / OSC 99 desktop notifications, bell        | conversation notifications, `RemoteInput`, bubbles                                      | `UNTextInputNotificationAction`                                                                  |
| Glanceable status                        | tray / badge (`app.setBadgeCount`)                                                                                            | title / bell                                                | Glance widget                                                                           | WidgetKit widget, Live Activity for a running agent turn (APNs push updates)                     |

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
    defaults: # per host, not per runtime: android and ios may differ later
      desktop: clients/desktop-browser
      terminal: clients/terminal-browser
      android: clients/mobile-browser
      ios: clients/mobile-browser
    requiresExtensions:
      react-native: [extensions/react-native]
    trust:
      clients:
        [
          clients/desktop-browser,
          clients/terminal-browser,
          clients/mobile-browser,
          clients/chat-desktop,
          clients/chat-terminal,
          clients/chat-mobile,
        ]
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
  Output: per-platform primary bundles plus assets, as today.
  - **It ships minified source, not Hermes bytecode** (settled by S5). On the
    3.47 MB host bundle, `.hbc` was 4.69 MB (2.4× the gzip transfer: 1.74 MB vs
    0.72 MB).
  - Process start to `Running` on the emulator: median ≈ 2.24 s (`.hbc`) vs
    ≈ 2.43 s (source), about 8 %, inside run-to-run noise.
  - Bytecode would also tie every client build to the host's exact Hermes build.
  - Revisit only with physical-device numbers on the production client bundle.

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
- One process keeps one Iroh endpoint and one physical connection per reach. The
  endpoint is fresh and in-memory: the device's signing key delegates it to the
  device once (a signature over `vibestudio-endpoint-delegation-v1`, the device
  key and the endpoint id) and the server binds the connection to the device on
  that proof. A device therefore has one connection per host process, and two
  processes of one device (a CLI beside the terminal client, say) never contend
  for an endpoint or supersede each other.

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

**OS launchers and per-client identity (settled by S1/S2)**

The rule is **launcher identity everywhere, window identity only where the OS gives
it to one process.** We do not add a platform-specific path to fake the rest.

- **Linux.**
  - Launcher: `~/.local/share/applications/vibestudio.<id>.desktop`
    (reverse-DNS, e.g. `app.vibestudio.Vibestudio.chat`) with
    `Exec=vibestudio --client <id>` and `Actions=` for intents.
  - Running windows group under the Vibestudio icon. Electron has no per-window
    Wayland `app_id` API, and Wayland is the default session. X11 windows can be
    re-classed after mapping (S1 proved it), but that would be an X11-only special
    path, so we don't build it.
  - **Prerequisite found by S1:** the host sets no `desktopName`/`setDesktopName`
    today. Electron 45 documents that GNOME 50 and `xdg-desktop-portal` ≥ 1.21
    refuse `globalShortcut` and other portal sessions when the app ID does not
    resolve to an installed `.desktop` file. P2 sets `desktopName` to the packaged
    `.desktop` name before any portal-backed capability (`global-shortcut`, badge)
    ships.
- **Windows.**
  - `BaseWindow.setAppDetails({appId, appIconPath, relaunchCommand,
relaunchDisplayName})` exists in Electron 45 (win32). Each client window gets
    its own taskbar group and pinning target, matching a Start-menu `.lnk` that
    carries the same `System.AppUserModel.ID`.
  - `app.setJumpList` is process-wide, so per-client jump lists are not available.
    Intents go into the main jump list, grouped by client.
  - Not executed (no Windows host here). The P5 desktop system test on Windows CI
    is its verification.
- **macOS.**
  - A generated launcher `.app` (Info.plist + icon + exec stub opening
    `vibestudio://c/<id>/open`) gives Launchpad/Spotlight/Dock-pin identity.
  - Running windows belong to the Vibestudio Dock icon. The Dock menu
    (`app.dock.setMenu`) lists open client windows and intents.
  - A per-client Dock icon is **not achievable in one Electron process**. Chrome
    does it by having the shim process host the app's NSWindows over Remote Cocoa,
    a Chromium-internal mechanism that Electron does not expose. We accept the
    limit, per D2.

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
- From the S7 inventory:
  - the server clients and session management (`serverClient.ts`,
    `irohServerClient.ts`, `desktopIrohConnectionSupervisor.ts`, `serverSession.ts`);
  - the stores and ledgers (`panelPinStore`, `encryptedJsonStore`,
    `deviceCredentialStore`, `sensitiveBrowserImportLedger`,
    `mainProcessErrorLedger`, `desktopWindowState` writes);
  - the browser import host provider and the vault native client;
  - the adblock config I/O;
  - hashing that currently runs synchronously, including `paths.ts:207`, which
    hashes the whole server entry file.

The device credential and device signing secret are read only here.

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

**What remains in main, and is watched.** Two items cannot leave main.

- **CDP.** `webContents.debugger` lives in main.
  - Today main parses the provider protocol (`cdpHostProvider.ts:280`, `:533`,
    `:1116`, `:1257`). The target is forwarding without interpreting payloads.
  - If profiling shows CDP screenshots or tracing contending, the fix is a bounded,
    flow-controlled forwarding path that is measured. It is not more work in main.
- **Adblock request filtering.**
  - `session.webRequest.onBeforeRequest` on `<all_urls>` calls the Ghostery
    engine's `match()` synchronously in main for every subresource
    (`adblock/adBlockManager.ts:340`, `:362`).
  - The webRequest hook must stay in main. Moving `match()` to a utility process
    would add an IPC hop to every request.
  - Decision: keep the synchronous in-memory match, which is fast per call. Make
    the multi-client gate include a page-heavy panel so its total cost is visible.
    Move it only if the budget is breached.

The periodic timers in main also stay, and are small: the 5 s compositor
keepalive, the 60 s memory snapshot, the 60 s cookie reconcile and the 24 h filter
rebuild. Any of them that does persistence work moves with that persistence.

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
moves to `hosts/react-native/`.

**Split layout (settled by S4).** The split builds with autolinking intact. The
Gradle project already runs the RN CLI's config command with an explicit working
directory (`autolinkLibrariesFromCommand(…, mobileRoot, …)`), so the move only
changes paths:

- `settings.gradle` points `mobileRoot` at `hosts/react-native`;
- `app/build.gradle` sets `react { root = file("../../react-native") }` and moves
  the `node_modules` paths one level up;
- `hosts/react-native/react-native.config.js` declares
  `project: { android: { sourceDir: "../android" }, ios: { sourceDir: "../ios" } }`;
- `pnpm-workspace.yaml` lists `hosts/react-native`.

With this layout, `npx @react-native-community/cli config` resolves both native
projects and all 17 native dependencies, and `:app:assembleDebug` builds. The build
needs JDK 21; the host's default JDK 25 breaks Gradle 8.11 ("class file major
version 69"), so P1 pins `JAVA_HOME` in the documented build path.

For iOS, CocoaPods' `use_native_modules!` takes the config command as an argument
(`react-native/scripts/cocoapods/autolinking.rb:204`). The Podfile passes one that
runs in `../react-native`, and the Xcode bundle phase sets `PROJECT_ROOT` to the
same directory. This is verified at source level only; the macOS CI job is its
build verification.

**Host runtime and client instances (settled by S3)**

- The host runtime is a headless RN instance that owns the device (section 4.1).
  It starts from **`Application.onCreate`**, not from an activity.
  - The spike showed that the OS can start the process directly into a client
    activity: a pinned shortcut, a share, or a process the system killed and later
    restored.
  - The host runtime must therefore exist regardless of which component is the
    process entry point. Client activities await its readiness through the native
    broker. There is no delay or timeout.
- Each client is its own RN instance (`ReactInstanceManager` on the old
  architecture today), loading a verified bundle from the cache.
- In the spike, a `SpikeClientActivity` started with
  `FLAG_ACTIVITY_NEW_DOCUMENT | FLAG_ACTIVITY_MULTIPLE_TASK` ran beside the host
  `MainActivity`:
  - It had its own Recents task with its own `TaskDescription` label, and both
    runtimes ran in one process (`Running "Vibestudio"` and `Running "SpikeChat"`
    from the same pid).
  - The second runtime was ready **359 ms** after launch in a warm process, and
    1.1 s from a cold process.
- **Session capability enforcement** works as designed:
  - The broker module is constructed per runtime with that runtime's tag, so a
    client cannot claim another tag.
  - It enforces host-issued grants: `openStream("s-chat")` was allowed for
    `client:chat`, and `openStream("s-browser")` was denied with
    `E_SESSION_NOT_GRANTED`.
- **Memory.** The extra runtime with a small bundle costs less than the
  measurement noise on the 2 GB emulator. Pss+SwapPss varied by ±25 MB between
  identical runs because zram swapping dominates. Host only: 93–144 MB. Host plus
  client: 108–135 MB.
  - P3 re-measures on a physical device with the production bundles. If memory is
    tight, a background client instance is destroyed and cold-started from cache;
    durable state lives server-side anyway.
- D3 is therefore settled in favour of concurrent per-client runtimes.

**Platform integration**

- **Pinned shortcuts** are the "install" for Android. Dynamic shortcuts are filled
  from intents with `dynamic` sources. A WebAPK-style separate install is not
  available outside Chrome, and Android has nothing better for a single APK.
- **Share target:** one `ACTION_SEND` / `ACTION_SEND_MULTIPLE` filter on the host.
  The host shows a chooser among clients whose `share-in` accepts the MIME type.
  Direct share targets come from conversation shortcuts.
- **Conversation notifications** (`MessagingStyle` + long-lived conversation
  shortcuts), direct reply through `RemoteInput` posted by the
  host into the conversation, and **bubbles**. A bubble's activity is a `ClientActivity`
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

**App Intents (S6, settled from documentation and source; needs macOS for
execution).** The iOS version of "install" is generic App Intents compiled into
the host once:

- `OpenClientIntent(client: ClientEntity, intent: ClientIntentEntity?)`
- `AskIntent(client: ClientEntity, prompt: String)`

**Dynamic entries.** Both intents are backed by dynamic `EntityQuery`s over the
integration snapshot. An `AppShortcutsProvider` exposes "Ask Vibestudio" and "Open
\(client) in Vibestudio" with `updateAppShortcutParameters()` after the snapshot
changes.

**Placement constraints**

- The provider lives in the **main app target**, not in an App Intents extension.
  The host must call `updateAppShortcutParameters()` itself, and an app cannot call
  it on a provider that lives in an extension.
- The intents run in the app process. A background `perform()` starts the app with
  **no scene**. The host runtime therefore boots headless (as on Android) and
  serves `clients.invokeIntent` without any client instance. `OpenClientIntent`
  declares foreground mode (`openAppWhenRun` / iOS 26 `supportedModes`), which is
  read statically.
- Known platform defect: Spotlight's Siri Suggestions can keep a stale parameter
  title after `updateAppShortcutParameters()`. The Shortcuts app updates correctly.
  Entity titles should therefore be stable (client names), not volatile
  (conversation previews).

**Where they surface.** Siri, Spotlight, the Shortcuts app, the Action button and
Control Center controls. From Shortcuts, a person can add any of them to the Home
Screen with its own name and icon. Home-screen quick actions (`shortcutItems`) are
set from the snapshot.

**Multiple runtimes on iOS.** `RCTReactNativeFactory` owns its own
`RCTRootViewFactory` and `reactHost`/bundle URL, so one factory per runtime gives
the host/client split. The app already rebuilds its factory per scene
(`SceneDelegate.mm`). This is verified at source level in RN 0.79 only; the iOS
simulator smoke (P5.7) verifies it in execution.

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

A share extension cannot reuse the host's QUIC connection. The extension never
dials: although it could bind its own delegated endpoint, it would hold the device
signing key in a second process for no benefit.

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

| Headless core (no UI)                                                                                                               | `client-kit-web`       | `client-kit-native`                                     | `client-kit-terminal`      |
| ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------- | -------------------------- |
| `approvals-core`: queue, protected inputs, decisions (from `terminal-browser/src/approvals`, `ConsentApprovalBar`, `ApprovalSheet`) | approval bar + dialogs | approval sheet                                          | approvals overlay          |
| `connection-core`: workspace availability, reconnect state                                                                          | banner                 | banner                                                  | status line                |
| `workspace-core`: list, switch, selected workspace                                                                                  | switcher               | drawer                                                  | picker                     |
| `client-update-core`: pending update, apply                                                                                         | prompt                 | prompt                                                  | prompt                     |
| `provider-signin-core`: OAuth start/paste-back                                                                                      | flow                   | flow (`ASWebAuthenticationSession` / loopback via host) | flow (existing paste-back) |

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

### 7.4 Goal: develop and deploy a new client with no restart

**The goal.** Someone (a person or an agent) can develop and deploy a new client
app with these properties:

- authored in the System workspace;
- launched on an already-running server and an already-running host;
- iterated on live;
- installed into the OS launcher;
- with **no restart of the server, the host process, or any other client**.

The path is documented in one System skill and proven by system tests. The design
above makes this possible. This section states the contract, names the pieces
that would otherwise force a restart, and defines the proof.

**The boundary: what a host binary fixes.** Developing a client never requires a
host release _as long as the client stays inside the host's ABI_:

- the runtime and `hostAbi` versions the host advertises;
- the host capability catalog it implements;
- on mobile, the native modules compiled into the host.

A client that needs a new native capability or module needs a host release by
definition. That is where trusted native code begins, not a limitation to engineer
around. `clients.launch` reports it as `unavailable` with the missing capability
or ABI named. It never fails silently, and it never offers to restart.

**Why nothing else needs a restart**

| Step                                                                         | Mechanism                                                                                                                                                                                                                                                         | Already exists?                                                                                                                     |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Declare the client (`clients:` and `trust.clients` in `meta/vibestudio.yml`) | Manifest hot reload: a protected-main publication re-reads the manifest, ClientHost reconciles declarations, trust is re-seeded (`docs/workspace-manifest-hot-reload.md`)                                                                                         | Yes for `apps`/`hostTargets`/`trust`. P2 carries the contract over to `clients` and `trust.clients`                                 |
| Build                                                                        | Unit change → client build (`onUnitChange` / `onPushBuild` already drive AppHost)                                                                                                                                                                                 | Yes                                                                                                                                 |
| Admit                                                                        | `unit-install-review` + the new client's capability consent, answered in the running browser's approval surface                                                                                                                                                   | Yes, generalized in P2                                                                                                              |
| Discover                                                                     | `clients:changed` event → hosts refresh the client index (launcher lists, `vibestudio <command>` table, App Intents entities, Android dynamic shortcuts)                                                                                                          | New, P5                                                                                                                             |
| Launch                                                                       | `clients.launch` → verified cache → new client window (desktop), new RN instance (mobile), the CLI loads it (terminal)                                                                                                                                            | New, P3; S3 and S7 prove the mechanism                                                                                              |
| Iterate                                                                      | `supervision:changed` → host adoption. A client in **development mode** adopts rebuilds immediately, restarting only that client: the window reloads (desktop), the RN instance is recreated (mobile), the client is re-entered at the next safe point (terminal) | Partly. Today mobile reloads the _entire_ RN runtime (`reloadActiveAppBundle`) and terminal only notices on re-grant. P3 fixes both |
| Install into the OS                                                          | `host.integration.install` writes the `.desktop` file, `.lnk`, launcher `.app` or pinned shortcut at runtime. iOS refreshes App Intents with `updateAppShortcutParameters()`                                                                                      | New, P5                                                                                                                             |

**Rules on development mode**

- Development mode is a host-side, per-client, per-device setting. The developer
  sets it with "Develop" in a browser's client list or with
  `vibestudio open <id> --develop`.
- It is not a manifest field, so a published client cannot opt itself into
  unprompted reloads.
- It changes only the adoption policy. Integrity checks, admission and review are
  unchanged.

**Trust is the one deliberate stop** (section 4.4.1). A new client that needs
device-level capabilities (`device-session`, `approval-surface`, …) has to join
`trust.clients`.

- That publication is classified as a trust change and needs one fresh `critical`
  confirmation from the System owner. The card names the client and the powers it
  gains, and no standing grant can satisfy it.
- Hot reload then applies the change live. Later edits that don't widen the
  client's device-level capabilities don't meet this gate again.
- Revoking trust closes the client's device sessions with a stated reason.
- Clients that need no device-level power never meet the gate.

**Documentation.** `system/skills/appdev` becomes `system/skills/clientdev`. Its
`TARGETS.md` becomes `RUNTIMES.md`, and its `DEV_LOOP.md` becomes the no-restart
loop above, step by step for each runtime:

1. create `clients/<name>`;
2. declare it;
3. publish;
4. answer the review;
5. `vibestudio open <id> --develop` (or the browser's client list);
6. edit and publish, and watch the client update in place;
7. install the launcher;
8. retire the client: the launcher is removed and the running instances close
   with a stated reason.

The template chat clients (section 7) are the worked examples.

**Proof: `client-dev-loop` system tests** (one per runtime, P5). Each test runs on
a managed instance, against a host started _before_ the client exists.

1. Record the server boot ID, the host process ID, and the identity of every
   running client instance.
2. The test agent follows `clientdev` to create `clients/hello-<runtime>` with one
   intent (`open`) and one background intent (`echo`), declares it, publishes,
   and approves the review.
3. Assert that the host's client index gained the client with no restart, then
   launch it:
   - desktop: through `scripts/development-client-executor.mjs`;
   - terminal: node-pty driven `vibestudio open hello-terminal`;
   - Android: emulator intent, in the `mobile-smoke` extension.
4. Assert that the client renders and that `clients.invokeIntent(echo)` returns.
5. Edit a visible string with development mode on, publish, and assert the client
   shows it. Assert that the other clients' instance identities are unchanged.
6. Install the launcher and assert the OS artifact exists. Retire the client and
   assert the artifact and instances are gone.
7. Assert that the server boot ID and host process ID are unchanged throughout.
8. Negative case: a client requesting a capability that the host does not
   implement gets `unavailable` naming that capability, not a crash or a prompt to
   restart.
9. Trust case (desktop, from section 4.4.1):
   - an agent adds `hello-desktop` to `trust.clients` and must get a
     `confirm.critical` card listing the gained capabilities;
   - approving it makes the running client gain them live;
   - removing the client from the list closes its device sessions with
     `trust-revoked`.

iOS runs the same scenario in the P5.7 simulator smoke once it exists.

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
P0 decisions + spikes (done) ─▶ P1 mechanical moves ─▶ P2 model cut ─┬─▶ P3 delivery + host core ─┬─▶ P5 chat clients ─▶ P6 deep integration
                                                                       └─▶ P4 client kits ──────────┘
```

**P0. Decisions and spikes. Done 2026-10-16** (sections 12 and 13). Still open
from P0: executing the iOS halves of S3, S4 and S6 on a macOS runner. That is
folded into P1 (macOS CI build of the split layout) and P5.7 (simulator smoke).

**P1. Mechanical moves, no behavior change**

- _Host repo:_ `apps/` → `hosts/`, `services/`, `packages/headless-renderer`; `src/main` etc. → `hosts/desktop`.
- _Templates:_ `apps/*` → `clients/*`; package names.
- _Shared fixes:_ build configs, electron-builder paths, CI workflows (`check:workflows`), Metro roots.
- _Gate:_ full build + unit tests + `check:*` + Android smoke unchanged, plus the macOS CI iOS build of the split layout. The Android build path pins JDK 21 (S4).
- _Ordering:_ first, because every later diff then lands at its final path.
- _Edit ownership:_ host repo and templates are disjoint and can be edited in
  parallel, with one coordinated cut of the System template release pin.

**P2. Model cut (hard break)**

- _Contract and manifest:_ `UnitKind client`; manifest schema; `HostDescriptor`;
  capability catalog keyed by host; `trust.clients`; `clients.defaults`.
- _Server:_ ClientHost; `clients.launch`; `auth.grantClientPrincipal`; deletion of
  `AppPrincipalTarget`, `hostTargets`, the per-target special cases and the dead code.
- _Hosts:_ the three existing hosts adapt to `clients.launch` without yet changing
  their delivery mechanics.
- _Trust:_ the trust-change classification (`critical`, structured card, every publisher including chrome and template updates) and live revocation (section 4.4.1).
- _Gate:_ all three browsers launch through the new path; the trust-change tests pass; system tests green.
- _Parallelism:_ the server and shared-schema work blocks the host adaptations.
  The three host adaptations are then independent.

**P3. Uniform delivery and `client-host-core`** (needs P2)

- _Package:_ extract `client-host-core`; `ClientArtifactCache` with storage ports;
  integrity for all runtimes.
- _Desktop:_ the `vs-client://` protocol, plus the **connection utility process**
  with per-session `MessagePort`s. `client-host-core`, Iroh, the asset facade and
  the hub spawner move into it, and the main-process relay is deleted
  (section 5.1.1; design and budget from S7).
- _Desktop gate:_ the multi-client main-loop budget.
- _Terminal:_ verified import.
- _Mobile:_ the **host runtime + client-instance split** with the session-scoped
  stream capability (design proven by S3). The host runtime starts from
  `Application.onCreate` / app launch. This is the largest item.
- _Updates:_ host-side update policy.
- _Parallelism:_ the package work comes first. Then the desktop, terminal and mobile
  adapters are independent.

**P4. Client kits** (needs P2; parallel with P3)

- _Cores:_ extract `approvals-core`, `connection-core`, `workspace-core`,
  `client-update-core` and `provider-signin-core`.
- _Browsers:_ rebase the three browsers on the kits.
- _Gate:_ behavior parity in each browser, and its existing system tests pass.
- _Parallelism:_ one owner per runtime kit after the cores land.

**P5. Chat clients** (needs P3 + P4)

- _Clients:_ `chat-terminal` first, then `chat-desktop` and `chat-mobile` in parallel.
- _Foundations:_ `ChatHostPorts` adapters move next to the core;
  `agentic-chat-native` is built.
- _Intents and launchers:_ the intent schema and `clients.invokeIntent`, the
  foreground-intent router in each host, `notifications.respond`, and launcher
  install/remove on all hosts (sections 4.7, 5.x first rows).
- _Tests:_ P5.7, the iOS simulator smoke runner.
- _Goal gate:_ the `client-dev-loop` system tests (section 7.4) pass for the terminal, desktop and Android hosts, and the `clientdev` skill documents the loop. This is the completion criterion of the whole refactor.

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
    - `client-panel-creation-desktop`: a client window creates a panel in the
      System and Personal workspaces as a host operation after the
      panel-hosting capability gate (device op `createPanelAsClient`, the same
      path as `view.createPanel`);
    - `client-approval-desktop`: a launched client's gated call over its own
      principal session (device op `callAsClient`: the renderer relay of
      `hosts/desktop/connection/clientRelay.ts` under the renderer's
      `authorityAcquisition: "wait"` client) raises an approval owned by that
      principal in the System and the Personal workspace; the approval surface
      accepts it and the original call completes;
    - `client-revoke-desktop`: retiring the running client (device op
      `retireClient`, `runtime` `supervision.retire`) revokes its principal at
      the hub; the host closes the window with the stated reason and a new
      session with the old credential (device op `openClientSession`) is refused
      in both workspaces;
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

- Skills: `system/skills/appdev` → `system/skills/clientdev` (section 7.4), `system/apps/{shell,mobile}/SKILL.md`, the template `about/` pages and any
  skill naming `apps/`.
- Repo docs:
  - `docs/terminal-apps.md`, `docs/terminal-app-units-design.md`,
    `docs/terminal-handover.md`, `docs/cli.md`, `docs/ios-integration-plan.md`;
  - `apps/mobile/README.md` → `hosts/react-native/README.md`;
  - `README.md`'s "Desktop, server and phone" section;
  - the generated agent CLI docs.
- Fix the stale reach version (v5), the terminal contract version and the prefix-key
  documentation during the sweep.

## 12. Spike results (P0, run 2026-10-16) and remaining risks

Evidence (prototype sources and the layout diff) is kept outside the repo with the
session's scratch files. The worktree, emulator and adb server used by the spikes
were stopped and removed afterwards.

**S1. Per-client OS identity for windows in one Electron process.**

- _Ran:_ Electron 45 under Xvfb/X11 with two `BaseWindow`s, plus Electron 45 typings.
- _Result:_
  - X11: re-classing one window after mapping works (`electron` → `vibestudio-chat`
    for that window only).
  - Wayland: Electron exposes no per-window `app_id`.
  - macOS: a per-client Dock icon needs Chrome's Remote Cocoa app shims, which
    Electron does not have.
  - Found along the way: the host sets no `desktopName`, which breaks portal-backed
    `globalShortcut` on GNOME 50 and portal ≥ 1.21.
- _Effect on the plan:_ launcher identity on every OS; window identity only where
  the OS gives it per window (Windows); no X11-only path; `desktopName` is fixed
  in P2 (section 5.1).

**S2. Windows per-window AUMID and jump lists.**

- _Ran:_ Electron 45 API surface (typings). Not executed: no Windows host.
- _Result:_
  - `BaseWindow.setAppDetails` exists (win32), giving each window its own AUMID.
  - `app.setJumpList` is process-wide.
- _Effect on the plan:_ a taskbar group per client; one shared jump list; the P5
  Windows CI system test verifies it.

**S3. Concurrent RN runtimes and session-scoped capability.**

- _Ran:_ the Android emulator (API 36, x86_64) with a prototype `SpikeClientActivity` + broker.
- _Result:_
  - Two runtimes ran in one process, each with its own Recents task.
  - The second runtime was ready in 359 ms warm and 1.1 s cold.
  - The broker allowed granted sessions and denied others.
  - The memory delta was below emulator noise.
  - The OS can enter the process through a client activity.
- _Effect on the plan:_ D3 is settled for concurrency; the host runtime starts in
  `Application.onCreate`; a physical-device memory check is in P3 (section 5.3).

**S4. Split `hosts/android`, `hosts/ios`, `hosts/react-native`.**

- _Ran:_ a real `git mv` in a throwaway worktree, `pnpm install`, RN CLI config,
  `:app:assembleDebug`, and `:app:assembleInternal`.
- _Result:_
  - CLI config resolved both projects and 17 native dependencies.
  - Both variants built.
  - The build needs JDK 21 (JDK 25 fails Gradle 8.11).
  - iOS: verified at source level only (the `use_native_modules!` command argument).
- _Effect on the plan:_ the layout is adopted as specified in section 5.3; P1 pins
  JDK 21; macOS CI verifies iOS.

**S5. Hermes bytecode for client bundles.**

- _Ran:_ `hermesc -emit-binary -O` on a 3.47 MB bundle, then 6 alternating cold
  starts each on the emulator.
- _Result:_
  - About 8 % faster to `Running`, within noise.
  - 2.4× more bytes to transfer.
  - Bytecode is coupled to the exact Hermes build.
- _Effect on the plan:_ keep source bundles (section 4.9).

**S6. iOS App Intents from an RN host.**

- _Ran:_ Apple documentation and developer forums, plus RN 0.79 iOS sources. Not
  executed: no macOS host.
- _Result:_
  - Dynamic `EntityQuery` + `updateAppShortcutParameters()` work, provided the
    provider lives in the main app target.
  - Background `perform()` runs without a scene.
  - Spotlight can show stale parameter titles.
  - One `RCTReactNativeFactory` per runtime is supported by the API shape.
- _Effect on the plan:_ a headless host-runtime boot on iOS too; stable entity
  titles; execution proof in P5.7 (section 5.4).

**S7. Electron main-process inventory and moving the connection out.**

- _Ran:_ a static inventory of `src/main`, plus a prototype: Electron 45 with 3
  client windows, a `utilityProcess` that loads the real `@number0/iroh` native
  addon, and 60,000 RPCs of 16 KB each. The run compared relaying through main
  with direct `MessageChannelMain` ports.
- _Result:_
  - Relay through main: 3.24–3.36 s, RPC p50 2.2–2.3 ms, main-loop lag p99
    2.7–2.8 ms.
  - Direct ports: 1.45–1.51 s (2.2× throughput), p50 0.8–1.0 ms, main lag p99
    0.3 ms; main is idle.
  - The utility process loads Iroh fine.
  - Main also runs per-request adblock matching and CDP parsing.
- _Effect on the plan:_ the connection process and direct ports are adopted
  (section 5.1.1); adblock and CDP stay in main and are watched by the gate. The
  lag budget for the P3 gate: main-loop p99 ≤ 5 ms and no relay path, under the
  multi-client scenario.

**Remaining risks**

- **The mobile host-runtime split.** S3 removed the feasibility risk. What remains
  is engineering: moving transport ownership out of the mobile-browser bundle and
  the native broker for per-RPC streams. The fallback (one client at a time with a
  persistent host runtime) remains available.
- **iOS execution.** S4 (build), S6 and the iOS half of S3 are proven only from
  source and documentation until a macOS runner executes them. P5.7 and the macOS
  CI job are where they become evidence.
- **The scale of the P1 move.** It touches CI, packaging and every import path. It
  lands as one atomic mechanical change with no behavior edits.
- **The desktop connection process.** Moving the transport out of main touches
  every renderer's RPC path. It lands behind the existing system tests as the
  parity gate and is measured against the S7 baseline.

## 13. Decisions

- **D1. Where clients live. Decided: System only.** Trust comes from
  `trust.clients`. Clients in other workspaces are out of scope (section 4.4).
- **D2. Desktop process model. Decided: one host process, many client windows.**
  The condition is no contention between clients, which section 5.1.1 meets with the
  connection utility process, per-session ports and the main-loop gate. Per-client
  OS identity is limited to what S1 establishes.
- **D3. Mobile concurrency. Settled by S3: a host runtime plus per-client RN
  instances.** Chat and the browser are separate Recents tasks, and clients never
  touch the credential. The host runtime starts from `Application.onCreate`, or the
  iOS equivalent.
- **D4. iOS distribution. Decided: not a design constraint.** The iOS host exposes
  the same client API as Android. TestFlight and self-built distribution are the
  targets.
- **D5. Naming.** `client` as the unit kind, and "browser" for the panel-hosting
  clients (`desktop-browser`, `terminal-browser`, `mobile-browser`). "App" stays a
  user-facing word only.
