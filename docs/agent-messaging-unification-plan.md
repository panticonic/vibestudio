# Agent Messaging Unification — `notify`, Addressing, and Discovery

Status: PLAN (2026-08-14, revised 2026-08-14 after code verification).
Workspace state referenced below lives in `~/vibestudio-release-work/base`
(base template), with product templates in
`~/vibestudio-release-work/{news,spectrolite,google}`.

## 0.1 Corrections to the first draft (2026-08-14)

The first draft was checked against the actual code. Seven claims were wrong or
under-specified; each is fixed in place below and recorded here so a reader of
the original knows what moved.

1. **Presence-aware suppression is cut** (was §4.5 step 2, §3.5). Two reasons,
   in order of weight. First, it is a *prediction* ("the user is probably
   looking at this") standing in for a *fact* that arrives moments later ("the
   user read it") — and the fact is already available, because inbox entries
   acknowledge on open. Suppression-by-guess can only be wrong in the
   expensive direction: a notification that never existed cannot be recovered
   when the guess was wrong, whereas an entry that self-acknowledges on read
   costs nothing when the guess would have been right. Second, it had no
   substrate at the layer the draft put it: `workspacePresenceService.ts:77`
   states the invariant *"no channel/roster concept crosses this interface
   (INV-1)"*, and `presenceService.ts:8-17` tracks only
   `panelId → ownerCallerId`, so host-side channel attendance would breach a
   deliberate boundary. Replaced by an **explicit three-rung `alert` ladder**
   (§4.3/§4.5) plus **acknowledge-on-read** (§4.5.4). New decision **D12**.
   (This is not a scope objection — the plan grows in several places below
   where the work is warranted. It is a wrong-mechanism objection.)
2. **The news `notify` column is not presence bookkeeping**
   (`news-agent-worker.ts:479-481`): it records *why the run happened*
   (scheduled vs "Brief me now"), which presence cannot answer. §3.5 and §6.2
   corrected; the column still goes, but its meaning survives as an explicit
   `alert` argument.
3. **`@handle` → agent resolution does not exist.** The cited
   `participant-ref.ts:240` is `resolveMentionToUser`, which hard-filters
   `if (ref.kind !== "user") continue`. Roster-wide handle resolution is new P1
   work, not reuse (§2.1, §4.2).
4. **The `saliency` wire rename is reverted** (D3). `schemas.ts:135,163` are
   `z.literal("say")` inside `.strict()` objects, so emitting `"notify"` fails
   validation on write *and* replay until every reader ships first. The wire
   value stays `"say"` permanently; only the tool and the prose rename.
5. **Cross-channel hop propagation needs an explicit mechanism** (§4.6).
   `agentHops` is a per-channel fold (`conversation-v1.ts:227-234`), so a guest
   envelope in a fresh channel starts a fresh streak. The plan now names the
   `causality.agentHops` override path and the Gad fan-out caveat. New decision
   **D13**.
6. **Locked-membership channels are an exception to D6** (§4.6):
   `channel-do.ts:2120-2131` refuses non-admitted participants and
   `updateConfig` (4137) makes that immutable. Guest envelopes go through the
   same admission check and fail closed. New decision **D14**.
7. **Smaller:** directory instance identity was three namespaces in one primary
   key (§4.4); "one envelope" was self-contradictory for cross-channel fan-out
   (§4.3); quickfire reuse is a session-source generalization, not a bare added
   entry path (§4.8).
8. **Added §4.10 — presentation and record of inter-agent traffic.** The draft
   specified delivery but never said what a person sees or what is durably
   written about agents talking to each other. §4.10 fixes that: the
   three-event recording model (built on `external.envelope_published` /
   `external.envelope_observed`, which exist in the protocol and Gad's ingest
   allowlist but have no writer today), the chat row vocabulary, the dispatch
   card, the guest message, the escalation footer, the notification-center and
   toast/push shapes, and a stated noise budget. New decisions **D15**
   (one canonical copy, references not relayed transcripts) and **D16**
   (acknowledgement *is* the read receipt).

## 0.2 Implementation status (2026-08-17)

P1–P6 are implemented against the base checkout, the host, and the
news/spectrolite/google templates. A review-and-finish pass on 2026-08-17 fixed
the defects it found and closed the gaps the first pass had recorded; what
follows is the state after that pass.

**Fixed on review (were wrong or missing).**

- `@gabriel` — a *person* on the roster — resolved to the bare `participant`
  kind, so addressing a human by handle never escalated. Humans now resolve to
  the `user` kind however they are named (`@handle`, `participant:user:<id>`,
  `user:<id>`), and `@handle` falls back to an exact workspace-member handle for
  a person not yet on the channel.
- The `to` parameter description omitted the `agent:<handle>@<channelId>` form
  the resolver, `discover_agents`, and `list_addressees` all use.
- Off-roster people were refused ("escalation pipeline … not enabled"). They
  are now reached as §4.6 specifies: `addMember` (durable membership, so the
  entry can open the conversation), the envelope addressed to their `user:` id,
  the inbox entry, the push. The workspace member list is read live from
  `account.listWorkspaceMembers`.
- Guest envelopes dropped `attachments`; they now carry them.
- The `external.envelope_observed` back-pointer named the *guest* envelope id
  in the *sender's* channel — an id that does not exist there. It now names the
  bound-channel copy of the notify (or, absent one, the authoring tool call),
  and the same id rides on `senderMetadata.origin.envelopeId` so the recipient's
  "from #channel ▸" link lands without a join.
- The recipient's model saw a guest message as `[news-agent]: …` with no way to
  answer. Guest speakers are now labelled with their origin and the exact
  `agent:<handle>@<channelId>` ref to reply with (`agent-loop/src/context.ts`).
- An explicit rung on an *untargeted* notify escalated nobody (only addressed
  users were escalated), which made the spectrolite prompt's
  `alert:"inbox"`-on-completion advice a no-op. D8's second clause is now
  implemented: a rung above `none` reaches the addressed people, or — with no
  person in `to` — the people on the channel. Nobody outside the conversation
  is guessed at.
- `useQuickfireSessionCore.startFresh` duplicated the connect path without the
  event loop, so a fresh command-agent session never rendered live updates.
  The core now has one `bind()` path used by the resolve effect and
  `startFresh` alike.

**Closed gaps.**

- **§4.8 conversation surface** — the quickfire session core takes a
  `QuickfireSessionSource` (`slot` | `conversation`); in conversation mode
  nothing is minted, the person joins as themself, replies thread under the
  escalated envelope and are addressed to the notifier, `clear`/`startFresh`
  throw and are not rendered, and `promote` resolves to the channel's own facts.
  Desktop mounts it from the notification bar's **Reply** (and the interrupt
  toast's Reply) via `openConversationSurfaceAtom`; pop-out goes through the
  shared find-or-open `openChannel`. Mobile mounts the same core in the
  quickfire sheet from a `conversation` sheet request; a tapped push lands
  there.
- **Push** — `notification.pushUserInbox` (host, code/host-only; reviewed in
  `scripts/runtime-authority-review.json`) sends one durable inbox entry to the
  addressed member's own registered devices; `escalateNotify` calls it at
  `inbox` and above with `priority:"high"` at `interrupt`. Mobile displays it on
  a "Messages" channel under the entry's own id and deep-links to the sheet.
  Approvals keep their own bridge; the transport is the same `pushService`.
- **Acknowledge-on-read (D16)** — `PubSubClient.recordReadReceipt` exists for
  human surfaces; the chat transcript (`useEscalationAcknowledgement`) emits the
  read receipt and acknowledges the inbox entry for any rendered message that
  was escalated to this person while the surface is visible; the conversation
  surface emits the receipt for the envelope it opened on. `metadata.notify` is
  projected to `ProjectedMessage.notify` and `ChatMessage.escalation` so this
  needs no inbox listing.
- **Interrupt toast** — the shell notification bar mirrors *newly arriving*
  `interrupt` entries as a toast with a Reply action; entries already present
  on load do not toast.
- **Notification bar** — groups per sending agent (newest first, ×N),
  expandable list, Reply / Open / Dismiss, and an invite for the same channel
  is retired when its message is opened.
- **Chat UI** — `focusMessageId` stateArg (set by every open path, including an
  already-open panel via `stateArgs.set`) scrolls to and highlights the
  envelope; the dispatch card has `[Open ▸]`, expands through
  `useForeignEnvelope` (observes, never copies), and shows
  queued/delivered/read/replied; the guest chip is the origin link; the
  escalation footer renders rung and read state; the header gains the
  external-conversations menu; `onOpenChannel` (find-or-open, `panels/chat/
  openChannelPanel.ts`) is threaded through `ChatContext`.
- **Gmail** — reauth escalates to the owner once per transition into
  `reconnect-required`, on the setup card that carries the reconnect affordance.

**Closed in the follow-up pass (2026-08-17, later).**

- **The directory never filled in production.** The roster/directory
  projection consumed only `payloadKind:"presence"` envelopes, which the
  channel never appends (presence is a disposable signal); the durable facts
  are `channel.subscription.opened/revised/ended/detached`. Gad now projects
  those (`rosterActionForPayloadKind`), `presence` stays accepted for direct
  appenders, projection replay clears the directory tables too, and a
  one-time backfill (`afterSchemaReady`, marker
  `roster-projection:subscription-facts:v1`) replays existing subscription
  facts so upgraded workspaces are populated. `description` and
  `subagentRunId` joined the public participant metadata keys so they survive
  the channel's sanitization; the vessel stamps `subagentRunId` on a
  subagent's roster metadata.
- **"Show acknowledged"** — `listUserNotificationsForMe({includeAcknowledged,
  limit})` (Gad, schema, runtime client, shell + mobile clients); entries carry
  `acknowledgedAt`; the notification bar's expander offers history with Open.
- **`hibernated`** removed from the status vocabulary (schema enum, CHECK for
  new tables, ordering); statuses are `running` / `idle` / `terminal` and
  `idle` covers an evicted DO. Existing tables keep the superset CHECK — the
  value is simply never written.
- **Self-description (D9)** — implemented as the agent's own authorship rather
  than a side model call: a `set_description` tool revises the agent's roster
  metadata (durable `channel.subscription.revised` → directory row → FTS) and
  persists per channel so it survives rejoin. The description is what
  `discover_agents` searches beside the latest deliberate utterance; the
  `messaging` skill tells agents to keep it current.
- **Guest hover card** — the origin chip is a `HoverCard` naming the guest,
  their origin channel, and the exact reply ref, with the open action.
- **Messaging failures** — resolver/closed-channel/unreachable errors now carry
  typed recovery (`correct-request` with suggestions; `stop` for closed
  channels and unreachable people; `reobserve` for delivery failure) and are
  classified (`not-found` / `invalid-input` / `domain`) so the invocation card
  and the model both see what to do. The invocation card is the row for a
  refused notify; a second `messaging-error` diagnostic row would restate it.

**Still deferred, deliberately.**

- **`describeChannels` title** — unchanged: Gad has no honest source for a
  channel title; callers ask the channel (as `openChannel` and
  `describeConversation` do).
- **`linked-agent-worker.say`** keeps its name (bridge RPC, not a model tool).

**Verification (2026-08-17).** Userland type-check clean; targeted suites green
(`addressee`, `agent-worker-base.notify` (23), `channel-chat-merge`,
`conversation-v1`, `channel-do`, `pubsub`, `quickfire-core`,
`quickfireSessionCore` (16), `UserNotificationBar` (11), the agentic-chat /
agentic-core / agent-loop / agentic-do / shell-component suites); host
`notificationService` incl. `pushUserInbox`; mobile jest `pushNotifications`
(15), `QuickfireSheet`, `backgroundHandlers`. Pre-existing failures unrelated to
this work: `ApprovalCard` (2). The three product templates still have no
standalone tsconfig; their edits are reviewed, not compile-verified.

## 1. Goal

One messaging system for everything an agent utters beyond its own working
channel narration. Today five partially-overlapping mechanisms exist; this plan
collapses them into a single agent-facing **`notify`** tool over a single
**addressee model**, backed by a **workspace agent directory** in Gad for
discovery, and a single **escalation pipeline** for reaching users (durable
inbox → shell toast → mobile push → chat-panel deep link).

What unifies into `notify`:

- the `say` tool (`agent-worker-base.ts:330`, `createSayTool`) — deliberate
  channel utterances with `saliency:"say"`, attachments, mentions, and the
  implicit route-to-parent for subagents;
- parent↔subagent messaging (`send_to_subagent`, and the child's `say`-to-parent
  audience injection at `agent-worker-base.ts:380-395`);
- user notification surfaces: the ephemeral shell toast
  (`runtime/src/shared/notifications.ts` → host `notificationService.ts`) and
  the durable Gad user-notification inbox (`putUserNotification` /
  `listUserNotificationsForMe`, today used only for `channel.invite`);
- newly added: semantic discovery of active and historical agents, direct
  pings to agents in other channels, and waking hibernated/historical agents;
- addressing channel participants by `@handle` (participant-ref resolution
  already exists, `agentic-protocol/src/participant-ref.ts:240`).

Non-goals: rebuilding channel mechanics (WS2 substrate, respond policies, hop
caps, wake policies all stay); inter-user security isolation (trusted
family/team environment — the multi-user work here is ergonomics, not
security); replacing `ask_user` (question-and-wait is a distinct interaction —
it stays, but rides the same addressing and escalation path).

## 2. Current-state inventory (what exists, verified)

### 2.1 Channel messaging & addressing (sound; keep)

- Envelopes carry protocol-level addressing: `mentions`, `replyTo`,
  `to: ParticipantSelector[]` (`all`/`role`/`participant`), `tier`,
  `saliency:"say"` (`agentic-do/src/channel-client.ts:29-51`).
- `resolveShouldRespond` (`agentic-protocol/src/addressing.ts:102`) is the one
  pure respond decision: respond policies (`all`/`mentioned`/`mentioned-strict`/
  `mentioned-or-followup`/`from-participants`), conversation policies
  (`open`/`directed`/`moderated`), and the agent hop cap (default 4).
- `@handle` → participant resolution exists **for humans only**:
  `resolveMentionToUser` (`participant-ref.ts:240`) resolves id → exact
  case-insensitive handle → displayName, but opens with
  `if (ref.kind !== "user") continue`. `ask_user` rides it and fails closed on
  unknown targets. **There is no roster-wide handle resolver** — addressing an
  agent by `@handle` is new work (§4.2), not reuse.
- Per-subscription `wakePolicy` (`every-envelope`/`explicit`/`manual`) governs
  whether an inbound envelope wakes the agent (`agent-vessel.ts:3620-3626`);
  `saliency:"say"` passes the `explicit` filter. Delivery interest per join is
  `all`/`addressed`/`none` (`channel-client.ts` `ChannelJoinInput`).

### 2.2 `say` (absorbed into `notify`)

`createSayTool` (`agent-worker-base.ts:330`): content + `replyTo` + `mentions`
(participant IDs, not handles) + file-path image attachments; messageId derived
from the tool-call id for redrive dedup; when the sender is a subagent, the
parent participant is injected into `to:` so the say creates supervisor work.

### 2.3 Subagent communication (supervision stays; messaging unifies)

Parent-side: `spawn_subagent`, `send_to_subagent`, `inspect_subagent`,
`merge_subagent`, `read_subagent`, `cancel_subagent`
(`agent-worker-base.ts:441+`); run records in `subagent-runs.ts`. Child-side:
`complete`, plus `say` routed to parent. Supervisors subscribe to task channels
with `wakePolicy:"explicit"`.

Of these, exactly one is *messaging*: `send_to_subagent`. The rest are
lifecycle/inspection/integration and stay untouched.

### 2.4 User notification surfaces (three disjoint ones today)

1. **Ephemeral shell toast**: `NotificationClient.show()` in userland runtime
   (`runtime/src/shared/notifications.ts`) → host `notification.show` RPC →
   `EventService` → shell NotificationBar (`src/server/services/
   notificationService.ts`). Plain text, ttl, action buttons, per-user
   targeting. Used directly by the news agent (`notifyBriefingReady`,
   `news-agent-worker.ts:1503`) and panels.
2. **Durable Gad inbox**: `putUserNotification` / `listUserNotificationsForMe`
   / `acknowledgeUserNotification` on `GadWorkspaceDO`; host transports only an
   opaque `user-notifications-changed` signal (`notificationService.ts:169`,
   `signalUserInbox`). Today the only producer is channel invites. The shell
   hydrates invites and can find-or-open the `panels/chat` panel for a channel
   (`apps/shell/shell/client.ts:1185-1244`).
3. **Mobile push**: `pushService` + `approvalPushBridge` (host) — currently
   only approvals push to phones.

No agent-facing tool reaches any of these today: agents can only `say` into a
channel a user may or may not be watching, or (in bespoke worker code like the
news agent) call the toast API directly.

### 2.5 Discovery (the real gap)

- Channel enumeration: `listChannelLogs` (Gad) returns bare
  `{channelId, logId, createdAt}` — no titles, participants, or summaries.
- Roster: per-channel only (`inspectChannelRoster`, join metadata).
- Agent instances: keyed `${handle}-${channelId}` by the `agents` skill helper
  (`addAgentToChannel`); subagent runs live in each parent's private
  `subagent-runs` store. There is **no workspace-wide directory** of agent
  instances, their status, or their descriptions, and no semantic search over
  any of it. Gad's only FTS today is the memory index (`gad_memory_fts`);
  provenance search (`vcsSearch`/`vcsQuery`/`vcsWalk`) covers workspace
  content, not conversations/agents.
- Capability discovery (`docs_search`/`docs_open` tools) covers services and
  runtime APIs, not live participants.

### 2.6 Product templates

- **news**: agent publishes briefings into its channel and fires a bespoke
  ephemeral toast; a `notify` column on `news_briefings` distinguishes
  scheduled (toast) from manual "Brief me now" (silent) runs.
- **spectrolite**: mention-driven coedit agent (`@handle` etiquette is prompt
  text in `panels/spectrolite/agent-prompt.ts`); no proactive surface.
- **google/gmail-agent**: sync + triage exists; no notification of the user at
  all (important-mail triage has nowhere to escalate to).

## 3. Problems this plan fixes

1. **Five mechanisms, one meaning.** "Get this text in front of X" is spelled
   differently for channel (`say`), child (`send_to_subagent`), parent
   (implicit audience injection), user-toast (worker-level RPC), and
   user-inbox (not reachable by agents at all).
2. **User notifications are second-class and lossy.** Toasts are ephemeral
   plain text with no link to the conversation; the durable inbox supports
   only invites; nothing pushes to mobile except approvals.
3. **Agents are blind to each other.** No way to ask "who else is running,
   what are they for, how do I reach them" — let alone find a historical agent
   worth waking.
4. **Addressing is participant-id-shaped at the tool boundary** while humans
   and prompts think in handles.
5. **Every template reinvents notification policy, and each invents its own
   escalation vocabulary.** News carries a `notify` column
   (`news-agent-worker.ts:479-481`) that records *why the run happened* —
   scheduled/cold-start vs a manual "Brief me now" — and maps that to
   toast-or-silence at publish time (`:1483-1492`). That is trigger provenance,
   which only the caller knows; the mistake is not that news tracks it but that
   news must also own the surface decision, the toast call, and a schema column
   to carry it. Under `notify` the caller passes an `alert` rung and owns
   nothing else. Gmail triage, by contrast, has no vocabulary at all and so has
   nowhere to escalate to.

## 4. Target design

### 4.1 One primitive

**Every `notify` is a durable channel envelope first.** Escalation (waking an
agent, a user inbox entry, a toast, a push) is *delivery metadata on that
envelope*, never a parallel side-channel. This preserves the existing
invariants: everything is in Gad, provenance-walkable, replayable, and
projected into chat panels; respond policies and hop caps apply uniformly; a
"notification" is always openable as its conversation.

Corollary: "place a message in the context of another agent" is *not* a new
context-injection mechanism — it is ordinary channel delivery to a channel
that agent subscribes to, waking it per its wake policy, with full sender
metadata on the envelope so it can reply.

### 4.2 The addressee model (`AddresseeRef`)

New in `@workspace/agentic-protocol` (`addressee.ts`), used by the tool layer
and the discovery API. One string grammar, one parser, exhaustively typed:

| Form | Kind | Resolution | Delivery |
|---|---|---|---|
| *(omitted)* | current channel | — | envelope on the bound channel (today's untargeted `say`; subagents keep the implicit parent-in-audience rule) |
| `@handle` | channel participant (human **or** agent) | new roster-wide `resolveHandle` (§4.2.1), fail closed | envelope with `to:[{participant}]` + mention |
| `participant:<id>` / `user:<id>` in-roster | channel participant | direct | same |
| `parent` | supervising parent | `subagentIdentity().parentParticipantId`; error if not a subagent | envelope on the task channel addressed to parent (passes `explicit` wake filter) |
| `run:<runId>` | own subagent | parent's `subagent-runs` store (prefix match, as today) | envelope on the child's task channel addressed to the child (absorbs `send_to_subagent`) |
| `agent:<handle>@<channelId>` | any workspace agent, running **or hibernated** | Gad agent directory (§4.4) | envelope on that agent's directory channel, subject to that channel's admission policy (§4.6); DO wake is free (durable channels + mailbox endpoints already survive hibernation) — "waking a historical agent" is just messaging it |
| `user:<id>` not in roster / `owner` | workspace user | host account service; `owner` = the channel-owning user | envelope stays on the sender's channel addressed to the user **plus** user-escalation (§4.5) |
| `channel:<channelId>` | another channel | Gad channel directory | cross-channel post (§4.6) |

`resolveAddressee(ref, ctx) → ResolvedAddressee | AddresseeError` is a pure
function; the tool surfaces the error text (with near-miss suggestions from
the directory) instead of guessing. This function *is* the "clear API that
clarifies the different kinds of addressees" — it is also exposed to agents as
the read side, `list_addressees` (§4.7), so what you can discover and what you
can address are the same enumeration by construction.

Resolution is *attribution-grade, never authorization*: resolving a ref says
who was meant, and the write path's admission checks (§4.6) say whether the
envelope lands. Keeping those separate is what lets resolution stay pure.

#### 4.2.1 `resolveHandle` — the roster-wide resolver (new)

`resolveMentionToUser` (`participant-ref.ts:240`) is human-only by
construction: `if (ref.kind !== "user") continue`. Generalize it rather than
adding a sibling, since a handle collision between a human and an agent must
be adjudicated in one place:

```
resolveHandle(token, roster, opts?: { kinds?: ParticipantKind[] })
  → ParticipantRef | { error: "unknown" | "ambiguous", suggestions: string[] }
```

- Matching order is unchanged and stays exact-first: participantId (bare or
  `user:`-prefixed), then exact case-insensitive `metadata.handle`, then
  displayName. Fuzzy matching never *resolves*; near-misses only populate
  `suggestions`.
- Ambiguity is an error, not a tie-break. Two participants sharing a handle in
  one roster is a directory bug; failing closed surfaces it instead of
  silently delivering to whichever the iteration order hit first.
- `resolveMentionToUser` becomes `resolveHandle(token, roster, {kinds:["user"]})`
  and keeps its name and export as the `ask_user` entry point — its
  human-only contract is deliberate, not an accident to be widened.

Tests live beside the existing participant-ref suite: agent handle resolves;
human/agent collision errors; displayName match still works; unknown returns
suggestions and never a participant.

### 4.3 The `notify` tool

Replaces `say` in `agent-worker-base.ts` (repo policy: fix the primitive,
delete the old one — `createSayTool` and `send_to_subagent` are removed, not
wrapped).

```
notify({
  content: string,           // markdown; rendered rich in chat + notification UI
  to?: string | string[],    // AddresseeRef grammar; omit = current channel
  replyTo?: string,
  attachments?: string[],    // file paths, as today
  alert?: "none" | "inbox" | "interrupt",  // escalation rung, §4.5
  title?: string,            // short headline for escalated surfaces; defaults to first line
})
```

The **`alert` ladder** is three explicit rungs — no heuristics, no `"auto"`
(D8, D12). Each rung is a superset of the one below:

| Rung | What it does | Default when |
|---|---|---|
| `none` | channel envelope only | no user is addressed (i.e. agent-to-agent and plain channel utterances) |
| `inbox` | + durable Gad inbox entry, + notification-center row, + mobile push | a user is addressed |
| `interrupt` | + shell toast, + high-priority push | never a default; always the agent's explicit choice |

Whom a rung reaches: the people addressed in `to` — or, when the agent raised
the rung explicitly on an untargeted notify, the people on the channel (D8's
second clause: the agent set it on purpose). Nobody outside the conversation is
ever guessed at; an untargeted notify with no rung is a plain channel message.

The rungs are named for what the *recipient experiences*, not for the sender's
urgency assessment, because that is the only thing an agent can be held to.
`inbox` is deliberately the addressed-user default: it lands durably and
reaches the phone, but does not seize a screen. `interrupt` is the rung §4.9's
etiquette is about.

Behavior:

- messageId remains derived from the tool-call id (redrive dedup preserved).
- `saliency` stays the wire value `"say"` (D3, revised): the tool renames, the
  envelope field does not. It is an internal enum no user ever sees, and
  `schemas.ts:135,163` type it as `z.literal("say")` inside `.strict()`
  objects — emitting `"notify"` would fail validation on write *and* on
  replay, and would need every reader
  (`agent-vessel.ts:7922` wake gate, `derived-types.ts:269` say-feed filter,
  `channel-chat-merge.ts:686`, `handlers.ts:374,453`,
  `linked-agent-worker.ts:1086`) to ship before any writer. Vocabulary tidiness
  is not worth a release-skew matrix in which an older vessel silently fails to
  wake.
- **Multiple addressees within one channel compose into one envelope** (`to:`
  union), not N sends. Addressees spanning channels *cannot*: an envelope
  belongs to exactly one log, so a cross-channel `to:` list produces **one
  envelope per target channel**, plus at most one inbox entry per addressed
  user. Dedup ids therefore derive per target — `say:<toolCallId>` on the
  bound channel, `say:<toolCallId>:<channelId>` for each guest envelope, and
  `notif:<toolCallId>:<userId>` for each inbox entry — so a redriven `notify`
  re-sends the same set rather than a second fan-out. §8's "no duplicate
  surfaces" invariant is stated per target, not globally.
- All existing discipline applies unchanged: hop caps, conversation policy,
  wake policies, tier. `notify` does not force a response; it makes one
  *possible* (addressed delivery) and *observable* (directory + inbox).
- Every agent gets it (it is the base channel utterance), so publish policies
  (`all`/`turn-final`/`say-only`) gain `notify-only` as the canonical spelling.
  `say-only` stays a **frozen accepted alias**, normalized on read: the value
  appears in checked-in agent configs across templates, and a rename that
  invalidates existing manifests is the same skew trap as the saliency rename,
  for the same zero benefit. Docs and generated schemas advertise only
  `notify-only`.

`ask_user` stays as the blocking question tool but is refactored to share the
addressee resolver and, when the target user is not attending, the same
escalation pipeline (a pending question becomes an inbox entry + push with a
deep link, resolved by lifecycle — answered/withdrawn — not by clock).

### 4.4 Gad agent directory (discovery substrate)

Extend `GadWorkspaceDO` with a first-class **participant directory** — the
semantic control plane already sees every join, envelope, invocation and
terminal, so this is a projection, not a new source of truth:

New tables (+ FTS5 mirror `gad_agent_directory_fts`, with the same
virtual-table/plain fallback pattern as `gad_memory_fts` — the sql.js vs
workerd class of bug is known, test both):

```
agent_directory(
  instance_id TEXT PRIMARY KEY,      -- "<handle>@<channelId>" — see identity rule below
  channel_id TEXT NOT NULL,          -- the channel this instance is a participant of
  participant_id TEXT NOT NULL,      -- its roster identity in that channel
  kind TEXT,                         -- "worker-agent" | "subagent" | "system"
  handle TEXT, display_name TEXT,
  description TEXT,                  -- from join metadata / spawn task summary
  parent_instance_id TEXT,           -- subagent lineage
  run_id TEXT,                       -- subagent runId, when kind = "subagent"
  worker_id TEXT,                    -- the DO/worker identity behind this instance
  owner_user_id TEXT,
  status TEXT,                       -- "running" | "idle" | "hibernated" | "terminal"
  status_event_id TEXT,              -- lifecycle event that set it (no clocks; see D5)
  last_activity_at INTEGER,          -- informational only, never a liveness gate
  summary TEXT                       -- rolling self-description: latest notify/title/task
)
```

**Identity rule (corrects the draft).** The first draft fused three namespaces
— `${handle}-${channelId}` from the `agents` skill, subagent runIds, and
worker DO ids — under one primary key, and gave each row a single
`home_channel_id` even though a worker agent commonly joins several channels.
Both are wrong: they make `agent:<instanceId>` ambiguous exactly where it
matters (a directory hit you cannot address). The rule instead:

- **An instance is a (worker, channel) pair**, keyed `"<handle>@<channelId>"`,
  which is also the addressee grammar (§4.2) — what `discover_agents` prints
  is literally what `notify` accepts. A worker agent in three channels is
  three directory rows sharing a `worker_id`; that is correct, because "message
  the gmail agent" is meaningless without saying *where*, and the three rows
  can carry genuinely different status.
- **A subagent is the same shape**: its task channel is the channel, so its row
  is `"<handle>@<taskChannelId>"` with `run_id` carried alongside for the
  parent's `run:` addressing and for lineage joins. `run:<id>` stays the
  parent-facing ergonomics; `@`-form is the workspace-facing one.
- `worker_id` and `run_id` are indexed, non-unique lookup columns, never the
  key. "All instances of this worker" is a query, not an identity.
- Collisions are therefore structurally impossible within a channel (one
  handle per roster) and meaningless across channels. `resolveAddressee` on a
  bare `agent:<handle>` with no `@channel` fails closed with the candidate
  list rather than picking — same stance as §4.2.1's ambiguity rule.

Writers (all existing choke points, no new agent obligations):
- channel join/leave (`ChannelJoinInput.metadata` already carries handle, name,
  kind, description) → upsert + status;
- subagent spawn/terminal (invocation records Gad already ingests) → lineage +
  status;
- turn open/close and `notify` envelopes → status + `summary` refresh;
- hibernation/eviction lifecycle events → `hibernated` (status flips on
  *events*, never on elapsed time — per the standing no-timeouts stance).

New Gad methods (schema-first in
`packages/service-schemas/src/workspaceSource.ts`, like every `gadMethods`
entry): `listAgentDirectory({filter})`,
`searchAgentDirectory({query, includeTerminal})` (FTS over
handle/name/description/summary + channel titles), and
`describeChannels({channelIds})` / channel directory enrichment so
`listChannelLogs`'s bare tuples become `{channelId, title, participants,
lastEnvelopeAt}`. `inspectChannelRoster` and `inspectAgentHealth` refactor to
read the same projection instead of ad-hoc queries.

Historical/terminal agents stay in the directory (`includeTerminal:true`) —
that *is* the "historical agent to wake up" catalog: their channels are
durable, so `notify to:"agent:<handle>@<channelId>"` revives them.

### 4.5 User escalation pipeline (one path, explicit rungs)

When a resolved addressee is a user, the rung from §4.3 selects how far up the
ladder the envelope travels. There is **no presence check and no suppression
heuristic** (D12) — see §4.5.4 for how the "user was already looking at it"
case is handled instead, and §0.1 for why the draft's version was cut.

1. **Envelope** (always, as ever). `alert:"none"` stops here.
2. *(no step — the draft's presence gate is deleted)*
3. **Durable inbox entry** in Gad (`alert:"inbox"` and up):
   `putUserNotification` with new kind
   `agent.message`, `title`, markdown `message`, and
   `data:{channelId, envelopeId, senderParticipantId, senderHandle, rung}`. The
   host remains content-blind (opaque `signalUserInbox` ping — keep the WP
   stance).
4. **Shell surfaces**: the notification center renders markdown, showing
   unacknowledged entries. A transient toast fires **only at
   `alert:"interrupt"`** (the inbox is the durable record; `inbox` deliberately
   does not seize the screen). Opening a notification lands in the
   **notification conversation
   surface** (§4.8) — an ad-hoc quickfire-style view bound to the notifying
   agent's channel — from which the user can reply inline or pop out to the
   full chat panel via the existing find-or-open flow
   (`apps/shell/shell/client.ts:1237`), generalized into a shared
   `openChannel(channelId, {focusEnvelopeId})` shell action (invites already
   do 90% of this; extract, don't duplicate). Mobile does the same via
   `shellClient.ts`.
5. **Mobile push**: generalize `approvalPushBridge` into a
   `notificationPushBridge` on the host: inbox-signal → push to the user's
   registered devices with the deep link payload. Push fires at `inbox` and
   above; `interrupt` sets the high-priority/alert payload flag rather than
   being the sole rung that pushes — a background agent's report is exactly the
   thing a phone is for. (Approvals keep their specialized action buttons; the
   transport generalizes.)

#### 4.5.4 Acknowledge-on-read (replaces the presence gate)

Acknowledgement is lifecycle-driven, and it is what makes suppression
unnecessary:

- **Reading the envelope acknowledges the entry, by emitting its read
  receipt** — the same event the chat panel's `AckBadge` already renders
  (D16, §4.10.6), so the notifying agent learns "seen" through a mechanism it
  already has. When any of the user's
  surfaces renders the envelope named by `data.envelopeId` in an open channel
  view — the chat panel they already had focused, the notification
  conversation surface (§4.8), a mobile sheet — that surface acknowledges the
  entry. A user who was already watching the channel sees the message arrive
  in the conversation and the inbox row retires itself; they never accumulate
  a badge for something they just read.
- **This is a fact, not a prediction.** It fires on an observation that
  actually happened, whereas the draft's presence gate had to guess *before*
  sending and could not be undone if it guessed wrong. It also needs no new
  attendance oracle and crosses no host boundary: the acknowledging surface is
  the one already rendering the channel, and it calls the existing
  `acknowledgeUserNotification` on Gad.
- **Race is benign and one-directional.** If the push lands on the phone a
  beat before the desktop acknowledges, the user gets a notification for
  something already read — mildly redundant, and it disappears on next sync.
  The inverse failure (a notification that was never created because
  attendance was mispredicted) is unrecoverable. Prefer the recoverable
  direction.
- Explicit dismiss also acknowledges. Unacknowledged entries simply remain —
  no TTLs, no clocks (D5).

If a genuine attendance signal is ever wanted (e.g. to downgrade the push rung
rather than retire the row), it belongs in userland as a channel-level fact —
the channel DO already knows which participants hold live delivery-bearing
subscriptions — and not in the host presence services, whose channel-blindness
(`workspacePresenceService.ts:77`, INV-1) is deliberate. Out of scope here.

The ephemeral `NotificationClient` toast API **remains** for panels and system
chrome (progress, errors, consent) — it is UI feedback, not messaging. Agents
and template workers stop calling it for "tell the user something" (the news
agent's `notifyBriefingReady` migrates; see §6).

### 4.6 Cross-channel and agent-to-agent delivery

`notify to:"agent:<handle>@<channelId>"` / `to:"channel:<id>"` posts to a
channel the sender is not subscribed to. Mechanics:

- The channel DO accepts a **guest envelope**: sender identified by a full
  `ParticipantRef` with `origin:{channelId, participantId}` metadata, recorded
  via the existing external-participant observation machinery
  (`ExternalParticipantObservedPayload`, `events.ts:669`) rather than a fake
  join. The recipient sees exactly who sent it and from where, and can
  `notify` back symmetrically. What is written where — and what each side's
  chat panel shows — is specified in §4.10.1.
- Guest envelopes are addressed (`to:` the target agent), so `directed`
  channels and `explicit` wake policies behave correctly.
- **Hop propagation is explicit, not inherited** (corrects the draft; D13).
  `agentHops` today is a *per-channel fold*: `conversation-v1.ts:227-234`
  counts author alternations in that channel's own policy state and resets to
  0 on a human message, and the vessel falls back to that streak when the
  annotation is absent (`agent-vessel.ts:4158`). A guest envelope arriving in a
  channel it has never touched therefore starts a **fresh** streak — an A↔B
  ping-pong across two channels gets ~2× the intended depth, and an N-channel
  ring ~N×, while every §8-style single-channel test still passes. The
  mechanism that actually works already exists and must be used deliberately:
  `conversation-v1.ts:240` honours a caller-supplied `causality.agentHops`
  ("caller-computed hop counts win"). So:
  - the sending vessel stamps `causality.agentHops = <inbound hops> + 1` on
    every guest envelope, carrying the count across the channel boundary;
  - the receiving channel's `annotate` copies it to the envelope annotation,
    which is what `resolveShouldRespond` reads (`agent-vessel.ts:4158`);
  - **caveat to verify in P4**: the Gad trajectory fan-out path does not run
    the channel policy `annotate` (`agent-vessel.ts:4110` comment), so the
    override must survive that route too, or cross-channel chains fall back to
    the local streak and the cap silently widens again.
- **Admission is checked, and D6 has one exception** (D14). Locked-membership
  channels refuse participants they do not admit
  (`channel-do.ts:2120-2131`), and that policy is host-initialized and
  immutable (`:4137`). A guest envelope is not a loophole around it: the write
  path runs the same admission check and **fails closed**, with an error naming
  the channel as closed rather than the addressee as unknown (an agent that
  cannot tell those apart will retry forever). Outside locked channels the
  trusted-environment stance holds: any workspace agent may message any other,
  no capability gate in v1 beyond the existing authority stamps on the write
  path. (If quotas/abuse handling are ever needed, they attach at the guest
  envelope choke point.)
- `notify to:"user:<id>"` where the user is not a channel member composes with
  the invite machinery: the escalated inbox entry doubles as an invite
  affordance (join-and-open), reusing `putChannelMembership` + the existing
  invite hydration path in the shell.

### 4.7 Discovery tools (agent-facing)

Two new tools in the base roster (`agent-worker-base.ts`, factories in
`@workspace/harness/standard-tools` alongside docs-search):

- **`list_addressees`** — the enumerated, kind-labeled answer to "who can I
  message": current-channel roster (with handles, kinds, and directory
  `status`), parent (if subagent), own live/terminal subagent runs, workspace
  users (with owner flagged), and a capsule of the agent directory (running
  instances first). This is the read side of `resolveAddressee`, same data,
  same kinds — every row prints the exact ref string that `notify` accepts.
- **`discover_agents`** — semantic search over the directory
  (`searchAgentDirectory`) + channel directory: query by purpose ("who handles
  gmail triage"), filter running/hibernated/terminal, returns
  `agent:<handle>@<channelId>` refs ready to paste into `notify`/`ask` plus
  channel links. Overviews come from the `summary` column, not transcript
  dumps.

The docs/capability catalog (`docs_search`) links to these ("to reach a live
participant, use discover_agents") but stays a schema catalog.

### 4.8 Notification conversation surface (shared with quickfire)

An agent notification must open into a lightweight conversation with the
notifying agent — reply inline, escalate to the full panel only on demand.
This is exactly the quickfire/command-agent surface, and it shares that code
rather than growing a sibling:

- `@workspace/quickfire-core`'s session core (`session.ts`) is already
  transport-agnostic and channel-generic: it binds to
  `{channelId, contextId}` facts, joins via a `QuickfireTransport`, projects a
  bounded transcript (`TRANSCRIPT_LIMIT`, ~30 Hz reduction over
  `reduceChannelView`), and `promote`s to a chat panel. The only
  quickfire-specific part is session *minting* (`sessionFor(slotId)` — a
  per-slot agent under mission-grant authority).
- **Generalize the session *source*, don't add an entry path beside it**
  (corrects the draft). `useQuickfireSessionCore(slotId, transport)` is
  slot-keyed end to end — `sessionFor(slotId)`, `promote(slotId)`, and
  `startFresh` all thread it (`session.ts:70-77, 194, 320, 333`). The change
  is to make the core take a **session provider** that yields
  `QuickfireSessionFacts`, of which there are two implementations: the
  existing slot minting, and `conversationFor({channelId, contextId,
  focusEnvelopeId})`, which returns pre-resolved facts for an **existing**
  channel (the notification's `data.channelId`).
- In conversation mode `startFresh` and `clear` are **not present** — there is
  no "fresh" for a channel that already exists, and clearing someone else's
  conversation is meaningless. The controller type makes this explicit
  (optional members on the returned controller, absent in conversation mode)
  rather than exposing no-ops the UI must remember not to render.
- No new agent, no new authority: the user joins as their ordinary `user:`
  participant and a reply is a normal addressed channel message to the
  notifying participant (`replyTo` the notification envelope, so respond
  policies wake exactly the right agent).
- Rendering the focused envelope in this surface is what acknowledges the
  inbox entry (§4.5.4).
- Desktop mounts it from the notification center/toast via the shell overlay
  (`QuickfireOwner`/`quickfireSurfaceModel` generalize to take pre-resolved
  facts); mobile mounts the same core in its sheet, as quickfire already does.
- "Show all"/pop-out reuses quickfire's `promote` semantics, resolved through
  the shared `openChannel` action — landing in the *existing* chat panel for
  that channel when one is open, focused on the notification envelope.

One engine rule (as with quickfire): this surface is a projection over the
ordinary channel; it introduces no second transcript store and no special
reply path.

### 4.9 Prompting discipline (restraint is part of the design)

The mechanics above make notification cheap; the prompts must keep it *rare*.
Alongside the tool description, the system-prompt layer
(`subagent-prompt.ts`, worker agent base prompts, and the `messaging` skill)
carries an explicit notification etiquette:

- **Notify on notable circumstances only**, calibrated to context: what the
  conversation has established as report-worthy, what the user or supervising
  parent asked to hear about, and the escalation level (an `alert` interrupts
  a human — reserve it for things they would want to be interrupted for;
  channel-level notify is for milestones, blockers, verification results —
  never turn narration).
- **Expectations are addressable state**: if the user/parent said "only tell
  me when it's done" or "keep me posted every step," that instruction governs
  over the default. Subagent tasks should state reporting expectations at
  spawn (the spawn prompt template gains a line for it).
- **Steer, don't poll** (inherited verbatim from the deleted
  `send_to_subagent` description, which was carrying this weight): a `notify`
  to a child is for correcting course or adding information it lacks. Progress
  is read with `inspect_subagent`/`read_subagent` and arrives on terminal
  delivery; messaging a working child to ask how it is going costs it a turn
  and buys nothing.
- **Break ping cycles**: do not reply to acknowledgments, do not thank,
  do not re-notify what the recipient already acknowledged; if an
  agent-to-agent exchange stops producing new information, stop messaging —
  the hop cap (§2.1) is the mechanical backstop, the prompt norm is to stay
  well under it. When another agent pings you needlessly, answer once with
  what is needed (or not at all) rather than mirroring.

### 4.10 Presentation and record of inter-agent traffic

Everything above is plumbing; this section is what a person actually sees, and
what is durably written so they can see it later. Three audiences read the same
facts: the chat panel (§4.10.3–4.10.7), the notification surfaces
(§4.10.8–4.10.9), and provenance walks (§4.10.10).

#### 4.10.1 The recording model — three events, one canonical copy

The protocol already has the exact pair of events this needs; neither is
written by anything today, and both are already in Gad's ingest allowlist
(`GadWorkspaceDO.ts:6055-6057`) and the policy delivery table
(`channel-policies/src/index.ts:144-145`):

| Event | Written in | Payload it carries | Means |
|---|---|---|---|
| `external.envelope_published` (`events.ts:649`) | the **sender's** channel | `publications:[{channelId, envelopeId, payloadKind, eventId, summary}]` | "we said something over there" |
| the guest `message.completed` itself | the **target** channel | ordinary message payload + `senderMetadata.origin:{channelId, participantId}` | the canonical utterance |
| `external.participant_observed` (`events.ts:669`) | the **target** channel | `{participant, action:"updated"}` | the guest identity, recorded without a fake join (§4.6) |
| `external.envelope_observed` (`events.ts:660`) | the **target** channel | `{channelId, envelopeId, from, payloadKind, body?}` | back-pointer to the sender's authoring context, for the reverse walk |

**One canonical copy (D15).** The utterance exists once, in the target
channel's log. The sender's channel records a *reference*, not a transcript.
This is the same law `SubagentRunCard` already states — *"the card's summary
line comes from the durable task card itself… there is no relayed copy of
child activity in the parent's log"* — and the same UI consequence: a
collapsed summary is durable and local, detail is observed from the foreign
channel and drawn by the same `MessageList`.

Nothing is lost by not copying: the full text is *already* durable in the
sender's channel as the `notify` invocation's arguments (`contentType:
"invocation"` rows, `channel-chat-merge.ts:872`). The `publications[].summary`
excerpt exists so the collapsed row reads well offline, not as the record of
record.

Reducer work this implies (all new — `reducer-channel.ts:565` handles only
`external.participant_observed` today): fold `external.envelope_published`
into a `state.externalPublications` map and `external.envelope_observed` into
`state.externalObservations`, both keyed by `{channelId, envelopeId}`, then
project them in `channel-chat-merge.ts` alongside the existing fork/lifecycle
projectors.

#### 4.10.2 New chat row vocabulary

Four additions to the `contentType` × `kind` vocabulary
(`derived-types.ts:259`, dispatched in `MessageCard.tsx`):

| `contentType` | `kind` | Projector | Renders as |
|---|---|---|---|
| `cross-channel-sent` | `message` | `projectedPublicationToChatMessage` | §4.10.3 dispatch card, agent-side alignment |
| `cross-channel-received` | *(none — it is a real message)* | existing message projector + guest chip | §4.10.4 |
| `escalation` | *(none — a footer on its message)* | joined client-side from the inbox list | §4.10.5 |
| `messaging-error` | `system` | existing `diagnostic` projector, new subtype | §4.10.11 |

`cross-channel-received` is deliberately *not* a new row type: an incoming
guest envelope **is** an ordinary message in this channel and must render as
one, or the conversation stops reading like a conversation. It differs only by
the origin chip its `senderMetadata` earns it.

#### 4.10.3 Outgoing: the dispatch card

Projected from `external.envelope_published`. Collapsed by default:

```
┌────────────────────────────────────────────────────────────┐
│ ↗  news-agent → @gmail  in  #inbox-triage          14:22   │
│    "Can you extract the newsletter senders from the last…"  │
│    delivered · awaiting reply                    [Open ▸]   │
└────────────────────────────────────────────────────────────┘
```

- **Header line**: sender handle → addressee ref, then the target channel by
  *title* (from the §4.4 channel directory), never a raw id. The whole header
  is the affordance; `[Open ▸]` is its explicit twin for touch.
- **Body**: `publications[].summary`, one line, ellipsised. Expanding
  (chevron, or clicking the row) mounts the target channel's envelope — and
  any replies threaded under it — using the same `MessageList`, exactly as
  `SubagentRunCard` mounts a child transcript via `useChildTranscript`. A new
  `useForeignEnvelope(channelId, envelopeId)` hook is the read side; it
  observes, never copies.
- **Status line**, in order of what is known: `queued` → `delivered` →
  `read`/`replied`, sourced from the envelope's existing receipts
  (`AckBadge`'s `ReceiptState`, §4.10.6) — no new status vocabulary.
  `refused` states are §4.10.11.
- **Grouping**: consecutive dispatches from the same sender to the same target
  channel collapse into one row with a count (`InlineGroup.tsx` precedent) —
  "→ @gmail in #inbox-triage · 3 messages" — expanding lists them. A chatty
  agent must not be able to bury a human's conversation.
- **Alignment and weight**: agent-side alignment, `message-card-lifecycle`
  weight (the muted card `ForkRow` uses, `MessageCard.tsx:1101`). It is the
  agent's own speech, but it is *aside* from this conversation; it should read
  as marginalia, not as a turn.

`[Open ▸]` calls the shared `openChannel(channelId, {focusEnvelopeId})`
(§4.5.4) — the find-or-open flow already in `apps/shell/shell/client.ts:1185`,
which focuses an existing chat panel for that channel rather than opening a
second one.

#### 4.10.4 Incoming: the guest message

An ordinary message card, with two additions:

```
┌────────────────────────────────────────────────────────────┐
│ ◆ news-agent  ·  from #daily-news ▸            14:22       │
│ Can you extract the newsletter senders from the last 20     │
│ messages tagged "newsletters"?                              │
│                                                 [Reply]     │
└────────────────────────────────────────────────────────────┘
```

- **Guest chip** (`◆`) beside the sender name, distinguishing a participant
  who is *not* in this roster from one who is. Hovering it opens the existing
  `ParticipantBadgeMenu`, extended with the origin channel and the agent's
  directory `summary` (§4.4) — "who is this and why are they talking to us" is
  answerable without leaving the panel.
- **`from #channel ▸`** opens the origin channel via the same `openChannel`,
  focused on the authoring envelope — resolved through the
  `external.envelope_observed` back-pointer, which is why that event is
  written.
- Replies are ordinary channel messages with `replyTo` set; because the guest
  is not a roster member, the reply carries `to:[{participant: guest}]` and
  becomes a guest envelope in the *other* direction, producing a dispatch card
  (§4.10.3) in this channel and an ordinary message over there. The
  conversation is symmetric and both logs read completely.
- A guest message never renders as a system row and never renders inside
  another card. It is someone talking.

#### 4.10.5 Escalation footer

When a message escalated to a user (§4.5), its card carries a footer rather
than spawning a second row — the escalation is metadata on the envelope (D1),
so it renders as metadata on the message:

```
│ …content…                                                   │
│ ⤴ Gabriel · inbox · read 14:26                              │
```

- Rungs render as `inbox` / `interrupt` (the sender's declared intent) and the
  state as `sent` → `on device` → `read`, one line, muted.
- **Source of truth for the state is the notification record**, joined
  client-side by `data.envelopeId` against the user-notification list the
  shell already hydrates for invites (`shell/client.ts` invite path). No
  per-message query, no new subscription.
- For the *sending agent*, escalation state arrives as the ordinary read
  receipt (§4.10.6) — the agent does not get a second notification-shaped
  concept.

#### 4.10.6 Acknowledge-on-read is a read receipt (D16)

§4.5.4's acknowledgement and the chat panel's receipt badge are the same fact,
so they must be the same event. When a surface renders the envelope named by
`data.envelopeId`:

1. it emits the ordinary **read receipt** for that envelope (the existing
   `message.receipt` path behind `AckBadge`, `ReceiptState:"read"`), and
2. the Gad inbox entry acknowledges off that same receipt.

Consequences worth having: the notifying agent sees "read" through the
mechanism it already understands, which is precisely what §4.9's *"do not
re-notify what the recipient already acknowledged"* needs in order to be
followable; the `AckBadge` UI needs no new state; and there is exactly one
place where "the human has seen this" is decided.

#### 4.10.7 Chat header: the external conversations menu

The chat header gains a menu built from `state.externalPublications` +
`state.externalObservations` — modelled on `ForkSwitcher.tsx`, which already
solves "other channels related to this one, openable in a panel":

```
Conversations with…
  #inbox-triage      @gmail        3 sent · 1 reply   [Open]
  #daily-news        @news-agent   1 received         [Open]
```

It is absent when the maps are empty, so a single-channel workspace sees no
new chrome. This is the answer to "where did my agent talk to other agents" at
channel granularity; `discover_agents` (§4.7) answers it at workspace
granularity.

#### 4.10.8 Notification center entry

The durable record is the Gad entry from §4.5 step 3; the row renders it:

```
┌────────────────────────────────────────────────────────────┐
│ ◆ gmail-agent                                     14:26    │
│ Urgent: contract countersigned — action needed today        │
│ Sam replied to the lease thread and needs a signature by…   │
│ #inbox-triage                          [Reply]  [Dismiss]   │
└────────────────────────────────────────────────────────────┘
```

- Title from `notify`'s `title` (or first line); body is markdown-rendered
  (`MarkdownPreview`), clamped to three lines.
- The channel line names the conversation this belongs to, by title.
- **`[Reply]` opens the conversation surface** (§4.8) in place — the whole
  point of the escalation being an envelope. Tapping the body does the same;
  `[Dismiss]` acknowledges without opening.
- **Grouping**: entries group by sending agent instance, newest first, with a
  count when an agent has several — a background agent that reports twice
  before you look must not read as two unrelated interruptions.
- Only unacknowledged entries show by default; a "Show acknowledged" toggle
  reveals the rest, because the inbox is the durable record (§4.5) and the
  history is worth having.

#### 4.10.9 Toast and push

- **Toast** fires only at `alert:"interrupt"` and is a *mirror*, never the
  record: title + one clamped line + `[Open]`, auto-dismissing. It uses the
  surviving `NotificationClient` (D7) but is issued by the escalation path,
  not by agents.
- **Push** carries `{title, body, channelId, envelopeId, notificationId}`; the
  deep link opens the conversation surface on the phone, mounted from the same
  quickfire core (§4.8). `interrupt` sets the high-priority flag; `inbox` is an
  ordinary push.
- Both, on open, land on the envelope and therefore trigger §4.10.6 — one
  path, one acknowledgement, wherever the user happened to be.

#### 4.10.10 Provenance

Because every row above projects from a durable event, the walks work without
new provenance kinds: dispatch card → `external.envelope_published` → the
target envelope → the turn that authored it; guest message →
`external.envelope_observed` → the sending turn in the other channel;
notification entry → `data.envelopeId` → envelope → turn → intent. §8's
provenance test asserts the round trip in both directions across a channel
boundary.

#### 4.10.11 Failure and edge states

- **Refused delivery** (locked channel, D14; unknown addressee; hop cap) —
  rendered as a `messaging-error` diagnostic row *in the sender's channel*,
  reusing the existing diagnostic card (`MessageCard.tsx:588`), with the
  distinct text the resolver produced (§4.6). No dispatch card is projected,
  because nothing was published.
- **Hibernated target** — the dispatch card shows `queued` and settles to
  `delivered` when the target DO wakes; no spinner that implies liveness, no
  timeout (D5).
- **Deleted/archived target channel** — the card keeps its summary and the
  `[Open ▸]` affordance disables with "conversation no longer available"; the
  row never disappears, because it happened.
- **Retraction/edit of a guest envelope** — out of scope; guest envelopes are
  not editable in v1, and the tool description says so.
- **Empty summary** — the card falls back to the invocation record's content
  excerpt rather than rendering a blank body.

#### 4.10.12 Mobile parity and the noise budget

Mobile renders the same four presentations from the same projectors: dispatch
cards collapse harder (header + count only, tap to expand), the guest chip and
origin link survive, the notification center is the existing sheet, and the
conversation surface is the quickfire sheet (§4.8).

The noise budget, stated so it can be enforced in review: **an agent-to-agent
exchange must never cost a human more than one collapsed row per (target
channel, sender) run**. Anything chattier is a grouping bug in
§4.10.3/§4.10.8, not an acceptable consequence of agents talking.

## 5. Deletions and refactors register

| Item | Fate |
|---|---|
| `createSayTool` (`agent-worker-base.ts:330`) | deleted; `notify` replaces it |
| `send_to_subagent` | deleted; `notify to:"run:<id>"` (same prefix-match ergonomics, same steering semantics). Its description carries load-bearing prompt guidance — *"steering or new information… not to poll for progress"* — which must be absorbed into §4.9 etiquette and the `run:` example in the messaging skill, or steering quality regresses with the tool |
| `saliency:"say"` wire value | **unchanged and permanent** (D3, revised): the tool renames, the wire enum does not. `z.literal("say")` in `.strict()` schemas stays as-is |
| publish policy `say-only` | frozen accepted alias for `notify-only`; normalized on read, no manifest churn |
| `resolveMentionToUser` | kept, re-expressed as `resolveHandle(..., {kinds:["user"]})` (§4.2.1); its human-only contract is deliberate |
| news `notifyBriefingReady` + `news_briefings.notify` column | deleted; agent `notify`s the owner with an explicit rung — scheduled runs `alert:"inbox"`, manual "Brief me now" `alert:"none"`. The column goes because the flag reaches publish through the run, not because presence guesses it |
| shell invite-notification special-casing | generalized: inbox rendering + `openChannel(channelId, {focusEnvelopeId})` handle `agent.message` and `channel.invite` uniformly (§4.10.8) |
| `external.envelope_published` / `external.envelope_observed` | protocol kinds that exist and are ingested but have no writer and no reducer case — they become the inter-agent record (§4.10.1) |
| new chat components | `CrossChannelCard` (§4.10.3), guest chip on `ParticipantBadgeMenu` (§4.10.4), escalation footer on `MessageCard` (§4.10.5), `ExternalConversationsMenu` beside `ForkSwitcher` (§4.10.7), `useForeignEnvelope` hook beside `useChildTranscript` |
| `approvalPushBridge` | transport extracted into `notificationPushBridge`; approvals become one producer |
| `listChannelLogs` consumers | migrate to enriched channel directory |
| `subagent-prompt.ts` §"say" guidance | rewritten to `notify` vocabulary, incl. §4.9 etiquette and the reporting-expectations line |
| `agents` skill (`base/skills/agents/SKILL.md`) | rewritten (§6) |

`spawn/inspect/read/merge/cancel_subagent`, `complete`, `ask_user`,
`suspend_turn`, wake/respond/conversation policies: unchanged semantics.

## 6. Templates and skills

### 6.1 Base template skills

- **New `messaging` skill** (`skills/messaging/`): the canonical guide —
  addressee grammar with the seven kinds, the `none`/`inbox`/`interrupt` ladder
  with a worked example of each rung (and the rule that `interrupt` is for
  things a person would want to be pulled away from), the full §4.9 etiquette (notable circumstances only; reporting
  expectations govern; prefer addressed over broadcast; no ping cycles),
  discovery patterns, and worked examples
  (report milestone to parent; ping the gmail agent; escalate to owner's
  phone). `notify`'s tool description stays terse and links here.
- **`agents` skill rewrite**: keep `addAgentToChannel` lifecycle content; add
  the directory (instances now register), replace the multi-agent topology
  section's mention plumbing with `notify` addressing; document that the
  skill's existing per-channel instance key **is** the directory identity,
  now spelled `<handle>@<channelId>` (§4.4) and directly addressable.
- **`automations` skill**: add a "surfacing results" section — scheduled agent
  runs report via `notify` (owner, `alert:"inbox"`), which is what makes
  unattended runs land on phones; remove any implication that toasts are the
  proactive surface.
- **Touch-ups**: `subagent-prompt.ts` (say → notify, §4.9 etiquette, and a
  reporting-expectations line in the spawn task template),
  `workspace-dev/WORKERS.md` + `appdev/CAPABILITIES.md` references
  to notifications, `system-testing` scenario catalog gains messaging
  scenarios (§8).

### 6.2 News template

- Briefing publish → `notify` to `owner` with markdown TLDR (top headlines as
  the `title`, story list in `content`). The rung comes from the run's own
  trigger, which the worker already knows: scheduled/cold-start →
  `alert:"inbox"`; manual "Brief me now" → `alert:"none"` (the reader is in
  the panel that just ran it; the briefing lands in the channel as ever).
  Delete the toast and the `notify` column plumbing
  (`news-agent-worker.ts:454-491, 1483-1527`) — the trigger flag now travels
  as an argument through the run instead of round-tripping a schema column.
- The inbox deep link lands the user in the news channel with the briefing
  envelope focused — verify the news panel/chat handoff renders the briefing
  card there.
- Feed-error storms: aggregate into one `notify` (channel-only, no alert) per
  sync cycle rather than console noise.

### 6.3 Spectrolite template

- Coedit agent adopts `notify` for milestone/summary utterances (its handle
  etiquette prompt stays); long-running restructures report progress to the
  channel (`alert:"none"`) and completion with `alert:"inbox"`, so a user who
  tabbed away has the exact document conversation waiting — and, per §4.5.4, a
  user who never left sees the row retire itself on read.
- `agent-prompt.ts` gains the messaging skill's etiquette paragraph instead of
  its bespoke wording.

### 6.4 Google workspace template

- **Gmail triage escalation** (the headline win): triage classifies an
  important message → `notify` owner with `alert:"interrupt"` for
  urgent-class mail, `"inbox"` otherwise; markdown content carries sender,
  subject, one-line gist, and the deep link opens the gmail agent channel with
  the triage card. This finally gives triage an output.
- Sync errors / reauth needed: `notify` owner with the reconnect affordance
  (today this dies in logs; `ask_user`-style consent stays on the OAuth flow).
- `google-workspace` and `google-drive` SKILL.md: document the agent's
  handle, that it is directory-discoverable (`discover_agents "email"`), and
  how other agents should ping it (`notify to:"agent:gmail@<channelId>"`,
  e.g. news agent asking for newsletter extraction) — the first real
  agent-to-agent exemplar.

## 7. Phasing

Each phase lands green independently; order minimizes rework.

- **P1 — Protocol + tool core.** `AddresseeRef` + `resolveAddressee` in
  agentic-protocol; **`resolveHandle` generalization (§4.2.1)** — the one piece
  of P1 the draft mistook for existing code; `notify` replaces `say`
  (channel/`@handle`/participant/parent/run kinds); the `alert` ladder with
  `none`/`inbox` semantics wired as far as the envelope (rungs above are P3);
  `notify-only` publish policy with `say-only` alias; `send_to_subagent`
  deleted with its steering guidance relocated (§4.9); prompts updated.
  Explicitly **not** in P1: any saliency wire change (D3, revised — there
  isn't one). Tests: addressing unit tests beside `addressing.test.ts`;
  handle-collision and unknown-handle fail-closed; redrive dedup; subagent
  say-feed projection (`derived-types.ts:267` saliency filter) keeps working
  untouched.
- **P2 — Gad directory.** Tables + FTS + writers at the join/spawn/lifecycle
  choke points; `listAgentDirectory`/`searchAgentDirectory`/channel
  enrichment; `inspectChannelRoster`/`inspectAgentHealth` re-based;
  `list_addressees` + `discover_agents` tools. Tests: directory projection from
  replayed logs (fixture duplication gotcha: keep the WorkspaceDO schema test
  fixture in sync); FTS under both sql.js and workerd.
- **P3 — User escalation + conversation surface.** `agent.message`
  notification kind; the `inbox`/`interrupt` rungs end to end;
  **acknowledge-on-read (§4.5.4)** in every surface that renders a channel —
  chat panel, conversation surface, mobile sheet — which is the piece that
  replaces the cut presence gate and must not be deferred, or badges pile up;
  shell notification center per §4.10.8 (markdown, grouping by agent,
  show-acknowledged toggle) and the toast/push shapes of §4.10.9; the
  escalation footer (§4.10.5); quickfire-core **session-provider
  generalization** + `conversationFor` (§4.8) and shell/mobile mounting;
  generalized `openChannel` pop-out; mobile parity; `notificationPushBridge` on
  the host (approvals migrate onto it). Tests: e2e — background agent notify
  lands as inbox entry, opening it shows the ad-hoc conversation, an inline
  reply wakes exactly the notifying agent, pop-out reuses an existing chat
  panel rather than duplicating; push payload deep link; **ack-on-read**: a
  user with the channel already open sees the entry retire without acting, and
  the same notify with no open surface persists until opened.
- **P4 — Cross-channel / agent-to-agent.** Guest envelopes via external
  participant observation; **explicit `causality.agentHops` propagation
  including the Gad fan-out path (§4.6, D13)**; **locked-channel admission
  fail-closed (D14)**; `agent:` and `channel:` addressing incl. hibernated
  wake; user-not-in-channel invite-composition; **the §4.10 record and UI** —
  writers for `external.envelope_published`/`_observed`, the two reducer
  cases, the dispatch card with foreign-envelope expansion, the guest chip and
  origin link, the external conversations menu, and the `messaging-error`
  diagnostic states. Tests: two worker agents
  ping-pong across channels and the chain terminates at the *same* total hop
  count as a single-channel chain (the draft's bug: per-channel streaks would
  double it) — assert on the annotation value, not just on eventual
  termination; a three-channel ring terminates; guest envelope into a locked
  channel errors as closed-channel, not unknown-addressee; hibernated agent
  wakes and replies; directed-channel etiquette holds for guests.
- **P5 — Templates + skills.** §6 in full; base `messaging` skill; rewrite
  `agents` skill; news/spectrolite/gmail migrations; system-testing scenarios.
- **P6 — Sweep.** Delete register (§5) verified empty via grep; docs/catalog
  references updated; adversarial pass (§8).

## 8. Test focus & adversarial scenarios

- **No duplicate surfaces, stated per target:** a single notify produces
  exactly one envelope *per target channel*, one inbox entry *per addressed
  user*, ≤1 toast and ≤1 push per user — across redrives, since every id
  derives from the tool-call id plus its target (§4.3). A cross-channel `to:`
  list is explicitly *not* one envelope; the test asserts the expected set, not
  a count of one.
- **Loop safety, asserted on the count:** notify chains between agents across
  channels terminate at the hop cap, and the observed `agentHops` on the Nth
  envelope matches a single-channel chain of the same length. Termination
  alone is not evidence — a per-channel streak terminates too, just later
  (§4.6). Also: a notify to a `moderated` channel does not wake bystanders.
- **Fail-closed addressing:** unknown `@handle`/instance returns an error with
  suggestions; an ambiguous handle errors rather than picking; a bare
  `agent:<handle>` with no channel errors with candidates; never broadcasts
  (matches `ask_user`'s stance). Closed-channel refusal is distinguishable from
  unknown-addressee in the error text (D14).
- **Wake correctness:** `explicit`-wake supervisors wake on child notify and
  on nothing else; hibernated directory agents wake exactly once per envelope.
- **Ack-on-read (replaces the presence edge):** user with the channel open on
  desktop receives `alert:"inbox"` → the entry appears and retires on render,
  no lingering badge, and nothing about the *sending* decision differed; user
  detached → entry persists and the push deep link works (mobile smoke chain:
  dev-loop tests against the Base checkout, not the release). Redundant-push
  race is asserted benign: push already in flight when the desktop
  acknowledges leaves no unacknowledged state behind.
- **Provenance:** Q-style walk from an inbox entry → envelope → sending turn →
  intent works (the notification is a first-class provenance citizen because
  it is an envelope), and the cross-channel walk resolves in **both**
  directions — dispatch card → published record → foreign envelope → authoring
  turn, and guest message → observed back-pointer → the other channel's turn
  (§4.10.10).
- **Presentation (projector-level, cheap and worth having):** from a replayed
  two-channel log, `channel-chat-merge` emits exactly one dispatch row per
  publication and one ordinary message row per guest envelope — never a
  relayed copy of foreign content (D15); three dispatches to the same target
  collapse to one grouped row; an incoming guest envelope renders as a message
  with a guest chip, not as a system row; a refused delivery emits a
  `messaging-error` diagnostic and **no** dispatch row.
- **Noise budget (§4.10.12):** a scripted agent-to-agent exchange of N
  messages adds at most one collapsed row per (target channel, sender) run to
  the human's transcript. Assert the row count, not just the rendering.
- **Receipt unification:** opening a notification emits exactly one read
  receipt for its envelope, the inbox entry acknowledges off that receipt, and
  the sender's `AckBadge` shows `read` — one event, three consumers (D16).

## 9. Decisions (proposed; flag disagreement before P1)

- **D1 — Envelope-first.** No notification exists without its channel
  envelope; escalation is metadata. (Rejected alternative: a separate
  notification bus — would fork provenance and replay.)
- **D2 — One tool, string addressee grammar.** `notify` with `to:` refs beats
  a tool-per-audience (`notify_user`, `message_agent`, …): one mental model,
  one resolver, discovery output is directly addressable.
- **D3 — The saliency wire value never changes** (REVISED 2026-08-14). The
  draft had writers emit `"notify"` with readers normalizing `"say"`. That is
  not a one-line synonym: `schemas.ts:135,163` are `z.literal("say")` inside
  `.strict()` objects, so the new value fails validation on write and on
  replay until the literal widens *and* every reader ships —
  `agent-vessel.ts:7922` (the wake gate), `derived-types.ts:269`,
  `channel-chat-merge.ts:686`, `handlers.ts:374,453`,
  `linked-agent-worker.ts:1086`. The failure mode under base/release skew is an
  older vessel silently not waking on a child's message. The enum is internal
  and never user-visible, so the rename buys nothing that pays for that. The
  tool renames; the wire does not. Same reasoning retires the `say-only`
  policy-value rename to an accepted alias.
- **D4 — `ask_user` stays separate.** Question-and-block is a different
  contract than fire-and-continue; both share resolver + escalation.
- **D5 — No clock-driven state.** Directory status flips on lifecycle events;
  inbox entries acknowledge on open/dismiss; pending questions resolve on
  answer/withdrawal. `last_activity_at` is display-only.
- **D6 — Trusted workspace** (excepted by D14). Any agent may discover and
  message any agent or user; ownership determines *defaults* (`owner`), not
  permissions.
- **D7 — Toast API survives for UI feedback only.** Panels keep
  `NotificationClient`; agent-originated user contact goes through `notify`.
- **D8 — Escalation is explicit only** (RESOLVED 2026-08-14; tightened by
  D12). An untargeted `notify` is a pure channel message, always. User
  escalation happens exactly when a user is addressed (default rung `inbox`) or
  when `alert:"interrupt"` is set. The rungs are `none`/`inbox`/`interrupt`,
  named for recipient experience; there is no `auto` and no heuristic anywhere
  on the path.
- **D9 — Directory `summary` may use a model pass** (RESOLVED 2026-08-14).
  P2 ships the mechanical summary (last notify + title + task excerpt); a
  small rolling model pass to keep self-descriptions semantically useful is
  sanctioned and can land with or after P2 (natural home: the system-agent /
  watcher machinery's micro-session pattern).
- **D10 — DM channels deferred; the notification conversation surface is the
  DM-shaped UX** (RESOLVED 2026-08-14). No user↔agent DM channel type in this
  plan. The §4.8 quickfire-shared surface gives the user an ad-hoc
  conversation with the notifying agent on that agent's existing channel —
  inline reply, pop-out to the (potentially existing) chat panel. True DM
  channels, if ever needed, come via the multi-user plan's channel flows.
- **D11 — Restraint is prompted, not just capped** (RESOLVED 2026-08-14).
  §4.9 etiquette (notable circumstances only, expectation-governed reporting,
  steer-don't-poll, no ping cycles) ships in the same phases as the mechanics;
  the hop cap is a backstop, not the norm.
- **D12 — No presence-aware suppression; acknowledge on read instead**
  (RESOLVED 2026-08-14, revising the draft). Escalation never consults a guess
  about whether the user is watching. The three-rung ladder (§4.3) says what
  the sender wants; acknowledge-on-read (§4.5.4) cleans up the case the
  presence gate was aimed at, using an event that actually happened. Two
  reasons: a suppressed notification cannot be recovered when the guess was
  wrong, whereas a self-retiring one costs nothing when it was right; and the
  host presence services are deliberately channel-blind
  (`workspacePresenceService.ts:77`, INV-1), so the draft's version had no
  lawful home. If attendance is ever genuinely needed (to *downgrade* a rung,
  never to suppress), it is a userland channel fact — the channel DO knows who
  holds live delivery-bearing subscriptions — and a separate piece of work.
- **D13 — Cross-channel hops are stamped, not inherited** (RESOLVED
  2026-08-14). `agentHops` is a per-channel fold
  (`conversation-v1.ts:227-234`), so guest envelopes must carry
  `causality.agentHops` explicitly (the override at `:240`) or the cap widens
  by a factor of the cycle length. Tests assert the count, not termination
  (§8). The Gad fan-out path's missing `annotate` (`agent-vessel.ts:4110`) is
  a known hazard on this route and is P4 acceptance criteria.
- **D14 — Locked channels fail closed** (RESOLVED 2026-08-14). Guest envelopes
  run the same admission check as joins (`channel-do.ts:2120-2131`; policy
  immutable per `:4137`). This is the one exception to D6, and it is not a
  security posture — it is respecting an invariant the host initialized on
  purpose. The refusal is legible ("channel is closed") so an agent does not
  mistake it for a bad address and retry.
- **D15 — One canonical copy; references, not relayed transcripts**
  (RESOLVED 2026-08-14). A cross-channel utterance lives once, in the target
  channel's log. The sender's channel records
  `external.envelope_published` — a summary plus a pointer — and the UI
  expands it by *observing* the foreign channel, exactly as `SubagentRunCard`
  already treats child transcripts. Rejected alternative: mirroring content
  into both logs, which would double-count in provenance, drift on edit, and
  make "which one did I read" unanswerable. Nothing is lost: the sender's full
  text is already durable locally as the `notify` invocation's arguments.
- **D16 — Acknowledgement and read receipt are one event** (RESOLVED
  2026-08-14). Rendering a notification's envelope emits the ordinary read
  receipt; the inbox entry acknowledges off it. One decision point for "the
  human has seen this", reused by `AckBadge`, by the inbox, and by the
  notifying agent — which is what makes §4.9's "don't re-notify what was
  acknowledged" a followable instruction rather than a hope.
