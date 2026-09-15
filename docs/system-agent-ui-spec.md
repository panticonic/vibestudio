# System Agent UI — Desktop (SA0) and Mobile (SA4) Surfaces

Status: draft for review
Depends on: `system-agent-design.md` (§3, §5–§7),
`system-agent-sa0-plan.md` (§1–§9), `system-agent-tools-cards-spec.md`
(card payload schemas), `log-watcher-spec.md` (inbox and push semantics),
`multi-user-wp0-user-identity-spec.md`,
`multi-user-wp5-approval-provenance.md`, `ios-integration-plan.md`

This document specifies the concrete UI for the System Agent across both
clients: the SA0 desktop surface (ambient strip + overlay drawer in
`workspace/apps/shell`) and the SA4 mobile surface (System screen in
`workspace/apps/mobile`), plus the SA1 approval-delegation affordances that
live in the same components.

## 1. Desktop ambient strip — `SystemAgentStrip.tsx`

New file `workspace/apps/shell/components/SystemAgentStrip.tsx`.

### 1.1 Data source

One subscription to the shared typed `shell.status` service used by chrome and the
`ShellOverview` assembler. It composes host-owned runtime, presence, diagnostics, approval,
update, and watcher counters; no model output appears in the strip. The same service is
reachable from System Agent eval:

```ts
interface SystemAgentShellStatus {   // `shell.status` result data
  workersRunning: number;      // worker registry: entities in running state
  workersTotal: number;        // worker registry: all worker entities
  errorCountLastHour: number;  // runtimeDiagnosticsStore: error-level records in the last hour
  pendingApprovals: number;    // shellApprovalService pending queue for this user
  activeStorms: number;        // watcher storm_state rows currently storming (0 until SA2 populates it)
  unreadIncidents: number;     // watcher inbox cards not yet dismissed (0 until SA2)
  onlineUsers: number;         // WP8 workspace presence
  liveEntities: number;        // complete active entity registry, all kinds
  updatedAt: number;           // host-side composition timestamp
}
```

The service pushes updates over the existing shell event stream (same pattern
as `SHELL_APPROVAL_PENDING_CHANGED_CHANNEL` in `ConsentApprovalBar.tsx`); the
strip renders the latest snapshot, no client-side stitching.

### 1.2 Contents and visual states

A single horizontal row of four stat chips plus the agent affordance, in this
order: **workers running** (count + gear icon), **errors** (count, last hour),
**approvals** (pending count), **storms** (count). A fifth element is the
System Agent entry button (spark icon, label "System").

Three visual states, computed mechanically from the snapshot:

- **All-quiet** — `errorCountLastHour == 0 && pendingApprovals == 0 && activeStorms == 0`.
  Chips render in the gray scale (`--gray-a11` text); zero-valued chips
  collapse to icon-only. The strip is visually recessive.
- **Attention** — `errorCountLastHour > 0 || pendingApprovals > 0 ||
  unreadIncidents > 0`. The affected chips take the amber accent
  (`approvalAccent`-consistent tones from `approvalCardModel.ts`); non-zero
  counts render as `Badge` elements (Radix `Badge`, `color="amber"`).
- **Storm** — `activeStorms > 0`. The storms chip takes the red accent and a
  slow 2 s opacity pulse; the strip border-top picks up `--red-a6`. Storm
  state supersedes attention state for the strip-level treatment.

Badge semantics: badges show exact counts up to 99, then `99+`. The
`unreadIncidents` count renders as a badge on the System entry button (not a
separate chip) — this is the "inbox badge on the strip" from design §7.1.

### 1.3 Click targets

Every stat is a deep link; none is decorative:

| Target | Action |
| --- | --- |
| Workers chip | Opens the drawer on the overview's runtime-entities section; the agent already has the same current entity inventory, so no discovery prompt is synthesized |
| Errors chip | Opens the drawer with the inbox section expanded, filtered to error-severity cards |
| Approvals chip | Does **not** open the drawer — it expands the existing approval surface: emits the same expansion path `ConsentApprovalBar.tsx` uses for its minimized pill (the content-overlay approval card) |
| Storms chip | Opens the drawer with the inbox expanded and scrolled to the first storm card |
| System button | Toggles the drawer, preserving whatever inbox/transcript scroll state it had |

### 1.4 Mount point

The strip mounts in `workspace/apps/shell/components/PanelStack.tsx`, inside
the sidebar `Card` (`data-shell-panel-sidebar`) that wraps
`LazyPanelTreeSidebar` (currently `PanelStack.tsx:1317`), as the **last child**
of the sidebar's inner `Flex direction="column"` — i.e. pinned to the bottom of
the side pane, below the tree, with `marginTop: "auto"` and a hairline
border-top. It is rendered whenever `isTreeNavigation` is true (desktop and
mobile-tree mode alike; on mobile widths it renders in the slide-in tree pane).
The strip is always visible when the side pane is — it has no collapsed/hidden
mode of its own.

## 2. Overlay drawer — `SystemAgentDrawer.tsx`

New files: `workspace/apps/shell/overlay/SystemAgentDrawerSurface.tsx`
(presentational surface) and
`workspace/apps/shell/components/SystemAgentDrawer.tsx` (chrome-side
coordinator). The split mirrors `ConsentApprovalBar` (coordinator, owns RPC) /
`ApprovalCard` (pure surface) exactly, because overlay surfaces are separate
no-RPC documents.

### 2.1 Registration

The surface registers in the existing overlay registry,
`workspace/apps/shell/overlay/registry.tsx`: add key `"system-agent-drawer"`
to `OverlaySurfaceKey` in `overlay/types.ts` and the component to
`OVERLAY_SURFACES`. The coordinator drives it via `useShellContentOverlay`
with a full-height anchor region along the panel area's sidebar edge.

Because overlay surfaces receive serialized `props` and emit opaque `intent`s
(no RPC in the surface document), the coordinator owns the channel client: it
calls the lifecycle-only `systemAgent.resolveConversation`, binds the returned channel with the
existing chat core (`useChatCore` from `@workspace/agentic-chat`), and pushes
transcript state down as surface props; composer submissions and card actions
come back up as intents. The coordinator turns composer text into channel
publishes. Semantic card actions do **not** become user turns or model round-trips: the
coordinator calls the same typed owning service method as ordinary shell chrome, under the
verified user/device identity. Existing service authorization, approvals, subscriptions, and
audit apply. The coordinator has no bespoke panel/worker action path and no private mini-shell API;
`resolveConversation` is its only system-agent-specific lifecycle call. This is the
same intent pattern the approval card already uses for diff-blob fetches
(`fetch-blob` intent → prop update).

### 2.2 Geometry

- Width: `min(720px, 60vw)`. Full height of the panel area (the region below
  the title bar, right of the side pane).
- Slides in from the side-pane edge (left edge of the panel area), **over**
  the panel content — panels are not resized or reflowed. 180 ms ease-out
  translate; a `--black-a6` scrim covers the remaining panel area.
- The strip (§1) remains visible and interactive while the drawer is open.

### 2.3 Open and close

Open triggers:

1. Strip clicks per §1.3.
2. Keyboard shortcut **`CmdOrCtrl+Shift+S`**, wired the same dual way as the
   command palette (`AppCommandPalette.tsx`): an Electron menu accelerator
   emitting `open-system-agent`, with a window `keydown` fallback for the
   standalone browser shell. Deep-link variants of the trigger (from §1.3, from
   notification clicks, from a `DebugSessionLinkCard` back-reference) carry a
   `{ focus: "inbox" | "transcript" | { cardId } }` payload the coordinator
   applies after mount.
3. The "Investigate with System Agent" inbox action (design §6.4) opens the
   drawer with the transcript focused and the forwarded incident card visible
   as the newest user turn.

Close: Esc, click on the scrim, and an explicit close button in the drawer
header. Closing hides the overlay only — the channel subscription is retained
by the coordinator for the shell session, the conversation persists (it is a
durable `PubSubChannel`), and reopening restores scroll position and any
composer draft (draft kept in coordinator state).

### 2.4 Internal layout (top to bottom)

1. **Header** — "System" title, the four §1.2 stats in miniature, presence indicator,
   close button.
2. **Notification inbox section** — collapsible (chevron; collapsed state
   persisted per device in shell local settings). Renders `IncidentCard` and
   `StormCard` items from the hub-owned inbox, newest first, with the
   dismiss / mute / investigate actions of §3. Collapsed, it shows a one-line
   summary ("3 incidents, 1 storm"). This section exists from SA0 with an
   empty state ("No incidents") and populates when SA2 ships the watcher.
3. **Transcript** — the existing channel transcript components from
   `@workspace/agentic-chat`, bound to the `resolveConversation` channel:
   `ChatMessageArea` hosting `MessageList` → `MessageCard` → `MessageContent`
   (with `ThinkingMessage` / `TypingMessage` / `ActionMessage` as in any chat).
   The drawer does **not** use the full `AgenticChat` assembly — it omits
   `ChatHeader`, `ForkSwitcher`, `AgentLauncher`, and model/agent pickers
   (model is host-controlled per design §3.8; there is exactly one agent and
   one conversation per (workspace, user), shared across the user's devices
   with device attribution stamped on turns and actions).
4. **Composer** — `ChatInput` from `@workspace/agentic-chat`, single-line growing.
   The coordinator stamps verified device focus (focused panel/card) on submission;
   this is host-observed state for the next overview, not message
   text. No attachment or mention affordances in SA0.

### 2.5 Card rendering

Eval or verified chrome may publish a `SystemAgentCard` structured channel message using the
schemas in `system-agent-tools-cards-spec.md` §5. The renderer keys on `card.kind`. Cards render through a **bundled card
renderer registry**:
`workspace/apps/shell/components/systemAgentCards/registry.tsx`, a static
`Record<SystemAgentCard["kind"], ComponentType<{card, emit}>>` keyed by the
card's `kind` discriminant (the discriminant of the tools/cards spec §5
union). This registry is deliberately **not** `useMessageTypeRegistry` — that
hook compiles userland-supplied renderer source, and no userland renderer code may
execute in a System Agent surface (design §4).

`MessageList` does not accept that `Record` directly: its
`messageTypeComponents` prop (`MessageList.tsx:232`) is a
`Map<string, MessageTypeComponentEntry>`, where `MessageTypeComponentEntry`
(= `MessageTypeRegistryEntry`, `packages/agentic-chat/types.ts`) is a status
union — `{ status: "ready", definition, module, cacheKey }` |
`{ status: "loading", … }` | `{ status: "error", … }` — whose `module` is a
`MessageTypeModule` (`agentic-core/src/custom-message-types.ts`): an object
with an optional `default: ComponentType<CustomMessageComponentProps>`. The
registry module therefore exports an adapter that maps the static `Record`
into that shape once at module load: for each card kind, a
`Map` entry `status: "ready"` with a synthetic in-bundle `definition`, a
constant `cacheKey` (e.g. `"system-agent-cards@<build>"`), and a
`MessageTypeModule` whose `default` component unwraps
`CustomMessageComponentProps.state` as the card payload and delegates to the
`Record`'s component. No `"loading"` or `"error"` entries ever occur — the
components are statically bundled; no compile step runs. The adapted Map is
passed to `MessageList` as `messageTypeComponents`, so transcript machinery is
reused unchanged while renderer code ships in the product bundle. Unknown card
kinds render a fallback card showing the kind name and a "this client is older
than the host" notice — never raw payload text.

## 3. Card component inventory

All components live in
`workspace/apps/shell/components/systemAgentCards/` (desktop) with
`workspace/apps/mobile/src/components/systemAgentCards/` React Native
counterparts of the same names. Untrusted fields (userland- or
model-originated strings) always render as **inert text** — plain text nodes,
never markdown, HTML, or link targets.

| Card schema | Component | Primary actions | Untrusted fields rendered inert |
| --- | --- | --- | --- |
| `ShellOverviewCard` | `ShellOverviewCardView` | Expand complete panel/entity/people/channel/unit sections; refresh; open referenced objects. The card is a compact rendering of the full overview in result `data`, not a truncated second source | All display labels/handles |
| `PanelSubtreeCard` | `PanelSubtreeCardView` | Every shared panel service action applicable to the row: focus, create child, move, pin/collapse, load/unload, reload/rebuild, archive/close, takeover, devtools, debug | Panel titles, source paths |
| `EntityStatusCard` | `EntityStatusCardView` | Inspect context/source/diagnostics; applicable launch/restart/stop/retire/debug actions for every entity kind | Entity titles and source paths |
| `WorkspacePresenceCard` | `WorkspacePresenceCardView` | Resolve profile; open the owner's panel band; no conflation with channel presence | Handles/display names/colors |
| `ChannelSessionCard` | `ChannelSessionCardView` | Open channel/session, add/remove member, inspect durable members and live participants, debug bound agent | Channel titles and participant/member handles/status copy |
| `UnitStatusCard` | `UnitStatusCardView` | Versions, diagnostics/log refs, restart, rollback, open running entity | Unit names/source paths |
| `LogExcerptCard` | `LogExcerptCardView` | Renders a compact excerpt (≤20 records × ≤500 chars) inline; open/query by ref; **Share with agent** posts a byte-capped `LogShareCard` | Excerpts/fetched log lines |
| `LogShareCard` | `LogShareCardView` | None (record of a user's share); rendered as the sharing user's turn with attribution ("shared by <user>") | `lines[]` (raw log text, monospace, inert) |
| `DebugSessionLinkCard` | `DebugSessionLinkCardView` | Open session (desktop: opens/focuses the chat panel for that channel; mobile: deep-links into the ordinary session view) | `title` (model prose) |
| `IncidentCard` | `IncidentCardView` | In inbox: dismiss (shared, attributed), mute signature (shared, attributed), investigate (explicit forward → user turn); in transcript (post-forward): open logs (via `LogExcerptCard` fetch path), star signature | `template` (signature template), `summary` (model text) |
| `StormCard` | `StormCardView` | Dismiss, mute dominant signature, investigate; live-updating counts while storming | `dominantTemplate`, `sigMix[].template`, `summary` (model text) |
| `DelegationDraftCard` | `DelegationDraftCardView` | Choose/review scope; adjust TTL / budget / `maxSeverity`; **Confirm** (host-recorded human action, §4.2); discard | Plain-language description and guidance (model prose); matcher values are host-verified and render as structured fields, not free text |

**Action routing rule.** Every button calls the same typed owning service method used by the
corresponding shell UI behavior. The overlay surface emits an opaque intent; the trusted
coordinator validates its strict service arguments and calls the method as the verified user/
device. No model turn runs. Existing authorization/approval behavior remains authoritative.

System Agent eval reaches every method classified as an eval-reachable semantic service through
its verified `EvalDO → blessed owner → acting user/device` lineage. Human approval consent,
delegated-authority expansion, and independent trust-root administration use the same owning
services but reject conversation EvalDO callers. There is no generated action wrapper, receipt,
model confirmation chip, or alternate card RPC. Device methods remain bound to the originating
device and fail visibly if it disconnects.

Any structured turns that remain in the transcript (none are produced by card
mutations) render as compact one-line chips, never as user bubbles.
Reads and mutations—including focus, dismiss, mute, star, and panel-command invocation—use their
ordinary service contracts and approval policy.

## 4. Approval delegate action (SA1)

### 4.1 Placement

`workspace/apps/shell/components/ApprovalCard.tsx` gains a tertiary action
**"Delegate similar to agent…"** rendered in the card footer after
Approve/Deny, for delegable kinds only (`userland`, `unit-install-review`, `capability`,
`credential` under the severity gate — design §5.4; the action is absent, not
disabled, for never-delegable kinds). `approvalCardModel.ts`'s
`ApprovalCardIntentBody` gains `{ type: "delegate" }`. The coordinator
(`ConsentApprovalBar.tsx`) handles the intent by calling the host with the
approval id; the host invokes the user's System Agent (the per-(workspace,
user) conversation, the triggering device stamped as attribution), which uses eval to call
`delegations.propose` (design §5.1). The mobile `ApprovalSheet.tsx` gains
the same action with the same gating.

### 4.2 Confirmation flow — `DelegationDraftCard`

The draft policy returns as a `DelegationDraftCard` rendered in the System
Agent drawer (desktop) or System screen (mobile), which opens automatically
focused on the card:

- **Scope first, matcher underneath**: kind and issuer are fixed/host-verified. The primary
  control is a host-generated scope selector—exact subject, containing directory/prefix, or
  this verified worker—with a plain-language preview and warnings for both over-broad and
  likely-one-use scopes. Optional channel scope is a toggle. Raw `subjectPattern` editing is
  available only behind an advanced affordance.
- **Controls**: TTL (default 30 days), use budget (default 100), `maxSeverity`
  toggle (`routine` default; `sensitive` is an explicit opt-in switch with
  warning copy), `requiresGrantorPresence` switch.
- **Confirm** calls `delegations.confirm` through the shared delegation service as verified human
  chrome. The host validates the edits and records the action with user/device provenance.
  Conversation eval may produce and explain the draft but is categorically denied confirmation,
  renewal, or widening authority. This is an owning-service consent rule, not a special model tool
  or receipt (design §5.1). Unconfirmed drafts expire and the card collapses to an "expired" chip.

### 4.3 Delegations management surface

Desktop: a **settings-adjacent section**,
`workspace/apps/shell/components/DelegationsSection.tsx`, mounted in
`ConnectionSettingsDialog.tsx` alongside `PairedDevicesSection` (same section
chrome), plus a "Delegations" link in the drawer header overflow menu that
opens the dialog to that section. It lists this user's policies (per-(workspace, user), each
entry showing the device that created it as attribution) with: state (active/exhausted/expired/revoked), budget remaining, TTL,
severity cap, full decision audit trail (every auto-approval and escalation
with rationale and WP5 provenance stamp), one-tap **revoke**, and **edit** —
edits create a draft new policy version for human confirmation and revoke the old one only when
the replacement activates, with the audit trail
preserved (design §5.2). Mobile: the same list under the System screen's
overflow menu (§5).

## 5. Mobile System surface (SA4)

The mobile app (`workspace/apps/mobile`, React Native, drawer navigation via
`MainNavigator.tsx` with `PanelDrawer` content and `MainScreen` as the panel
host) gains a System screen with this concrete structure:

- **Navigation placement**: a new `Drawer.Screen name="System"
  component={SystemScreen}` in `src/navigation/MainNavigator.tsx`, and a
  fixed "System" entry pinned at the top of `PanelDrawer.tsx` above the panel
  tree, showing the `unreadIncidents + pendingApprovals` badge. A compact
  status chip (storm/attention dot) also renders in `AppBar.tsx`, tapping it
  navigates to the System screen.
- **`src/components/SystemScreen.tsx`** layout, top to bottom (single
  `ScrollView` with the conversation section taking remaining height):
  1. **Inbox — triage first** (design §7.1): `IncidentCardView` /
     `StormCardView` list with swipe actions (swipe left = dismiss, long-press
     menu = mute / star signature / investigate). Dismiss and mute are shared
     and attributed exactly as on desktop (§6).
  2. **Approvals section**: the pending queue rendered as compact rows with
     **inline approve / deny / delegate** buttons; tapping a row opens the
     existing `ApprovalSheet.tsx` for full detail. Delegate follows §4.
  3. **Conversation**: the same transcript stack as desktop — the
     `@workspace/agentic-chat` components run in the mobile web view layer the
     app already uses for panel content (`PanelWebView`), bound via
     `systemAgent.resolveConversation` (the user's per-(workspace, user)
     conversation, device-attributed); composer at the bottom
     inside a `KeyboardAvoidingView`.
- **Push deep-links** (log-watcher spec §10 budget rules): pushes arrive through the
  existing `approvalPushBridge`/`pushService` FCM/APNs path. A storm push
  deep-links to the System screen scrolled to **its** inbox card; an approval
  push deep-links to that approval's row/sheet — extending the existing
  `approvalDeepLinkAtom` pattern (`src/state/approvalDeepLinkAtom.ts`) with a
  sibling `systemInboxDeepLinkAtom` carrying the target card id.
- **Starring**: every incident/storm card's long-press menu includes "Star
  signature" — writes `starredBy` on the signature (log-watcher spec §7/§10), opting
  that signature into OS push for this user. Starred state shows as a filled
  star glyph on the card; unstar from the same menu.
- **Debug sessions**: `DebugSessionLinkCardView` deep-links into the ordinary
  mobile session view — the same `MainScreen`/`PanelWebView` route used for
  any chat panel, with the session's channel as target. No special mobile
  debug surface exists or is added.

## 6. Shared behavior (both surfaces)

- **Human-gesture-initiated System Agent activity**: every conversation turn traces to a
  host-observed human gesture—a typed message, incident forward, delegate action, or share-lines
  action (`LogShareCard`, §3); there is no autonomous/timer-driven conversation mode. Card clicks
  call services directly as verified UI actions and do not run the model. Typed messages,
  incident forwards, delegate actions, and log shares become
  attributed turns; immediately before the model handles them it receives a fresh
  complete `ShellOverview`. Wherever
  this document or its parents say "user turns" or "user-initiated", read it
  as this full gesture set, not typed messages only.
- **Conversation binding**: both clients obtain their conversation via
  `systemAgent.resolveConversation` — the host derives the acting user (and
  attributing device) from the verified caller subject, never from arguments
  (SA0 plan §5). One conversation per (workspace, user): desktop and phone
  see the **same** transcript, with device attribution stamped on every turn
  and action; the inbox is shared workspace-wide across users.
- **One service plane**: desktop, mobile, cards, and eval terminate in the same typed owning
  methods. User-visible behavior added to a client fails parity CI until it is reachable from eval
  or classified as renderer plumbing, human secret input, human approval consent, or independent
  trust-root administration. Non-delegated approval payload/settlement and delegation activation/
  renewal/widening stay in verified human surfaces; conversation eval sees pending metadata and
  non-expanding delegation management. The parity map verifies services and prompt recipes; it
  does not generate tools.
- **Inbox is shared, hub-owned**: one inbox per workspace, fanned out to all
  clients. **Dismiss** clears the card for everyone; **mute** silences the
  signature for everyone; both are attributed (`mutedBy`, dismiss attribution
  shown as "dismissed by <user>" on the signature's history) and reversible
  from the signature list (design §6.1).
- **Ambient strip / status chips are mechanical only**: every number shown
  outside a card body comes from host stores and counters — never from model
  output. Model text appears only inside cards, alongside the mechanical facts
  that anchor it (design §4 injection stance).
- **Render, don't re-quote**: all untrusted strings (panel/entity/channel/unit titles,
  participant handles, palette labels, log lines, signature templates, model summaries) render as inert
  text in the components of §3 — no markdown rendering, no HTML, no
  auto-linking. `MessageContent`'s markdown path applies only to the System
  Agent's own connective prose in the transcript, never to card payload
  fields. This is enforced by the card components taking payload fields into
  `Text` nodes directly, and verified by the SA0 adversarial exit test
  (hostile string in a panel title, participant handle, palette label, or log line
  renders inert in the drawer — SA0 plan §10 and the adversarial parity gate).
