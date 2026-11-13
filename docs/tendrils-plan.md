# Tendrils: agent-written live UIs on the user's devices

Status: design and implementation plan (2026-11-13). Nothing here is implemented.
Concept source: the standalone Tendriller design (`PLAN.md`, `docs/PROTOCOL.md` in
that project). This document keeps its use cases and replaces its mechanisms with
Vibestudio's own. Claims about current code were read in this checkout (`main` at
`34ae76583`) and in the configured template checkouts
(`git config vibestudio.templateCheckouts` =
`~/vibestudio-release-work/templates`). Items marked **(unverified)** were
inferred from code reading and must be confirmed by the package that depends on
them before it builds on them.

## 1. The idea in Vibestudio terms

A **tendril** is an agent-written panel, bound to the agent's conversation
channel, presented on one or more of the user's devices. The page feeds sensor
readings, taps, voice and typed instructions back into the agent's channel, and
the agent inspects, changes and drives the page.

Most of what the standalone design has to build already exists here:

| Tendriller mechanism | Why it existed | Vibestudio equivalent |
| --- | --- | --- |
| Cloudflare relay, one DO per tendril, page URL + agent token | Agents had no shared infrastructure and no web server | The home server, paired devices over Iroh, panels, channels. No URLs, no tokens. |
| `tendril.js` injected by the server | Pages were plain HTML | A Base workspace package, `@workspace/tendril`, that the panel imports. |
| `PUT files`, versions | Agents uploaded HTML | Panel source in the agent's workspace context; BuildV2 content-addressed builds; slot history. |
| `GET events` long-poll, webhooks, wake recipes per host | Turn-based agents had no wake path | Channel publish → `acceptChannelDelivery` → agent vessel. Wake opt-in per payload kind (`observations.payloadKinds`). |
| `POST eval` | No other way into the page | Panel RPC (`handle.call`) to methods the kit exposes; CDP where the host supports it. |
| Health check + automatic rollback | Upload could break the page | Slot history entries become *proven* only after a ready boot; an unproven entry that fails is reverted (section 4.4). |
| Roles: owner / guest / display | Anyone with the link could connect | Paired devices of workspace members; envelope origin stamping; guest and display devices are phase 3 (section 4.6). |
| Activity record | Server-side audit | The channel log, with verified origin on every envelope, rendered in the chat transcript. |
| Wake budget per hour | Cost control | A lifecycle bound: a cap on consecutive observation-started turns, reset by human input (section 4.3). |
| Web push, VAPID | No app | Existing FCM/APNs push path; presentation requests push the target device (section 4.5). |
| `agent.md` | Agents had no shared docs | Base skill `skills/tendrils/SKILL.md`. |

### 1.1 Timeouts and expiries that go away

The standalone protocol uses several clocks. `AGENTS.md` forbids clocks that stand
in for missing lifecycle facts, so each is re-derived from a lifecycle fact:

| Standalone clock | Replacement |
| --- | --- |
| 25 s long-poll, 300 ms debounce, 2 s webhook debounce, retry backoff | None needed. Channel delivery is durable, at least once, and redriven by `DurableWorkDriver`. |
| Health: "2 s after load without error", "15 s without report → failed" | The page's own ready signal (`__vibestudioPanelMarkReady`, which the kit can defer with `ready.manual()`), boot-failure events, and the boot-stall detector. |
| "Not responding" after a 120 s grace | Delivery receipts and trajectory events: delivered, turn opened, turn waiting, turn closed. "Not responding" is not shown. |
| Ad hoc tendril expires after 24 h idle, links expire | No expiry. A tendril lives until the agent or user archives its slots. Ephemeral tendrils use eval `lifetime: "invocation" \| "session"`. |
| Adopt code valid for 10 min | No adoption step. A new agent session subscribes to the tendril's channel. |
| Wake budget per hour, 3 s merge window | Consecutive-observation-turn cap (section 4.3); observations that arrive while a turn is queued or running fold into it (existing steer/follow-up). |
| Activity kept 30 days, event dedupe kept 24 h | The channel log is the record. Its retention and deletion are open question Q3. Dedupe uses the channel's `idempotencyKey`. |

The only deadline that stays is the one the platform imposes: the FCM data payload
limit, which notification copy already respects.

## 2. Where the work lives

| Area | Repository / checkout | Worktree for this effort |
| --- | --- | --- |
| Host: server, service schemas, desktop host, RN host, Android, iOS, mobile smoke | this monorepo | `~/vibestudio-tendrils` (branch `tendrils`) |
| Kit, Tendril worker, channel and vessel changes, runtime API, chat rendering, skill | Base template (`panticonic/vibestudio-base`) | `~/vibestudio-tendrils-templates/base` (branch `tendrils`) |
| Mobile browser client (presentation requests, device bridge wiring) | System template (`panticonic/vibestudio-system`) | `~/vibestudio-tendrils-templates/system` (branch `tendrils`) |
| Agentic system-test scenario | System-testing template | `~/vibestudio-tendrils-templates/system-testing` (branch `tendrils`) |
| Personal | unchanged | `~/vibestudio-tendrils-templates/personal` (worktree on `main`, needed only to complete the collection root) |

Create the template worktrees from the configured checkouts under
`~/vibestudio-release-work/templates/<name>` (for example
`git -C ~/vibestudio-release-work/templates/base worktree add -b tendrils ~/vibestudio-tendrils-templates/base main`).
Launch with `--template-checkouts ~/vibestudio-tendrils-templates`. Never run
pnpm, Vitest or tsc inside a template worktree; use
`pnpm test:userland -- --template base|system --filter …` and
`pnpm type-check:userland -- --template …` from `~/vibestudio-tendrils`.
`~/2-vs-templates` is a stale September checkout; do not use it.

## 3. What already exists

| Need | Existing mechanism (path) | Gap |
| --- | --- | --- |
| Agent writes and rebuilds a panel | `openPanel` / `handle.rebuild()` / `navigate()` from eval; `ref: "ctx:<id>"`; `build.getBuildReport`; harness `verify` (`base/packages/runtime/src/shared/panelRuntime.ts`, `base/packages/harness/src/tools/verify.ts`) | No live reload (none wanted: updates are explicit). `rebuild` replaces history, so there is nothing to go back to. |
| Compile failure never reaches the user | Preparation happens before `commitPreparedPanelNavigation`; the old instance stays | A build that compiles but fails at boot (`entry_threw`, `render_crashed`, `boot_stalled`) is committed and shown. |
| Pin an exact build | `CreatePanelSlotOptions.artifact {buildKey, executionDigest}` | `navigate`/`rebuild` do not carry it; history entries do not record proof of health. |
| Boot health | `PanelObservation.phase/failure`, `bootReporter.ts`, `panelBootstrapScript.ts`, `panelRuntimeCoordinator.ts` | Health after boot is not tracked (by design, kit reports it as `ui.feedback`). Boot-stall detection is described in `docs/panel-boot-lifecycle-redesign.md` (status "proposed") **(unverified whether shipped)**. |
| Agent inspects/drives the page | `handle.cdp.session()`, `cdp.screenshot()`, `consoleHistory()`, `diagnose()`, `snapshot()`; headless host default | CDP is refused for mobile-held panels (`cdp_unavailable_mobile_held`, `src/server/panelRuntimeRegistration.ts`). Desktop refuses physical-world permissions while an agent has CDP control (`browserPermissionController.ts` automation taint). |
| Page → agent events, wake | `PubSubClient.publish(type, payload)`; channel `publish` with `idempotencyKey`; vessel intake `input`/`observation`; `observations.payloadKinds` opt-in (`base/packages/agentic-core/src/agent-subscription-config.ts`, `agent-vessel.ts`) | No bound on page-driven wakes except `agentHops`, which only counts agent senders. |
| Provenance | Human participants are `user:<userId>` stamped from the verified caller (`channel-do.ts` `subscribe`); context-integrity latch | Every panel the user runs, including agent-written ones, publishes as `user:<id>`. The model input carries no origin label. |
| Roles | Workspace roles root/admin/member (WP9) gate admin operations only | No guest or display role. Members are mutually trusted. |
| Notifications | `notify` tool with `alert: none \| inbox \| interrupt`; `notification.pushUserInbox`; `pushService.sendToTargets({userId, clientId})`; notification action commands `panel.open` / `panel.focus` (`packages/service-schemas/src/notification.ts`) | No way for an agent to put a panel on a specific device and bring it forward. |
| Placement | Panel forest per user (WorkspaceDO), exclusive runtime leases (`panelRuntimeCoordinator.ts`), `takeOverSlot`, `ensureSlot` | No device-targeted presentation; no list of the user's devices for this purpose; no mirroring (one slot, one host). |
| Sensors in panels | Standard web APIs; `browserPermissions.request` approval with per-origin grants (`src/server/services/browserPermissionsService.ts`); Android WebView patch routes camera/mic/geolocation; iOS handles camera/mic | iOS: no WebView geolocation handling, no `NSLocation*` keys, no motion permission handling. No native keep-awake, TTS (Android WebView lacks `speechSynthesis`) or haptics bridge for panels. No background location. |
| Speech to text | Base `extensions/speech` (offline Whistle), `useDictation.transcribeRecording` | Clip-based, not streaming. No TTS anywhere. |
| State shared across devices and reloads | `contextId` storage, Durable Objects, channels | No ready-made shared JSON state with live fan-out. |
| Offline | Mobile content-addressed asset store, stable loopback port, startup snapshot | Panels need the live RPC session; cold start offline does not work **(unverified)**. |
| Testing | `vibestudio mobile smoke` / `pnpm test:iroh-mobile-e2e` (Android emulator, WebView CDP via adb); `extensions/mobile-debug`; `pnpm system-test` | No iOS simulator on Linux. |

## 4. Design

### 4.1 Objects

- **Tendril**: one `TendrilDO` instance (Base `workers/tendril`), keyed by a
  creator-chosen UUID. It owns the tendril's identity, its `about` handover note,
  its shared state, the list of presentations, and the functions each
  presentation exposes. It does not own events (the channel does) or code
  versions (slot history does).
- **Source**: an ordinary panel unit in a workspace repository the agent edits,
  built from the agent's context ref. The personal library is simply these
  panels.
- **Presentation**: one panel slot showing the tendril on one device. Several
  devices mean several slots, all sharing the `TendrilDO`, the channel and the
  `contextId`. Slots stay exclusive; there is no mirroring.
- **Channel**: the agent's existing conversation channel. "Keep working on my
  presentation", spoken into the road-trip tendril, lands in the same
  conversation as chat.

The slot's `stateArgs.tendril = { tendrilId, channelId }` is the binding.

### 4.2 Page ↔ agent traffic

| Direction | Mechanism | Instruction or data |
| --- | --- | --- |
| Page event that should wake | channel `publish("tendril.event", …)` | Data. Arrives as a `channel-observation` block. |
| Page event that should only be recorded | channel `publish("tendril.record", …)` | Data. Kept as a passive observation pointer. |
| Owner voice or text from the kit control | `PubSubClient.send(text, {metadata: {tendril}})` as the user | Instruction (an ordinary user message). |
| Boot or runtime failure | existing `ui.feedback` payload, `occurrenceKey` per build | Data; the first failure starts a repair turn (existing admission). |
| Agent reads/writes shared state | `TendrilDO` RPC from eval | n/a |
| Agent runs code in the page | `handle.call["tendril.eval"]` (kit-exposed RPC); CDP when available | n/a |
| Agent calls a page function | `handle.call["tendril.fn"]({name, args})` | n/a |
| Live state fan-out | `TendrilDO` sends channel signal `tendril.state` (ephemeral); pages refetch the snapshot on reconnect | n/a |

Whether an event wakes the agent is chosen by its payload kind, not a flag. The
agent subscribes with `observations: { payloadKinds: ["tendril.event"] }`. The
skill teaches the three tiers (reflex in page code, `record`, `event`), because
streaming a sensor into the session is the natural mistake.

Blobs (photos, clips) go through `blobstore.putBytes`; events carry
`BlobRef`s, never bytes.

### 4.3 Bounding page-driven wakes

`agentHops` already stops agent ping-pong. The page loop is the same shape: page
event → turn → agent changes the page → page event. The vessel gets the matching
rule for observations:

- Count consecutive turns started by an observation on a channel. A turn started
  by human input (a `message.completed` from a `user:` participant) resets the
  count to 0.
- When the count reaches `observations.maxConsecutiveWakes` (default 6), further
  observations are recorded as passive pointers and do not wake.
- The vessel sends the ephemeral channel signal `agent.observations-withheld`
  `{count, payloadKinds}`. The kit shows "the agent will see this next time you
  talk to it". The next turn's context carries the withheld count.
- Observations that arrive while an observation-started turn is queued or running
  fold into it through the existing steer/follow-up path. No time window.

This bound is causal, not temporal. It is open question Q2 whether the user also
wants an hourly cost ceiling. If so, it is an explicit user requirement and can
be added as one.

### 4.4 Updates that never break the page, and undo

Slot history entries gain a proof state: `unproven`, `proven`, or
`failed(PanelRuntimeFailure)`.

1. A tendril update is `rebuild({history: "append"})` (or `navigate` with
   `artifact`). It appends an `unproven` entry that pins the exact
   `{buildKey, executionDigest}`.
2. The first time any host boots that entry to `ready`, the coordinator marks it
   `proven`.
3. If the current entry is `unproven` and its boot fails (any
   `PanelRuntimeFailure`, including boot stall), the coordinator marks it
   `failed` and navigates the slot to the newest `proven` entry. The user sees
   the loading state, then the previous version.
4. Booting happens on the device that holds the slot. A failure specific to a
   device is caught on that device. A slot that is not materialized while it is
   updated is checked when it next is.
5. The agent learns of the failure in two ways. A waiting `rebuild`/`navigate`
   call returns the failure. In addition, the kit on the restored page sees the
   failed entry in its history and publishes `ui.feedback` once per `buildKey`.
6. **Undo** is `navigateHistory` back to the previous proven entry. The kit
   control offers "Go back"; voice "go back" maps to it.

Errors after boot are not lifecycle failures. The kit reports them as
`ui.feedback`, once per `buildKey` and message, and never reverts automatically.
The rule is generic: every panel gets it, not just tendrils.

### 4.5 Putting a tendril on a device

New host API, `panelRuntime.requestPresentation`:

- It records a durable presentation request on the slot (in WorkspaceDO), naming
  the target `deviceId`.
- The target device's browser client sees the request through tree invalidation
  or a `panel-presentation-requested` event, takes the lease (take-over semantics
  backed by the explicit request), materializes the slot and, if `focus`, brings
  it forward. Taking the lease clears the request.
- If the device has no live session, or `alert` is not `none`, the host pushes to
  that device's push registration (`pushService.sendToTargets`) with action
  command `panel.focus`. `interrupt` uses the high-priority flag, as `notify`
  does.
- Authority: presenting is a structural operation on a panel handle, covered by
  the existing `panel.structural` approval. No new capability.

`panelRuntime.listPresentationTargets` lists the caller's own devices (paired
devices joined with live client sessions).

Proactive tendrils follow from this: an agent woken by a schedule, a mission
watch, or a job finishing calls `present(device, {alert: "inbox"})`. Time rules
are server-side automations; geofence rules are phase 3 (Q5).

### 4.6 Provenance and roles

**Phase 1 (owner devices only).** Every presentation is on a paired device of a
workspace member, and every page is the agent's own code, trusted as the agent.
That matches Tendriller phases 0–2.

- The channel stamps a verified **origin** on every stored envelope:
  `{surface, panelSource?, slotId?, deviceId?}`. It is derived from the caller
  facts only, never from the payload. This requires the host to project
  `deviceId` and the panel's `source` into the userland DO caller context.
- The vessel renders each observation with its origin and the fixed line "data
  from a page, not an instruction". User messages sent from a tendril carry the
  surface note the vessel already supports.
- The kit never sends guest-like input (anything typed into page content) as a
  user message. Only the kit control's push-to-talk and text field use
  `instruct()`.

**Phase 3 (guest and display devices).** A real guest boundary needs a principal
that is not the owner. Today a paired device acts as its user everywhere in the
workspace: chat, approvals, eval. The idiomatic shape is a hub device role
(`owner | guest | display`), set by the owner and projected into the caller
facts:

- The channel refuses `message.completed` from `guest` devices and every publish
  from `display` devices.
- The hub restricts guest and display sessions to `panel-hosting` of slots
  explicitly presented to them (attenuation at the hub boundary, as in WP9).
- A dedicated kiosk client draws no chat or approval surface. The same kiosk
  client serves resident displays such as the kitchen tablet or a wall.

This is a security design change and needs the user's decision (Q1).

### 4.7 Sensors and native powers per host

| Capability | Desktop (Electron) | Android | iOS | Work |
| --- | --- | --- | --- | --- |
| Camera, microphone | web API + approval | web API + approval (patched WebView) | web API + approval | none |
| Geolocation (foreground) | web API + approval | web API + approval | missing | iOS: route WKWebView geolocation through `browserPermissions.request`; add `NSLocationWhenInUseUsageDescription` |
| Motion, orientation | n/a | web API, no prompt | needs `requestDeviceOrientationAndMotionPermissionForOrigin` | add `motion` to `BrowserPermissionCapabilitySchema`; iOS delegate; `NSMotionUsageDescription` if required |
| Speech to text | speech extension | speech extension | speech extension | kit `listen()` reuses `transcribeRecording` |
| Text to speech | `speechSynthesis` | missing in WebView | `speechSynthesis` | native `device.speak` bridge (Android `TextToSpeech`, iOS `AVSpeechSynthesizer`) |
| Keep screen on | Wake Lock API | bridge | bridge | native `device.keepAwake` (`FLAG_KEEP_SCREEN_ON`, `idleTimerDisabled`), scoped to the presented slot being visible |
| Haptics | n/a | bridge | bridge | `device.haptic` via the already-allowed `react-native-haptic-feedback` |
| Notifications | host push | host push | host push | covered by 4.5 |
| Background location, geofences | n/a | needs foreground service + background connectivity | needs background mode | phase 3, Q5 |

The bridge is `__vibestudioShell.device` (mobile), gated by `panel-hosting` like
the rest of the bridge. The kit feature-detects web APIs first, then the bridge.
Any change to the bridge contract bumps `rn-host-6` → `rn-host-7` and requires a
new binary.

The desktop automation taint has a consequence. While the agent drives a sensor
page over CDP, camera, mic and location are refused. The skill tells agents to
drive tendrils through the kit's RPC (`tendril.eval`), which does not taint,
because the code is the agent's own panel code with the panel's own grants. CDP
remains for screenshots and input simulation on headless and desktop hosts.

### 4.8 Voice

- **Push-to-talk** in the kit control: record → speech extension →
  `voice.handle(text)`.
- **Fast layer (phase 2)**: a local phrase matcher over the functions the page
  exposed (`expose(name, {phrases})`). A match runs the function locally and
  publishes `tendril.record {voice: {text, function}}`. Anything unmatched goes to
  the agent as an instruction ("passed to the agent" is shown).
- A model-based fast layer (local model or realtime provider) is phase 3 and
  depends on Q4.

### 4.9 Presence

The kit derives agent status from the channel: trajectory events give working,
waiting and idle; delivery receipts give "delivered"; the withheld signal gives
withheld. Sound and haptics come via the bridge. Announcements go through an ARIA
live region and are never colour-only.

### 4.10 Offline

- The kit keeps an IndexedDB outbound queue. Every publish carries
  `idempotencyKey = cid`, so resending is safe. Queued sends drain on the
  runtime's reconnect.
- State ops are applied locally and queued; the server applies them
  last-writer-wins per path, in `TendrilDO` order.
- An offline cold start of a cached, proven tendril is phase 3. It needs
  verification that the asset facade serves the cached build and that panel init
  survives without the server (Q6).

### 4.11 Not carried over

- Per-tendril subdomains, page keys, agent tokens and links. The device and the
  user are already authenticated.
- Host-specific wake recipes.
- The axe-core CDN check. An agent that wants an audit adds `axe-core` as a
  workspace dependency of its panel and runs it via `tendril.eval`; the skill
  documents this.
- End-to-end encryption. Traffic never leaves the user's server and devices
  except for push payloads, which carry no content.

## 5. Pinned contracts

Parallel packages implement against these exact shapes. A package that has to
deviate edits this section in the same change and tells the dependent packages.

### 5.1 Channel payloads (Base, `packages/tendril/src/protocol.ts`, zod)

```ts
type BlobRef = { id: string; mimeType: string; name?: string; size: number };
type TendrilPresentationRef = { tendrilId: string; slotId: string; deviceId: string | null };

// publish type "tendril.event" (wakes when the agent opted in) and
// "tendril.record" (never in payloadKinds; recorded only). Max 64 KiB serialized.
type TendrilEventPayload = TendrilPresentationRef & {
  cid: string;            // client id; also the publish idempotencyKey
  data: unknown;          // JSON
  blobs?: BlobRef[];
};

// ephemeral channel signal "tendril.state", sent by TendrilDO
type TendrilStateSignal = { tendrilId: string; rev: number; ops: StateOp[]; by: string };
type StateOp = { op: "set"; path: string[]; value: unknown } | { op: "delete"; path: string[] };

// user message metadata for instructions spoken or typed into the kit control
type TendrilInstructionMetadata = { tendril: TendrilPresentationRef & { via: "voice" | "text" } };
```

Runtime failures use the existing `ui.feedback` payload with
`occurrenceKey = "tendril:" + buildKey + ":" + sha256(message).slice(0, 16)`.

### 5.2 `TendrilDO` (Base `workers/tendril`, class `TendrilDO`)

```ts
create(input: { source: string; channelId: string; contextId: string; name: string;
                about?: TendrilAbout }): Promise<TendrilDescription>;   // idempotent per key
describe(): Promise<TendrilDescription>;
setAbout(about: TendrilAbout): Promise<void>;
getState(): Promise<{ rev: number; state: Record<string, unknown> }>;
applyState(input: { cid: string; ops: StateOp[] }): Promise<{ rev: number }>; // dedup by cid
registerPresentation(p: { slotId: string; deviceId: string | null; label: string }): Promise<void>;
unregisterPresentation(slotId: string): Promise<void>;
registerFunctions(slotId: string, fns: TendrilFunctionDecl[]): Promise<void>;

type TendrilAbout = { purpose: string; layout?: string; source?: string };
type TendrilFunctionDecl = { name: string; description: string;
                             parameters?: JsonSchema; phrases?: string[] };
type TendrilDescription = { tendrilId: string; source: string; channelId: string; contextId: string;
  name: string; about: TendrilAbout | null;
  presentations: { slotId: string; deviceId: string | null; label: string }[];
  functions: (TendrilFunctionDecl & { slotId: string })[]; rev: number };
```

Reserved state keys: `_prefs` (text size, contrast, audio, language; set by the
control) and `_device.<deviceId>`.

### 5.3 Kit, page side (`@workspace/tendril`)

```ts
connectTendril(): Promise<Tendril>;          // reads panel.stateArgs.tendril
interface Tendril {
  device: { id: string | null; label: string; platform: "desktop" | "mobile" | "headless" };
  send(data: unknown, opts?: { wake?: boolean; blobs?: BlobRef[] }): Promise<{ queued: boolean }>;
  instruct(text: string, via: "voice" | "text"): Promise<void>;   // used by the control only
  state: { get(path?: string | string[]): unknown; set(path, value): void; delete(path): void;
           patch(mergePatch: object): void; on(fn: (state, ops, by) => void): () => void };
  expose(name: string, decl: Omit<TendrilFunctionDecl, "name">, fn: (args: any) => unknown): () => void;
  upload(blob: Blob, opts?: { name?: string }): Promise<BlobRef>;
  ready: (() => void) & { manual(): void };
  agent: { status(): AgentStatus; on(fn: (s: AgentStatus) => void): () => void };
  listen(opts?: { signal?: AbortSignal }): Promise<string>;      // speech extension
  native: { keepAwake(on: boolean): Promise<void>; haptic(kind: HapticKind): Promise<void>;
            speak(text: string, opts?: { lang?: string }): Promise<void>; supported: string[] };
}
type AgentStatus = { state: "idle" | "working" | "waiting" | "unattached"; withheld: number };
type HapticKind = "light" | "medium" | "heavy" | "success" | "warning" | "error";
mountTendrilControl(t: Tendril, opts?: { position?: "bottom-right" | "bottom-left" }): { hide(); show() };
```

RPC the kit exposes on every presentation (`rpc.expose`):
`"tendril.eval"({code}) → {ok, value?, error?, console}` (uses `@workspace/eval`
like `client_eval`), `"tendril.snapshot"() → {text, html}`,
`"tendril.console"({after?}) → {entries}`, `"tendril.fn"({name, args}) → unknown`.

### 5.4 Kit, agent side (`@workspace/tendril/agent`, importable in eval)

```ts
listDevices(): Promise<PresentationTarget[]>;
createTendril(o: { source: string; channelId: string; contextId: string; ref: string; name: string;
                   about?: TendrilAbout }): Promise<TendrilHandle>;
openTendril(tendrilId: string): Promise<TendrilHandle>;
interface TendrilHandle {
  id: string; describe(): Promise<TendrilDescription>;
  present(deviceId: string, o?: { focus?: boolean; alert?: "none" | "inbox" | "interrupt" }): Promise<PresentResult>;
  update(): Promise<{ slotId: string; outcome: "proven" | "pending-device" | { failed: unknown } }[]>;
  back(slotId?: string): Promise<void>;
  eval(code: string, o?: { slotId?: string }): Promise<unknown>;
  call(name: string, args?: unknown, o?: { slotId?: string }): Promise<unknown>;
  state: { get(): Promise<{ rev: number; state: object }>; apply(ops: StateOp[]): Promise<{ rev: number }> };
  archive(): Promise<void>;
}
```

### 5.5 Host contracts (`~/vibestudio-tendrils`)

```ts
// packages/service-schemas/src/panelRuntime.ts
panelRuntime.listPresentationTargets(): PresentationTarget[];
type PresentationTarget = { deviceId: string; label: string;
  platform: "desktop" | "mobile" | "headless"; online: boolean; clientSessionId: string | null };
panelRuntime.requestPresentation(r: { slotId: string; deviceId: string; focus: boolean;
  alert: "none" | "inbox" | "interrupt" }): PresentResult;
type PresentResult = { state: "presented" | "pending-device" | "pushed" };
// event to clients: "panel-presentation-requested" { slotId, deviceId }
// push data: { kind: "panel-present", workspaceId, slotId }, action command { type: "panel.focus", panelId: slotId }

// slot history entries (WorkspaceDO + shell-core projection)
type HistoryProof = { state: "unproven" } | { state: "proven" } | { state: "failed"; failure: PanelRuntimeFailure };
// every entry pins { buildKey, executionDigest } once materialized

// runtime: rebuild(opts?: { history?: "append" | "replace" }) default "replace" (unchanged)
//          navigate(..., { artifact? }) passes the pin through
// panel init / panel.getInfo(): device: { id: string | null; label: string; platform }

// userland DO caller context (base durable-base RpcInvocationContext + host relay headers)
callerDeviceId: string | null;   // from the caller's verified device
callerPanelSource: string | null; // verified code identity source of a panel caller
// [H2 clarification] On the wire these are optional AuthenticatedCaller fields
// (`packages/rpc/src/types.ts`), absent = null. Device derivation is one function,
// `src/server/callerDeviceFacts.ts` `deviceIdOfHostPrincipal`: `shell:<deviceId>` → deviceId;
// `client:` principal → its attested identity.db deviceId; a panel → the device of the host
// session holding its runtime lease. Local consoles (`electron-main`, `headless-host`) → null
// (open: H1 must decide how they appear in PresentationTarget and reuse this function).

// packages/service-schemas/src/browserPermissions.ts: add "motion" to BrowserPermissionCapabilitySchema

// mobile bridge (rn-host-7): __vibestudioShell.device
{ capabilities(): Promise<string[]>; keepAwake(on: boolean): Promise<void>;
  haptic(kind: HapticKind): Promise<void>; speak(o: { text: string; lang?: string }): Promise<void>;
  stopSpeaking(): Promise<void> }
```

### 5.6 Channel and vessel (Base)

```ts
// stored envelope field, set by channel-do from caller facts only
origin?: { surface: "panel" | "shell" | "client" | "agent" | "website" | "host";
           panelSource?: string; slotId?: string; deviceId?: string };
// agent-subscription-config: AgentObservationConfig gains
maxConsecutiveWakes?: number;  // default 6, 1..64
// ephemeral signal from the vessel
"agent.observations-withheld": { count: number; payloadKinds: string[] }
```

## 6. Work packages

Every package lists the files it owns. No file is owned twice. Shared contracts
are fixed in section 5, so every package can start at once against them; edges
below are integration edges, not start edges.

| ID | Repo | Goal | Owns | Provides / consumes | Verification |
| --- | --- | --- | --- | --- | --- |
| **H1** Presentation and proven history | host | 4.4 server side, 4.5 server side | `src/server/panelRuntimeCoordinator.ts`, `src/server/services/panelRuntimeService.ts`, `src/server/panelRuntimeRegistration.ts`, `packages/service-schemas/src/panelRuntime.ts`, `packages/builtin/src/workspace-state/WorkspaceDO.ts` (slot history, presentation request), `packages/shell-core/src/panelManager.ts` (history projection), push wiring in `src/server/services/pushService.ts`, their tests | Provides 5.5 panelRuntime + history proof. Consumes push registrations. | Vitest units: proof transitions, revert-to-proven on each failure stage, request cleared by lease, push when offline. `tests/headless-panel.integration.test.ts` extension: broken build reverts. |
| **H2** Caller device facts | host | `callerDeviceId`, `callerPanelSource` to userland DOs; `device` in panel init | `src/server/doDispatch.ts`, `src/server/workerdRpcRelay.ts`, panel init builder (`src/server/panelBootstrapScript.ts` or where `getPanelInit` is assembled), `packages/shared/src/serviceDispatcher.ts` (if the fact is added there) | Provides 5.5 caller fields. | Units on relay header projection; existing authority matrix golden updated. |
| **H3** Mobile native powers | host | 4.7 native column | `hosts/android/**`, `hosts/ios/**`, `hosts/react-native/src/host/**`, `packages/rn-client-api/**`, `patches/react-native-webview@*.patch`, `packages/service-schemas/src/browserPermissions.ts`, `src/server/services/browserPermissionsService.ts`, `packages/workspace-contracts/src/clients.ts` (ABI bump, catalog) | Provides `__vibestudioShell.device` native side, `motion` capability, iOS geolocation. | `pnpm test:mobile`, Android JVM tests, `tests/mobileNativeAndroid.test.ts`-style contract tests, emulator smoke (section 7). iOS: native tests on macOS only (blocker, section 9). |
| **H4** Desktop presentation | host | Desktop browser honours presentation requests | `hosts/desktop/main/panelPresentation*` / `PanelPresentationController` files, desktop tests | Consumes H1 event. | Desktop unit tests; `pnpm test:e2e` flow. |
| **H5** Mobile smoke for tendrils | host | Emulator evidence | `scripts/cli/mobile-smoke.mjs` (new tendril phase), `tests/mobile-smoke-*.test.ts` additions | Consumes H1, H3, S1, B2. | Itself. |
| **S1** Mobile browser client | System | Presentation requests, device bridge wiring, `motion` prompt copy, device in panel init | `system/clients/mobile-browser/src/**` | Consumes H1 event, H3 native API. | `pnpm test:userland -- --template system --filter clients/mobile-browser/...`; type-check. |
| **B1** Channel origin and wake bound | Base | 4.3, 4.6 phase 1 | `base/workers/pubsub-channel/**`, `base/packages/agentic-do/src/agent-vessel.ts`, `base/packages/agentic-do/src/native-channel-session.ts`, `base/packages/agentic-core/src/agent-subscription-config.ts`, `base/packages/agentic-protocol/src/**` (types) | Provides 5.6. Consumes H2 caller fields (falls back to `callerPanelId` until H2 lands). | `pnpm test:userland -- --template base --filter packages/agentic-do/... --filter workers/pubsub-channel/...`: streak cap, reset on human input, withheld signal, origin never from payload. |
| **B2** Kit and TendrilDO | Base | 4.1, 4.2, 4.8, 4.9, 4.10 kit side | `base/packages/tendril/**` (new), `base/workers/tendril/**` (new) | Provides 5.1–5.4. Consumes H1 (`requestPresentation`, history), B3 runtime options, H3 bridge (feature-detected). | Unit tests for state ops/LWW/dedup, outbound queue, phrase matcher, control a11y (browser tests), DO tests. |
| **B3** Runtime API | Base | Expose H1/H2 in `@workspace/runtime` | `base/packages/runtime/src/shared/panelRuntime.ts`, `base/packages/runtime/src/shared/handles.ts`, `base/packages/runtime/src/worker/durable-base.ts`, `base/skills/sandbox/RUNTIME_API.md` (generated; run `pnpm check:runtime-docs`) | Provides `rebuild({history})`, `navigate({artifact})`, `requestPresentation`, `listPresentationTargets`, `panel.getInfo().device`, DO caller fields. | Runtime unit tests; `pnpm type-check:userland -- --template base`. |
| **B4** Skill and transcript rendering | Base | Agent instructions; owner-visible activity | `base/skills/tendrils/**` (new), `base/packages/agentic-chat/**` renderer for `tendril.*` observations and origin chips | Consumes 5.1, 5.6. | Browser tests for the renderer; skill index check. |
| **V1** Agentic system test | System-testing | End-to-end proof on headless host | `system-testing/workers/system-test-runner/**` (new `tendril-loop` case) | Consumes all phase 1 packages. | `pnpm system-test --instance tendrils doctor` then `run tendril-loop`. |

### 6.1 Dependency edges

- B2 ⟶ B3 ⟶ H1/H2: the kit calls runtime APIs that call the host. All three
  start immediately against section 5; integration order is H1/H2 → B3 → B2.
- B1 is independent of everything except the optional H2 fact.
- H3 and S1 integrate pairwise; neither blocks phase 1 core.
- V1 and H5 are last. Critical path: H1 → B3 → B2 → V1.

### 6.2 Phases

| Phase | Packages | Proof |
| --- | --- | --- |
| 1. Loop | H1, H2, H4, B1, B2 (no voice/native), B3, B4, S1 (presentation only), V1 | The agent creates a tendril, presents it on the headless host and the emulator. A tap wakes the idle agent; the agent changes the page. A deliberately broken update reverts and starts a repair turn. "Go back" restores the previous view. A page firing events in a loop stops waking the agent after the cap. |
| 2. Senses | H3, S1 (bridge), B2 (voice, native, listen, phrase layer), H5 | On the emulator: emulated GPS (`adb emu geo fix`) and accelerometer (`adb emu sensor set`) reach the agent as data; a photo from the emulated camera is described; push-to-talk becomes a user message; TTS speaks a reply. |
| 3. Reach | Guest/display devices and kiosk client, offline cold start, background location and geofences, home-screen pinning of a panel location, deletion from the activity record, model-based voice layer | Each gated on Q1–Q6. |

## 7. Verification without a phone

- **Android emulator is available.** `~/Android/Sdk` has `adb`, `emulator`, an
  x86_64 system image, and `/dev/kvm` is usable. The only AVD is `NatStack_Test`.
  The AVD resolver would silently reuse it, and an earlier audit says not to. H5
  must create and own a dedicated AVD (for example `Vibestudio_Tendrils`) and pass
  `--avd` explicitly.
- Emulated sensors: `adb emu geo fix <lon> <lat>`, `adb emu sensor set
  acceleration x:y:z`, the virtual scene camera, and the host microphone where
  configured. Dev builds enable WebView debugging, so the smoke can drive panel
  WebViews over CDP through adb, as `assertWorkspaceBrowserPermission` already
  does.
- Push on the emulator needs `google-services.json`. Without it, push is
  log-only, and the smoke asserts the request and the log line rather than
  delivery. Real FCM/APNs delivery needs a real device (`docs/approvals.md`).
- **iOS cannot be built or run on this Linux machine.** iOS changes in H3 can be
  checked only by static/contract tests here; they need a macOS run.
- Headless host covers everything except native powers: V1 runs the whole phase 1
  loop on the headless host with CDP for taps.

## 8. Open questions for the user

- **Q1 Guests.** Do guest and display devices (back-seat tablet, kitchen tablet,
  a friend's phone) justify a non-owner hub device role, attenuated sessions and a
  kiosk client (section 4.6)? Or is "owner devices only" enough for now? Guests
  without the app (an ordinary browser via `vibestudio.app`) would need a much
  larger public-serving design and are not proposed.
- **Q2 Wake bound.** Is the causal cap (section 4.3) enough, or do you want an
  explicit hourly ceiling as a cost requirement?
- **Q3 Activity deletion.** Channels have no deletion contract. Should the owner
  be able to delete received items (a channel tombstone contract), knowing the
  agent's transcript in GAD keeps what it already read?
- **Q4 Fast voice layer.** Local phrase matching only, a local model
  (`system/extensions/local-models`), or a hosted realtime provider?
- **Q5 Background location and geofences.** Worth an Android foreground service
  and iOS background location (store review implications, battery), plus
  background connectivity, which Iroh deliberately does not keep today?
- **Q6 Offline cold start.** Is offline reopening of a cached tendril a phase 1
  requirement (road trip through a tunnel) or phase 3?

## 9. Not verified, and blockers

- Whether `handle.call` reaches a panel held by a mobile client. It should, since
  panel RPC uses the panel's own session, but this was not run. H1 must confirm
  it with a test before B2 relies on it. If it fails, that is a host routing
  defect to fix, not a reason to add a second path.
- Whether the boot-stall detector from `docs/panel-boot-lifecycle-redesign.md` is
  live. If it is not, a hanging candidate stays `loading` and section 4.4 step 3
  never fires for it. H1 owns that dependency.
- Whether `navigateHistory` re-creates the exact old build or re-resolves the ref.
  H1 makes entries pin their artifact either way.
- Whether WKWebView needs `NSMotionUsageDescription` for web motion events, and
  whether Android WebView supports the Screen Wake Lock API. H3 decides by test.
- Several participants on one `user:` id: kit presentations and the chat panel
  share the user's participant id with separate sessions. The design avoids
  channel method offers from tendril pages for this reason; B2 must confirm that
  plain `publish` from several sessions is fine.
- iOS: no simulator here (blocker for iOS verification only).

## 10. Implementation status (single track, 2026-11-13)

Decisions taken while implementing (they change sections 4.4, 4.5 and 5.5):

- **Proof and presentation state live with the host, not in WorkspaceDO.** Internal
  product DOs receive no schema descriptor, so the durable framework has no trusted
  target fingerprint for an in-place WorkspaceDO upgrade; a version bump would reset
  every workspace. Proof is a property of an exact build (execution digest) observed
  by the host coordinator, and presentation requests concern host devices, so both
  live in `src/server/panelRuntimeStore.ts` (`<state>/panel-tree/panel-runtime.db`,
  canonical SQLite, additive migrations allowed). Proof is keyed by execution digest,
  not history entry: the same build reused in another entry is equally proven.
- **Local consoles have device ids.** `deviceIdOfHostPrincipal` names `electron-main`
  and `headless-host` as `local:<principal>`, so a panel can be placed on this machine
  and its panels carry a stable device origin (resolves the H2 open question).
- **Push registrations record their device** from the verified caller principal
  (`push_registration_devices`, push DB v2, additive migration), so presentation can
  notify exactly one device.
- **Pending requests are read, not only evented**: `panelRuntime.listPresentationRequests`
  returns the calling client's own device's requests; `panel-presentation-requested`
  is the live hint. Push payload kind `panel-present` (`PushPanelPresentDataPayload`).

Done and tested:
- H2 caller device facts (server stamping) — earlier agent; plus local console ids.
- H1 presentation: `panelRuntimeStore.ts`, `panelPresentation.ts`, `panelRuntime`
  methods `listPresentationTargets` / `requestPresentation` / `listPresentationRequests`,
  event `panel-presentation-requested`, push device stamping, authority golden,
  host authority catalog, runtime foundation ledgers (review recorded in
  `scripts/runtime-authority-review.json`).
- H3 `motion` capability (server side) — earlier agent.
- B1 config field, origin types, caller-to-origin mapping — earlier agent.
- B2 protocol, state ops, phrase matcher, TendrilDO — earlier agent.
- B3 runtime API (blocked only on H1 host methods, now present) — earlier agent.

More decisions taken while implementing:

- **Proof is keyed by build key** (`build_proof`), recorded from the coordinator's
  attempt lifecycle: `ready` proves a build finally; a never-proven build failing by
  its own code (`disprovesBuild`: user-code codes, `boot_stalled`, `render_crashed`)
  is marked failed and, if still current, the slot goes back to its newest proven
  entry (`src/server/panelHistoryProof.ts`). `panelRuntime.historyProof(slotId)`
  exposes it; the page kit reports failed entries to the agent once per build.
- **Wake bound lives in the native channel session** as a conversation doc
  (`vibestudio.observation-wakes`): an observation input that would start the
  conversation's (max+1)-th consecutive observation turn is admitted as a passive
  pointer instead; one arriving while a turn runs steers into it; a `user:` message
  resets the count and starts with a "N page observations … arrived without waking
  you" notice. The vessel sends `agent.observations-withheld` with the totals.
- **`tendril.event` wakes by default**: `DEFAULT_AGENT_OBSERVATIONS` applies when a
  subscription sets no `observations`. An agent has no runtime path to change its own
  subscription config, only the kit publishes this kind, and the wake bound caps it.
- **Kit entry points**: the root `@workspace/tendril` stays environment-neutral
  (TendrilDO imports it); pages import `@workspace/tendril/page`, agents
  `@workspace/tendril/agent`. Every kit function takes an optional runtime slice for
  tests and defaults to `@workspace/runtime`. There is no `ready` export: panel
  readiness is host-observed and panels have no manual-ready API.
- **Instructions from the control are user messages** with `metadata.tendril`; chat
  projects it as `ChatMessage.tendril` and shows "spoken/typed on page". Page events
  (`tendril.event`/`record`) are not rendered as chat rows: the pubsub client drops
  unknown payload kinds and the agent sees them as observations.
- **Device powers are an additive client capability, not an ABI bump.**
  `device-powers` (android, ios): `devicePowers.setKeepAwake/haptic/speak/stopSpeaking`
  in `@vibestudio/rn-client-api/devicePowersProtocol`. An older host never grants a
  capability it does not know, so no rn-host-7 is needed; pages fall back to web APIs.
  Native: Android `VibestudioMobileHostModule` (FLAG_KEEP_SCREEN_ON on the resumed
  activity, TextToSpeech), iOS `VibestudioMobileHost.mm` (idleTimerDisabled,
  AVSpeechSynthesizer), haptics through react-native-haptic-feedback. The mobile shell
  keeps the screen on only while a panel that asked is the one shown
  (`panelDevicePowers.ts`) and injects `__vibestudioShell.device`.
- **iOS sensors**: geolocation uses WebKit's own prompt (`NSLocationWhenInUseUsageDescription`
  added); motion goes through the public `requestDeviceOrientationAndMotionPermissionForOrigin`
  delegate into the same per-origin workspace approval as camera (`motion`).
- **Presentation on clients**: desktop `PanelOrchestrator.handlePresentationRequested`
  (takes over, focuses if asked) and `applyPendingPresentationRequests` at tree init;
  mobile `PresentationRequestInbox` + `MainScreen.presentRequestedPanel` (takeover via
  materialization), pending requests read after reconcile and on recovery; a tapped
  `panel-present` push opens the workspace and presents the slot
  (`NotificationOpen` kind `panel-present`).

Status after the single-track pass: H1, H2, H3 (JS, Android and iOS sources), H4, B1,
B2 (including `listen()` and the control's microphone), B3, B4, S1 implemented with
unit tests; V1 scenario `tendril-loop` defined with a tested validator; base, system,
system-testing and host type-check.

Not done or not verified:
1. iOS native code is written but not compiled here (no Xcode on this machine).
2. Running V1 (`tendril-loop`, needs a server, agent and model) and H5. The H5
   emulator smoke was attempted on a dedicated AVD `Tendrils_Test`; the emulator
   cannot start on this machine because the user has no KVM access
   (`sudo gpasswd -a $USER kvm`, then log in again). The Android host compiles
   (`./gradlew :app:compileDebugKotlin`).
3. Voice is local speech-to-text only: `listen()` uses the workspace speech
   extension (`transcribeRecording`, moved from the chat's dictation hook into
   `@workspace/speech/transcribe` so both share it) and needs voice input prepared
   once; the control's microphone routes spoken text through the phrase matcher like
   typed text. No realtime voice model is wired.
4. Proof state shows in the desktop shell's title bar: a warning next to Back and
   Forward when the newest history entry failed, saying whether the page went back
   to a working version (`historyProofNotice`). Mobile shows nothing yet. The unit
   test for it has not been run.
5. Whether the mobile `credentials.deviceId` equals the server's paired device id for
   that client (`deviceOfPrincipal`) is assumed from the code, to be confirmed by H5.
