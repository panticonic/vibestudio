# Quickfire Overlay — Command Palette + Panel-Scoped Agent Sessions

Status: draft for review
Date: 2026-08-14
Revised: 2026-08-14 — addressed review findings: content overlay goes
multi-instance (§2.3a) so approvals work while the overlay is up; contributed
commands get a declarative wire schema split from the chrome-local spec
(§3.1); promotion transfers channel ownership to the chat panel (§1.4, §2.4);
`panelContext.describe` split into server-resident facts + host-provider
presentation facts (§5.2).

This document specifies a single overlay surface for the desktop and mobile
apps that unifies three things:

1. **A real command palette** — a fully spec'd slate of UI/system actions with
   suggestions, inline autocomplete, and typed arguments.
2. **The launcher** — everything the `about/new` panel does today (open panels,
   history, URLs, "ask an agent"), abstracted into a shared engine consumed by
   both the panel and the overlay.
3. **Quickfire** — an instant agentic micro-session *bound to the panel the
   user is currently looking at*, with a panel-aware system prompt, pre-granted
   CDP/debug capability, per-panel conversation persistence (reopen over the
   same panel → same conversation; clearable), and a one-keystroke promotion
   path to a full chat panel.

Quickfire is deliberately positioned as the first shipping consumer of the
system-agent machinery (`docs/system-agent-design.md`, SA0/SA1): it is the
"panel-scoped micro-session" those drafts describe, realized under the
mission/reviewed-closure authority model that has landed since they were
written.

---

## 0. Current-state inventory (what we build on)

### 0.1 The `about/new` launcher (Base repo, `base/about/new/`)

- Single omnibox with mode prefixes (`>` panels, `@` history, `/` chat),
  ghost-text inline completion, grouped suggestions, "already open" awareness,
  warm-start caches.
- The suggestion engine is **pure and dependency-free**: `parseLauncherInput`,
  `buildLauncherSuggestions`, `buildIdleLauncherSuggestions`,
  `groupLauncherSuggestions`, `autocompleteForSuggestion`,
  `isLikelyAgentPrompt` in `about/new/launcherSuggestions.ts`;
  `browserUrlFromEntry` in `about/new/entryIntent.ts`;
  `collectLaunchablePanelGroups` in `about/new/launchablePanels.ts`.
- Its agent path creates nothing itself — it deep-links into `panels/chat`
  with `stateArgs.initialPrompt` via `buildPanelLink`
  (`packages/runtime/src/core/panelLinks.ts`), and the chat panel's
  `useDeferredAgent` queue does session creation.
- Known divergence: the shell address bar and mobile use the *other* omnibox
  pipeline (`buildAddressAutocompleteItems` in
  `packages/shared/src/panelChrome.ts`). The workspace currently has **two
  parallel ranking engines**; this plan consolidates on the launcher engine.

### 0.2 Shell overlay + palette infrastructure (host + Base repos)

- **Rich content overlay** (the primitive we build on): a transparent
  `WebContentsView` loading the shell bundle in `#overlaySurface=<key>` mode,
  floating above live panels. Surface gets serialized `props` in and emits
  opaque `intent`s out; **no RPC inside the surface**. Chrome-side owner holds
  all state and RPC. Files: `base/apps/shell/overlay/{types,registry,
  OverlaySurfaceHost,overlayBridge}.tsx`, `shell/useShellContentOverlay.ts`,
  host `src/main/shellContentOverlayView.ts`, wire contract
  `packages/service-schemas/src/view.ts` (`showContentOverlay` etc.).
  Today's only surface key is `"approval-card"`. **Caveat this plan fixes**:
  the main-process view is a singleton — one instance, one loaded surface,
  a global `hide()` with no surface argument (`show()` with a different key
  *replaces* the current surface). §2.3a extends it to per-surface instances
  so the approval card and quickfire can be visible at once.
- **`AppCommandPalette`** (`base/apps/shell/components/AppCommandPalette.tsx`)
  exists but is a DOM dialog + `useShellOverlay(true)`, which *hides every
  panel view* while open. It will be replaced by the new surface.
- **`HostCommandRegistry`** (`packages/shell-core/src/panelCommandRegistry.ts`)
  is the existing panel-contributed-command channel, already shared with
  mobile. It carries flat `{id, title}` items; this plan extends the schema
  with arguments and metadata.
- **Keyboard truth**: panel `WebContentsView`s swallow window keydowns, so the
  desktop entry point must be the Electron menu accelerator
  (`src/main/menu.ts`; currently `Cmd+K` / `Ctrl+Shift+K` →
  `open-command-palette`). The renderer keydown listener is only a fallback.
- **Focused panel**: desktop derives `focusedPanelId` from
  `layout.focusedPaneId`, mirrors it into main
  (`panel.getFocusedPanelId/setFocusedPanelId`); mobile has
  `activePanelIdAtom` / `activePanelMetadataAtom`.
- **Approval card precedent** (`ConsentApprovalBar.tsx`): anchor-div rect
  measurement (`APPROVAL_OVERLAY_HOST_ID` + ResizeObserver → overlay
  `bounds`), focus discipline via one-shot `focusRequest`, chrome fetches
  blobs on the surface's behalf. We copy all three patterns.

### 0.3 Agent sessions, CDP, authority (host repo)

- Native agent loop: Channel DO → agent vessel DO → Pi
  (`src/server/services/durableWorkDriver.ts`; userland harness in the Base
  repo). Transcripts are durable trajectory events replayed via
  `channel.history` + live subscribe; UIs reduce them with
  `@workspace/agentic-protocol`.
- **CDP is landed**: server-owned broker `src/server/cdpBridge.ts`;
  `panelCdp` service (`src/server/services/panelCdpService.ts`) with
  `getCdpEndpoint(panelId)` (full WS endpoint) plus **one-RPC helpers**
  `panelCdp.screenshot` and `panelCdp.consoleHistory`. Headless host
  (`apps/headless-host`) guarantees a CDP-capable lease holder.
- Gating: `panel.inspect` (primary capability) + `context.boundary`
  (`src/server/services/contextBoundary.ts`, resource key
  `context/<targetCtx>/requester/<subjectId>`), severity `critical` for
  privileged panels. Every CDP read records context ingestion (external
  lineage) into the context-integrity latch.
- Pre-grant mechanisms that exist today: install clearance grants (subject
  `code:<repoPath>@<effectiveVersion>`) and **reviewed closures / missions**
  (subject `mission:<name>@<closureDigest>`, explicit `grants[]` with tiers) —
  `packages/service-schemas/src/reviewedClosure.ts`,
  `packages/shared/src/authority/mission.ts`. Product bootstrap grants
  deliberately never pre-grant to installed code.
- System-agent docs (SA0/SA1) are **specs only** — no `SystemAgentWorker`
  exists; `workers/system-agent` is a reserved slot in
  `src/server/productConduitPolicy.ts`. SA1's changelog already re-points
  system-agent authority at mission subjects.

---

## 1. Product design

### 1.1 The one-liner

Press the palette key anywhere. A compact bar floats over your current panel.
Type to run a command, jump to a panel, open a URL — or just talk: the agent
you get already knows what panel you're looking at, can see its console and
screenshot it, and remembers your last conversation about *this* panel.

### 1.2 Modes and prefixes

One input, four scopes, same grammar as `about/new` but with commands added
and panels demoted from the `>` prefix (in an overlay, *actions* are the
primary citizens; in a new-tab page, *destinations* are):

| Prefix | Scope | Notes |
|---|---|---|
| *(none)* | Mixed: top commands, open panels, launchables, history, URL, quickfire | Default ranking; quickfire row surfaces when `isLikelyAgentPrompt` fires |
| `>` | Commands only | The full action slate (§3) |
| `@` | Open panels + history + launchable panels | "Go to" scope |
| `/` | Quickfire — talk to the panel-scoped agent | Also entered by the dedicated quickfire accelerator |

The mode set is **per-host-surface configuration** of the shared engine
(§2.2): `about/new` keeps its existing `>`-means-panels grammar unchanged in
phase 1 and migrates to the unified grammar in phase 2 behind a single
config change (this is a deliberate, user-visible grammar change; call it out
in release notes).

Mode chips under the input mirror `about/new`: clicking a chip inserts/removes
the prefix, preserving the query.

### 1.3 Keyboard map

Desktop (menu accelerators; the source of truth):

| Key | Action |
|---|---|
| `Cmd+K` / `Ctrl+K` | Open overlay in mixed mode (retire `Ctrl+Shift+K`; keep it as a hidden alias for one release) |
| `Cmd+Shift+K` / `Ctrl+Shift+K` | Open overlay directly in quickfire (`/`) mode with the transcript expanded |
| `Cmd+K` again while open | Cycle mode: mixed → `>` → `@` → `/` → mixed |
| `Esc` | Collapse quickfire transcript → close overlay → focus returns to the panel |
| `↑`/`↓` | Move selection (grouped display order) |
| `Tab` / `→` at end | Accept ghost completion |
| `Enter` | Run selected / advance argument / send quickfire message |
| `Shift+Enter` | Newline (quickfire compose) |
| `Cmd+Enter` | In quickfire: send and promote to full chat panel |
| `Backspace` on empty input | Pop argument step / drop mode prefix |

Mobile: palette = searchable command sheet (§7); quickfire = bottom sheet over
the active panel; entry via a persistent ✦ button in the `AppBar` and
long-press on the tab strip.

### 1.4 Quickfire session UX rules

- **Binding**: a conversation is keyed by the **panel slot**
  (`PanelSlotId`, the stable tree position), not the entity — navigation
  within a slot keeps the conversation; the agent is told about navigations.
- **Resume**: opening quickfire over a slot with an existing conversation
  shows the last exchange collapsed above the input with a `Resumed ·
  3 messages · 2h ago` chip. Typing continues it.
- **Clear**: an explicit ⟲ affordance (and `>quickfire: clear` command).
  Clearing archives the channel and detaches the mapping; the next open
  starts fresh. No TTL, no auto-expiry — lifecycle events only: a
  conversation dies when the user clears it or the slot is closed
  (slot close → archive after the close is committed, not on a timer).
- **Promotion**: `Cmd+Enter` or the "Open as chat panel" row hands the
  *same channel* to `panels/chat` (via `stateArgs.channelName`), created as a
  sibling of the target panel. The overlay conversation and the chat panel are
  the same durable transcript; promotion is a view change, not a copy.
  **Promotion transfers lifecycle ownership**: the quickfire mapping row is
  marked `promoted`, after which closing the original slot deletes the
  mapping *without* archiving the channel — the chat panel now owns the
  conversation's lifetime. Reopening quickfire over a promoted slot shows a
  "continued in chat panel →" row (focuses the panel) plus "start a new
  conversation here". Without this rule, closing the source slot would
  destroy a conversation still open as a chat panel.
- **Scope honesty**: quickfire is for *look, explain, poke, small fix*. The
  compose hint and the system prompt both say so; anything that grows beyond
  a few turns gets nudged toward promotion ("This is getting substantial —
  continue in a full chat panel?" as a passive row, never a modal).

---

## 2. Architecture

### 2.1 Component map

```
┌────────────────────────────────────────────────────────────────────┐
│ Base repo (userland)                                               │
│                                                                    │
│  packages/omnibox-core          ← NEW shared engine (§2.2)         │
│     ├─ input.ts     (parse, modes, intent)                         │
│     ├─ rank.ts      (scoring, grouping, completion)                │
│     ├─ commands.ts  (CommandSpec, ArgSpec, slate types)            │
│     └─ sources.ts   (SuggestionSource interface)                   │
│                                                                    │
│  about/new/                     ← consumes omnibox-core            │
│  apps/shell/                                                       │
│     overlay/QuickfireSurface.tsx        ← NEW surface (key         │
│     overlay/quickfireSurfaceModel.ts       "quickfire")            │
│     components/QuickfireOwner.tsx       ← NEW chrome-side owner    │
│     commands/slate.ts                   ← NEW built-in commands    │
│  apps/mobile/                                                      │
│     components/CommandSheet.tsx         ← NEW searchable sheet     │
│     components/QuickfireSheet.tsx       ← NEW                      │
└────────────────────────────────────────────────────────────────────┘
┌────────────────────────────────────────────────────────────────────┐
│ Host repo (/home/werg/vibestudio)                                  │
│                                                                    │
│  packages/shell-core/src/panelCommandRegistry.ts  ← extend schema  │
│  packages/service-schemas/src/quickfire.ts        ← NEW service    │
│  src/server/services/quickfireService.ts          ← NEW            │
│  src/server/services/panelContextService.ts       ← NEW (§5.2)     │
│  src/main/menu.ts                                 ← accelerators   │
│  workers/agent-worker:QuickfireAgentWorker ← command-agent class   │
└────────────────────────────────────────────────────────────────────┘
```

### 2.2 `@workspace/omnibox-core` — the shared engine

New Base package extracting and unifying the three existing engines
(`about/new/launcherSuggestions.ts`, `about/new/entryIntent.ts`, and the
`panelChrome.ts` address pipeline). All pure functions over injected data —
no `@workspace/runtime` imports, so it runs in the panel, the shell chrome,
the overlay surface, and React Native unchanged.

```ts
// Host surfaces configure the engine; data flows in, suggestions flow out.
export interface OmniboxConfig {
  modes: ModeSpec[];              // prefix → scope mapping, per surface
  sources: SuggestionSource[];    // injected data providers
  defaultGroups: GroupOrder;      // idle-state ordering
}

export interface SuggestionSource {
  kind: "command" | "panel" | "open-panel" | "history" | "url" | "quickfire";
  collect(input: ParsedInput, ctx: SurfaceContext): Suggestion[];
}

export interface SurfaceContext {
  focusedPanel?: PanelDescriptor;   // powers availability predicates & ranking
  openPanels: OpenPanelIndex;       // "already open" dedup, @-scope
  platform: "desktop" | "mobile" | "panel";
}
```

Moves verbatim (with their tests): the tiered scoring constants, usage
scoring, `isLikelyAgentPrompt`, `browserUrlFromEntry`,
`autocompleteForSuggestion`, group ordering. New in the package: the command
source (ranks `CommandSpec`s by title/alias/keywords, boosts
availability-matched commands), and the argument-session state machine (§3.3).

Consolidation obligations (tracked, not optional): `about/new` drops its
local copies; `TitleBar`/mobile address autocomplete migrate from
`buildAddressAutocompleteItems` to omnibox-core's URL+history sources in a
later phase (P6) so we end with **one** ranking engine.

### 2.3a Content overlay goes multi-instance

Required so the user can act on approvals while the overlay is up (and so an
approval *raised by the quickfire agent itself* is never hidden behind the
palette). `ShellContentOverlayView` is instantiated, not a module singleton,
and its IPC handlers already filter by sender id (`isOwnSender`), so this is
a contained extension:

- Main keeps a small **`ContentOverlayManager`**: `Map<surfaceKey,
  ShellContentOverlayView>`, creating instances lazily per surface key.
  Existing single-instance wiring moves behind it.
- Wire schema (`view.ts`): `updateContentOverlay` and `hideContentOverlay`
  gain a required `surface` key (mirroring `show`'s existing field);
  `showContentOverlay` routes to the per-surface instance instead of
  replacing the loaded surface. Chrome callers (`useShellContentOverlay`)
  already know their surface key — the hook signature doesn't change.
- **Z-order & placement**: quickfire sits above the approval card (it is
  focused, transient chrome; the card is ambient). They never contest space:
  quickfire is centered, top-anchored (§4); the approval card keeps its
  corner-snap behavior. `reconcileNativeLayerOrder` in `viewManager` gains
  the overlay pair as a fixed-order group above all panel views.
- **Focus arbitration**: quickfire holds keyboard focus while open. An
  approval whose kind takes focus today (`client-config`,
  `credential-input`, `device-code`) does *not* steal it while quickfire is
  open — the card renders with its attention treatment and takes focus when
  quickfire closes, or when the user clicks it (which dismisses the palette
  input focus but keeps the overlay visible). All other approval kinds
  already leave focus alone.
- Preload/IPC needs no change beyond instances registering their own
  sender-filtered handlers (already how the class works).

### 2.3 Desktop overlay surface

New `OverlaySurfaceKey: "quickfire"` following the approval-card pattern
exactly:

- **`QuickfireOwner.tsx`** (chrome document, mounted in `App.tsx` beside
  `ConsentApprovalBar`): owns all state and RPC. Listens for
  `open-command-palette` / `open-quickfire` shell events, resolves the focused
  panel (`panel.getFocusedPanelId()` → `panel.getChromeState(id)` →
  `panelContext.describe(id)` §5.2), runs omnibox-core, executes commands,
  drives the quickfire service, and pushes serialized props to the surface via
  `useShellContentOverlay`.
- **`QuickfireSurface.tsx`** (overlay document): pure view. Receives
  `{mode, query, groups, argSession, transcript, panelBadge, composeState,
  theme}` as props; emits intents `{type: "input", value}`,
  `{type: "activate", suggestionId}`, `{type: "send", text}`,
  `{type: "clear-confirm"}`, `{type: "promote"}`, `{type: "dismiss"}`, etc.
  Latency note: keystrokes round-trip surface → chrome → surface. The surface
  therefore owns the *text input state locally* (uncontrolled input, echoing
  to chrome on change) so typing never stutters; chrome only pushes
  suggestion/transcript/arg-session updates. This is the one deviation from
  the approval card's fully-controlled props model, and it's confined to the
  input element.
- **Anchoring**: a `QUICKFIRE_OVERLAY_HOST_ID` div rendered by `PanelApp`
  spanning the panel viewport; owner measures it (ResizeObserver) and centers
  the overlay horizontally, top-aligned at ~18% of viewport height. The
  overlay auto-fits height to content (existing content-overlay behavior);
  max height 62% of the anchor rect (transcript scrolls internally).
- **Focus**: unlike the approval card, the palette *always* takes keyboard
  focus on open (one-shot `focusRequest`). `Esc`/dismiss restores focus to
  the previously focused panel via `panel.focusPanel`.
- **Menu**: `src/main/menu.ts` gains `open-quickfire`
  (`CmdOrCtrl+Shift+K`) and rebinds `open-command-palette` to
  `CmdOrCtrl+K` on all platforms (both menu definitions).
- `AppCommandPalette.tsx` is deleted once the slate reaches parity (P2);
  its hard-coded items become slate commands.

### 2.4 Quickfire session backing

Reuses the native agent path end-to-end — no new agent kind, no new loop:

- **`quickfire` service** (host, `src/server/services/quickfireService.ts`,
  schema `packages/service-schemas/src/quickfire.ts`), principals
  `["user", "host"]`:

```ts
quickfire.sessionFor({ slotId })      // → { channelId, contextId, state:
                                      //     "fresh" | "resumed", messageCount,
                                      //     lastActivityAt } — creates lazily
quickfire.clear({ slotId })           // archive channel, detach mapping,
                                      // revoke session-scoped grants (§6)
quickfire.list()                      // slots with live conversations (for
                                      //   the "Quickfire conversations" view)
```

- **Persistence**: a `quickfire_sessions` table in the workspace-state DO
  (`WorkspaceDO`): `slot_id PK, channel_id, agent_entity_id, context_id,
  created_at, cleared_at NULL, promoted_at NULL`. Keyed by slot per §1.4.
  **Archival mechanism**: the DO never performs archival itself — slot close
  already only *records* durable cleanup work (`panel_close_cleanup`) that
  `PanelManager.drainCloseCleanup` executes host-side via
  `runtime.retireEntity`. Quickfire rides the identical pattern: `slotClose`
  additionally records quickfire cleanup rows for non-promoted mappings in
  the closed subtree, and the host-side drain calls the `quickfire` service
  to archive the channel and retire the agent entity, acknowledging rows on
  success. Promoted rows (`promoted_at` set) are deleted without channel
  archival (§1.4).
- **Agent**: `quickfire.sessionFor` creates (per conversation) a channel and
  an agent vessel entity exactly as the chat path does, but with the
  **`QuickfireAgentWorker`** class in the standard `workers/agent-worker`
  userland unit as harness (a thin configuration of the standard harness:
  quickfire system prompt §5.1, quickfire tool exposure §5.3, low default
  thinking). A distinct class selects those construction-time policies; the
  shared unit/version identity deliberately reuses the normal agent's reviewed
  model-credential grant. Entity is
  host-managed (`kind: "session"` semantics — callers cannot supply
  coordinates).
- **Streaming to the overlay**: `QuickfireOwner` (chrome) subscribes to the
  channel (`useChannelMessages` reduction, same as the chat panel), throttles
  to ~30 Hz, and pushes the reduced tail (last N=20 messages + live delta)
  into surface props. The full transcript is never shipped to the overlay —
  "Show earlier" promotes to the chat panel instead. This is chatty but
  local IPC; measure in P3 and, only if it visibly janks, add a dedicated
  `updateContentOverlay` patch op (partial props merge) to the view schema.
- **Promotion**: owner calls `panel.createChild(parentSlot,
  "panels/chat", { contextId: <quickfireContextId>, stateArgs: {
  channelName: <channelId> }, focus: true })` — the chat panel attaches to both
  the existing channel and its existing semantic context. The
  quickfire mapping stays; the overlay and the panel are two views of one
  conversation.

### 2.5 System-agent convergence

Quickfire deliberately implements slices of SA0/SA1 rather than a parallel
system:

| SA concept | Quickfire realization |
|---|---|
| Per-turn complete `ShellOverview` | Per-turn `PanelContextSnapshot` (§5.1) — same "re-describe, don't diff" principle, scoped to one panel |
| Micro-session under mission subject | Quickfire conversation under `mission:quickfire@<closureDigest>` (§6) |
| `workers/system-agent` reserved conduit slot | No additional conduit unit: the sibling `QuickfireAgentWorker` class uses the standard agent unit's identity and conduit policy |
| Log Watcher | Not built here; quickfire's console/log tools (§5.3) define the read surface the watcher will later share |

When the full system agent lands, quickfire becomes its panel-scoped
entry point (the SA channel is workspace-scoped; quickfire is slot-scoped)
— the harness unit, prompt assembly, and mission machinery are shared. This
plan does not build SA's workspace-wide channel, delegation store, or
watcher.

---

## 3. The command slate

### 3.1 Command spec schema (extends `HostCommandRegistry`)

```ts
export interface CommandSpec {
  id: string;                        // "panel.move", "view.theme" …
  title: string;                     // "Move Panel"
  aliases?: string[];                // "mv", "relocate"
  keywords?: string[];               // extra match terms, never displayed
  section: CommandSection;           // groups in the palette
  icon?: string;
  args?: ArgSpec[];                  // ordered; prompted in sequence
  availability?: (ctx: SurfaceContext) => boolean | "hidden";
  surfaces: ("desktop" | "mobile")[];
  danger?: boolean;                  // renders red, requires explicit Enter
  accelerator?: string;              // displayed hint only; menu.ts is truth
}

export interface ArgSpec {
  name: string;
  label: string;                     // placeholder while prompting
  type: "string" | "enum" | "panel" | "source" | "url" | "workspace" | "number";
  required: boolean;                 // optional args skippable with Enter
  suggest?: (query: string, ctx: SurfaceContext) => Suggestion[];
  validate?: (value: string) => string | null;   // error message or null
  options?: { value: string; label: string }[];  // for "enum"
}
```

`CommandSpec` as defined above is the **chrome-local** shape: the built-in
slate is defined in the shell chrome and its `availability`/`suggest`/
`validate` functions never cross a process boundary.

Panel-contributed commands are different: they arrive as **serialized event
payloads** (`HostCommandRegistry.accept` runtime-validates them), so
functions cannot round-trip. Today's wire shape is `HostCommand = {id,
label, description?, group?}` (`packages/shared/src/hostCommands.ts`).
Contributions therefore use a declarative subset:

```ts
export interface WireCommandSpec {
  id: string;
  label: string;                    // wire field stays `label`; the palette
  description?: string;             //   maps it to CommandSpec.title
  group?: string;                   // maps to a section under the panel name
  args?: WireArgSpec[];
  requiresFocus?: boolean;          // declarative availability only
  danger?: boolean;
}
export interface WireArgSpec {
  name: string;
  label: string;
  type: "string" | "enum" | "number" | "url";
  required: boolean;
  options?: { value: string; label: string }[];  // enum: inline, static
  pattern?: string;                              // regex validation
}
```

No dynamic `suggest` for contributed args in v1 — enum options are inline
and static; free-text args get `pattern` validation only. (If a real need
appears, the follow-up is a completion round-trip event to the contributing
panel, not functions on the wire.) Legacy `{id, label}` contributions are
accepted unchanged and wrapped as arg-less specs. Registry
`list(focusedPanelId)` keeps sorting the focused panel's contributions
first. Changes land in `packages/shared/src/hostCommands.ts` (additive
optional fields) + `packages/shell-core/src/panelCommandRegistry.ts`
validation.

### 3.2 Built-in slate (v1 — complete list)

Sections in display order. *Availability* column: `always` unless noted.
All commands run in `QuickfireOwner` (chrome) unless marked (main)/(server).

**Panel** — section "Panel"

| id | title | args | notes |
|---|---|---|---|
| `panel.new` | New Panel | `source: source` (optional) | No arg → opens `about/new` child (existing `Cmd+T` path); with arg → `createFromSource` |
| `panel.close` | Close Panel | — | Focused panel; `danger` when panel has children |
| `panel.focus` | Go to Panel | `panel: panel` | Suggest = open-panel index, same rows as `@` scope |
| `panel.move` | Move Panel | `direction: enum(left,right,up,down)` | Layout move of focused pane |
| `panel.pin` / `panel.unpin` | Pin / Unpin Panel | — | Availability from pin state |
| `panel.collapse` | Collapse Panel | — | |
| `panel.reload` | Reload Panel | — | Existing palette item, migrated |
| `panel.duplicate` | Duplicate Panel | — | New sibling slot, same source + stateArgs |
| `panel.copy-link` | Copy Panel Link | — | `buildPanelLink` for addressable sources; hidden otherwise |

**Navigate** — section "Navigate"

| id | title | args | notes |
|---|---|---|---|
| `nav.back` / `nav.forward` | Back / Forward | — | Availability from `canGoBack/Forward` |
| `nav.open-url` | Open URL | `url: url` | Validates with `browserUrlFromEntry`; opens browser child |
| `nav.history` | Search History | `query: string` | Jumps into `@` scope pre-filtered to history |
| `nav.address` | Edit Address | — | Closes overlay, focuses title-bar address (`toggle-address-bar`) |

**Quickfire** — section "Quickfire"

| id | title | args | notes |
|---|---|---|---|
| `quickfire.ask` | Ask About This Panel | `prompt: string` (optional) | Switches to `/` mode, prefilled |
| `quickfire.clear` | Clear Panel Conversation | — | `danger`; availability: conversation exists |
| `quickfire.promote` | Open Conversation as Chat Panel | — | Availability: conversation exists |
| `quickfire.list` | Quickfire Conversations | — | Opens picker of `quickfire.list()` rows; activate = focus slot + open overlay |
| `agent.new-chat` | New Chat | `prompt: string` (optional) | Existing `panels/chat` deep-link path from `about/new` |

**Debug** — section "Debug" (availability: focused panel is a code/browser
panel; all record context ingestion server-side)

| id | title | args | notes |
|---|---|---|---|
| `debug.devtools` | Open Panel DevTools | — | Existing item, migrated |
| `debug.screenshot` | Screenshot Panel | — | `panelCdp.screenshot` → downloads/clipboard toast |
| `debug.console` | Copy Console History | — | `panelCdp.consoleHistory` → clipboard |
| `debug.shell-devtools` | Open Shell DevTools | — | (main) |
| `debug.worker-inspector` | Inspect Worker… | `entity: string` | (server) `workerdInspectorService`; hidden unless dev features on |

**View** — section "Appearance & Layout"

| id | title | args |
|---|---|---|
| `view.theme` | Theme | `mode: enum(system,light,dark)` |
| `view.accent` | Accent Color | `accent: enum(…)` |
| `view.sidebar` | Toggle Sidebar | — |
| `view.zoom-in` / `view.zoom-out` / `view.zoom-reset` | Zoom | — |

**Workspace** — section "Workspace"

| id | title | args | notes |
|---|---|---|---|
| `workspace.switch` | Switch Workspace | `workspace: workspace` | Existing item, gains picker arg |
| `workspace.permissions` | Permissions & Agents | — | Opens `about/permissions` |
| `workspace.downloads` | Downloads | — | `about/downloads` |
| `workspace.about` | About This Workspace | — | `about/about` |

**Authority** — section "Approvals & Safety"

| id | title | args | notes |
|---|---|---|---|
| `authority.focus-approval` | Focus Pending Approval | — | Availability: pending exists; existing `Cmd+Shift+A` path |
| `authority.pause-agents` | Pause All Agents | — | `danger`; `permissions` service pause-all |
| `authority.lock` | Lock Workspace Authority | — | `danger`; `setWorkspaceAuthorityLock` |

**App** — section "Application"

| id | title | args |
|---|---|---|
| `app.shortcuts` | Keyboard Shortcuts | — |
| `app.reload-shell` | Reload App Shell | — |
| `app.check-updates` | Check for Updates | — |

Mobile surface flags: everything except `debug.shell-devtools`,
`debug.worker-inspector`, `view.zoom-*`, `nav.address`; `panel.move` remaps to
the drawer's reorder affordance.

### 3.3 Argument flow (the state machine)

Selecting a command with args does **not** execute — it enters an *argument
session* rendered as breadcrumb chips:

```
State: ArgSession { spec: CommandSpec, filled: Record<string,string>,
                    activeIndex: number, error: string | null }

Enter on suggestion/valid text → fill activeIndex, advance (or execute when
  all required filled)
Enter on empty + optional arg   → skip
Backspace on empty input        → pop last filled arg (or exit session)
Esc                             → exit session, restore typed query
```

Inline grammar is supported for power users: `>move right`,
`>theme dark`, `>open-url example.com` — the command source tokenizes
trailing words against arg suggesters and pre-fills matched args, so a full
inline utterance executes in one Enter. Ambiguous or invalid tails fall back
to the prompted session with the tail as the first arg's query.

Arg suggestion providers reuse omnibox suggestion sources (`panel` args get
the open-panel index with the same rows and icons as `@` scope; `enum` args
render option lists; `url` args validate through `browserUrlFromEntry`).

---

## 4. Desktop UI spec (prototype-level)

Visual language: overlay card matches the approval card family — `--z-dialog`
tier, 12px radius, elevated shadow, theme tokens from `OverlayThemeInfo`
(the content overlay already forwards theme). Width 640px (clamped to anchor
rect − 48px). Font: UI stack; rows 36px; group labels 11px caps.

### 4.1 Mixed mode (open on `Cmd+K`)

```
            ╭──────────────────────────────────────────────────╮
            │ ⌕  fix the layout jank in this ta_               │  ← input, ghost
            │    ⟨All⟩ ⟨> Commands⟩ ⟨@ Go to⟩ ⟨/ Quickfire⟩    │  ← mode chips
            ├──────────────────────────────────────────────────┤
            │ QUICKFIRE                                        │
            │ ✦ Ask about “Sales Dashboard” — fix the layout…  │  ← selected
            │     ↳ resumes conversation · 3 messages · 2h ago │
            │ COMMANDS                                         │
            │ ⟳ Reload Panel                                   │
            │ ⚙ Open Panel DevTools                            │
            │ GO TO                                            │
            │ ▤ Sales Dashboard › Q3 sheet         open · pane 2│
            ├──────────────────────────────────────────────────┤
            │ ▤ Sales Dashboard        ↑↓ select · ⏎ run · esc │  ← context strip
            ╰──────────────────────────────────────────────────╯
                       (live panel remains visible behind)
```

- **Context strip** (bottom): favicon/icon + title of the overlaid panel —
  the persistent answer to "which panel will this act on". Clicking it opens
  the panel picker (retargets the overlay to another open panel; quickfire
  binding follows the target, not raw focus, so you can quickfire a
  background panel deliberately).
- The quickfire row appears in mixed mode only when `isLikelyAgentPrompt`
  fires or the query matches no command/panel above threshold; it shows the
  resume state inline.
- Empty query idle state: top 6 commands (usage-ranked), then open panels,
  then "Recent pages" — same tiering discipline as `about/new`'s idle list.

### 4.2 Argument session (after `Enter` on "Move Panel")

```
            ╭──────────────────────────────────────────────────╮
            │ ⟨Move Panel⟩  direction: _                       │  ← chip + arg
            ├──────────────────────────────────────────────────┤
            │ → Right                                          │
            │ ← Left                                           │
            │ ↑ Up                                             │
            │ ↓ Down                                           │
            ├──────────────────────────────────────────────────┤
            │ ▤ Sales Dashboard      ⏎ choose · ⌫ back · esc   │
            ╰──────────────────────────────────────────────────╯
```

Validation errors render as a red inline line under the input; the session
never closes on error.

### 4.3 Quickfire (`/` mode or `Cmd+Shift+K`)

```
            ╭──────────────────────────────────────────────────╮
            │ ✦ Quickfire · Sales Dashboard         ⟲ clear  ⧉ │  ← header
            ├──────────────────────────────────────────────────┤
            │  Resumed · 3 messages · 2h ago        show all → │  ← resume chip
            │  ┌ you ────────────────────────────────────────┐ │
            │  │ why is the chart cut off on narrow widths?  │ │
            │  └─────────────────────────────────────────────┘ │
            │  ┌ agent ──────────────────────────────────────┐ │
            │  │ The container clamps at 720px — .chart-wrap │ │
            │  │ sets overflow:hidden and the flex basis…    │ │
            │  │ ▣ screenshot.png   ▤ console (2 errors)     │ │  ← tool chips
            │  └─────────────────────────────────────────────┘ │
            │                                                  │
            │ ⌕ and on mobile widths?_                         │  ← compose
            │    ⏎ send · ⇧⏎ newline · ⌘⏎ open as chat panel   │
            ╰──────────────────────────────────────────────────╯
```

- Header: ✦ + panel title; `⟲` clear (two-step: turns into `⟲ really clear?`
  for the next click — no modal); `⧉` promote to chat panel.
- Transcript: last 20 messages, internal scroll, streaming delta renders
  live. Tool invocations render as compact chips (screenshot thumbnails
  inline at 120px, click → opens image in a viewer panel). "show all →"
  promotes.
- While the agent is working, the compose row shows a stop button and the
  streaming status line ("running panel console tool…").
- Approvals raised by the quickfire agent flow through the **existing
  approval card**, rendered in its own overlay instance and visible
  *simultaneously* with quickfire (§2.3a) — the user can resolve an
  approval without dismissing the conversation. The quickfire surface never
  renders approval UI; focus arbitration per §2.3a.
- Clearing while the agent is mid-turn stops the turn first (existing
  channel stop path), then archives.

### 4.4 States & transitions

| State | Trigger | Render |
|---|---|---|
| `closed` | — | nothing |
| `palette(mode, query, argSession?)` | accelerator / chip / prefix | §4.1–4.2 |
| `quickfire(idle)` | `/` or accelerator, no conversation | header + empty transcript + compose, hint text: "Ask about this panel. I can see its console and take screenshots." |
| `quickfire(resumed)` | conversation exists | §4.3 |
| `quickfire(streaming)` | send | live delta + stop |
| `panel-lost` | focused slot closed while open | context strip → "panel closed"; quickfire compose disabled; palette still works |

Overlay closes on: `Esc` chain, activating a navigation suggestion, executing
a command that moves focus (e.g. `panel.focus`), clicking outside (the
content overlay's existing outside-dismiss). It does *not* close on
executing non-navigating commands (`view.theme` etc.) — it shows a 900ms
success flash on the row instead, staying open for chained commands.

---

## 5. The panel-aware agent

### 5.1 System prompt & per-turn context

The `QuickfireAgentWorker` class in `workers/agent-worker` composes the standard base prompt plus
a quickfire preamble (identity: "you are the quick inspector attached to one
panel; bias to observation and small fixes; suggest promotion for large
work") and — following the SA0 "complete overview per turn, no diffs"
principle — prepends a fresh **`PanelContextSnapshot`** to every user turn
via `buildTurnInput`:

```
<panel-context>
slot: panel:tree/…            title: "Sales Dashboard"
source: panels/sales-dash     repo: workspace/panels/sales-dash@<ev>
kind: panel                   context: ctx-…
url/address: …                lease: ready · surface code · headless-…
navigation: entity changed 2 turns ago (was panels/sales-dash@<older-ev>)
console: 2 errors, 1 warning in last 5m (tail available via tool)
open siblings: Q3 sheet, Import wizard
</panel-context>
```

Navigation within the slot is surfaced as a line item, keeping conversations
valid across entity changes (§1.4).

### 5.2 New host API: `panelContext.describe`

One aggregate RPC (`src/server/services/panelContextService.ts`, schema
`packages/service-schemas/src/panelContext.ts`) for the agent's snapshot
builder — with an explicit ownership split, because not all the facts live
server-side. `getChromeState` is an Electron-main service reading the
main-process panel registry (`src/main/services/panelShellService.ts`);
favicon, display/editable address, and back/forward state are
presentation-local and a plain server service cannot read them.

```ts
panelContext.describe({ panelId })  // → PanelContextSnapshot, two halves:
// SERVER-RESIDENT (always present): tree detail (slot, parent, siblings,
//   stateArgs, title from workspace-state) + source identity (source,
//   repoPath, effectiveVersion, executionDigest, contextId) +
//   presentation/lease (ready/loading/unavailable, surface,
//   hostConnectionId, supportsCdp) + console summary counts (not bodies)
// PRESENTATION (best-effort): kind, display/editable address, favicon,
//   canGoBack/Forward — fetched by the server from the panel's ACTIVE
//   LEASE HOLDER over the existing host-provider connection (the same
//   channel the CDP broker uses; the headless host answers via CDP when
//   no shell holds the lease), merged server-side. Absent when no
//   CDP-capable holder responds; the snapshot says so rather than lying.
```

The **chrome owner does not use this RPC for its own UI** — it already has
main-process access (`panel.getChromeState`) and composes locally. The RPC
exists for the agent path, where the caller is server-side.

Principals `["user", "host", "code", "agent"]`; for non-user callers the
target-context `context.boundary` rule applies exactly as in `panelCdp` —
same-context free, foreign gated. Console *bodies* stay behind the tool
surface (§5.3) so reading them records ingestion; `describe` returns counts
only and records nothing.

### 5.3 Quickfire tool surface

Exposed via the harness's `getLoopTools()`, all thin wrappers over existing
services — no new capability kinds:

| Tool | Backing | Notes |
|---|---|---|
| `panel_screenshot` | `panelCdp.screenshot` | Force-paints hidden views; returns image blob ref |
| `panel_console` | `panelCdp.consoleHistory` | Records `log:panel:<id>` ingestion |
| `panel_eval` | **NEW** `panelCdp.evaluate(panelId, expr)` one-RPC helper (add beside screenshot/consoleHistory in `panelCdpService`) | `Runtime.evaluate` w/ 8s bound, result serialized; avoids handing the model a raw WS endpoint for the 90% case |
| `panel_cdp_endpoint` | `panelCdp.getCdpEndpoint` | The full firehose, for genuinely interactive debugging |
| `panel_describe` | `panelContext.describe` | Refresh mid-turn |
| `read_source` / `edit_source` | existing workspace source RPCs, scoped to the panel's unit path | Small-fix loop; edits flow through normal review/approval machinery |
| `say` / `complete` | standard channel tools | |

`panel_eval` is the one genuinely new server surface besides
`panelContext.describe` and the `quickfire` service; it also closes a gap for
the linked-Claude frontend-dev loop.

---

## 6. Authority: pre-granted CDP done right

Requirement: quickfire must reach `panel_screenshot`/`panel_console`/
`panel_eval` on its bound panel **without an approval prompt**, while staying
inside the canonical grant store (no bypass flags) and the no-clock-authority
principle.

Design — a reviewed closure + per-conversation grants:

1. **Reviewed closure `quickfire`** (source document: this spec) with
   `subjectPrefix: mission:quickfire`, `harness: {unit:
   "workers/agent-worker", ev: <blessed>}`, exposure = the §5.3 tool
   list, and `grants[]` = **`panel.inspect` only** (tier `gated`, resource
   exact). The `context.boundary` grant is deliberately *not* a standing
   closure grant: `<boundCtx>` is a runtime value a static document cannot
   name, and the only static scope available (`context/`) would hand every
   conversation the boundary for every context in the workspace — exactly
   what binding-time minting (point 2) exists to prevent. The boundary
   grant is minted per binding at prefix `context/<boundCtx>/requester/`
   (prefix scope because the requester entity id is re-minted per
   conversation; the *target* context is the interesting half), on the same
   subject. The quickfire agent runs under subject
   `mission:quickfire@<closureDigest>` — per SA1's own changelog, the
   harness code principal holds no standing grants. (Implementation note:
   `quickfire-bind` is a sibling constant of `CLEARANCE_DECISION_SURFACE`,
   not a new key — that map is typed by `UnitAdmissionOrigin` and describes
   install decisions.)
2. **Binding-time minting**: the target context id is a runtime value, so
   closure grants can't name it statically. Instead, `quickfire.sessionFor`
   (running as host, on an explicit user gesture — opening the overlay over
   that panel *is* the consent act) mints the concrete grant pair
   (`panel.inspect` + `context.boundary` at
   `context/<targetCtx>/requester/` prefix) with subject
   `mission:quickfire@<digest>`, `scope: "session"`, `decision_surface:
   "quickfire-bind"` (new value in `CLEARANCE_DECISION_SURFACE`'s enum
   family), `provenance` pointing at the user's open action, and — because
   we don't do clock-bound authority — revocation tied to **lifecycle
   events only**: `quickfire.clear`, slot close, or panel navigation to a
   *different context* (context change re-mints for the new context after
   the overlay is next opened, which is the fresh user gesture).
3. **Severity gate**: if the bound panel's target is `privileged`
   (`panelAccessSeverityForTarget` → `critical`), binding-time minting is
   **not** silent — the standard approval card appears once
   ("Quickfire wants debug access to Permissions panel"), and the resulting
   grant persists for the conversation. Ordinary panels: zero prompts.
4. **Visibility & revocation**: minted grants appear in
   `permissions.list` like any other (`origin: quickfire`, revoke works and
   immediately kills the tools); `authority.pause-agents` and the workspace
   lock apply. Context-integrity: every CDP read still records external
   ingestion, so a quickfire conversation that has looked at page content
   carries the latch like any agent session — no exemption.
5. **Conduit**: use the existing `workers/agent-worker` conduit identity and
   exact-EV resolution. The distinct durable-object class selects quickfire
   behavior without creating a second code-version identity.

What we explicitly do **not** do: no standing `code:` grant on the harness
unit (product bootstrap policy forbids it and it would grant every
conversation everything), no TTL'd grants, no bypass of the ingestion latch.

---

## 7. Mobile spec

Parity rule honored (`apps/shell/SKILL.md`): both halves ship, adapted.

### 7.1 Command sheet (replaces "no searchable palette" gap)

New `CommandSheet.tsx` — an upgraded `ActionSheetHost` variant: bottom sheet
with a search field pinned at top, omnibox-core underneath (sources:
commands incl. `presentMobileHostCommands` contributions, open panels from
`panelForest`, history via `browserData`). Rows 48px, sections as sticky
headers, keyboard-avoiding. Arg sessions render as a chip row under the
search field, same state machine as desktop. Entry: ✦ button in `AppBar`;
long-press active tab → sheet pre-scoped to `@`.

```
   ┌─────────────────────────────┐
   │        ── drag handle ──    │
   │ ⌕ move_                     │
   │ ⟨All⟩⟨Commands⟩⟨Go to⟩⟨✦⟩   │
   │ COMMANDS                    │
   │ ⇄ Move Panel            ›   │
   │ GO TO                       │
   │ ▤ Import wizard             │
   └─────────────────────────────┘
```

### 7.2 Quickfire sheet

`QuickfireSheet.tsx`: full-height bottom sheet over the active panel
(`activePanelIdAtom` provides the binding), same header/transcript/compose
structure as §4.3 rendered natively (reuses the `ApprovalSheet` sheet shell
and the same `useChannelMessages` reduction the mobile chat surface uses —
mobile talks RPC directly, so no props-bridge constraint exists here).
Promote opens the chat panel in the detail pane. Swipe-down = dismiss
(conversation persists); clear is the same two-step header affordance.

---

## 8. Phasing

Each phase lands independently shippable; P1–P3 are the core deliverable.

- **P1 — Extraction.** Create `@workspace/omnibox-core`; port
  `about/new` onto it with zero behavior change (its tests move and must
  pass unmodified). Extend `HostCommandRegistry` schema (args, sections,
  availability) with legacy wrapping. Exit: `about/new` green on the shared
  engine; registry round-trips new schema on desktop + mobile.
- **P2 — Palette overlay.** **Multi-instance content overlay first**
  (§2.3a: `ContentOverlayManager`, surface-keyed `update`/`hide` in the view
  schema, z-order group, focus arbitration) — the approval card moves onto
  it with zero behavior change before quickfire lands on it. Then the
  `"quickfire"` surface key + `QuickfireOwner` + `QuickfireSurface` (palette
  modes only, no agent). Built-in slate §3.2, arg sessions, inline grammar,
  `WireCommandSpec` for contributed commands. Menu rebind (`Cmd/Ctrl+K`),
  delete `AppCommandPalette`. Exit: every §3.2 desktop command executes from
  the overlay over a live visible panel; approval card and palette visible
  and operable simultaneously (e2e: resolve an approval while the palette
  stays open); open→arg→execute and focus restore covered.
- **P3 — Quickfire sessions.** `quickfire` service + `quickfire_sessions`
  table + `QuickfireAgentWorker` sibling class in the standard agent unit +
  `panelContext.describe`.
  Overlay `/` mode with transcript, resume, clear, promote (with
  ownership transfer: `promoted_at`, cleanup-queue archival per §2.4).
  Tools limited to `panel_describe` + `say` (no CDP yet — conversations
  work, prompts appear for anything gated). Exit: resume-over-same-slot,
  clear, promote-then-close-slot (channel survives, chat panel still
  live), and slot-close archival of non-promoted conversations all
  e2e-tested.
- **P4 — Debug authority.** `panel_eval` RPC; reviewed closure +
  binding-time mission grants + `quickfire-bind` decision surface +
  conduit entry; severity gate for privileged panels; full §5.3 tool set.
  Exit: screenshot/console/eval prompt-free on an ordinary panel, prompted
  once on a privileged one; revoke-from-permissions kills tools live;
  adversarial tests for grant scoping (wrong context, re-minted requester,
  cleared conversation).
- **P5 — Mobile.** `CommandSheet` + `QuickfireSheet`.
- **P6 — Consolidation.** Migrate `TitleBar` + mobile address autocomplete
  onto omnibox-core sources; migrate `about/new` to the unified prefix
  grammar; retire `buildAddressAutocompleteItems` and the
  `launchablePanels.ts`/`collectPanelSourceSuggestions` duplication.

## 9. Open questions

1. **`Ctrl+K` on Linux/Windows** collides with nothing in our menus today,
   but some browser panels use it in-page; since the accelerator is
   app-global it wins — acceptable, or keep `Ctrl+Shift+K` primary off-mac?
2. **Retargeting** (context-strip panel picker, §4.1) could ship in P2 or
   be deferred; it's the only piece that decouples quickfire binding from
   focus.
3. **Overlay props-patch op** (§2.4) — only if streaming jank shows up in
   P3 measurement; decide then, not now.
4. Does `quickfire.list` warrant an `about/quickfire` page (conversation
   management UI) in addition to the palette picker? Cheap once the
   service exists; proposed as a P5 stretch.
