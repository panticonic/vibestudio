# Command Overlay: Conversation Client

Status: draft for review
Date: 2026-08-14
Revised: 2026-08-14 — scope cut. Earlier drafts gave the overlay surface a live
RPC client and its own principal, to support `inline_ui`, `feedback_custom` and
`client_eval`. Dropping those three from this venue removes the entire identity
programme: the chrome keeps the RPC, and the fix shrinks to replacing one
hand-rolled join. The identity analysis is preserved in the appendix, because it
is the prerequisite if those features are ever wanted here.

---

## 1. Diagnosis

The overlay shares only the protocol *reducer* with the chat panel. Everything
below that is a parallel implementation:

| Concern | `panels/chat` | Command overlay |
|---|---|---|
| Join | `@workspace/agentic-core` connection | raw `connectViaRpc` (`apps/shell/shell/client.ts:1408`) |
| Replay | `replayMode: "stream"` + `replayMessageLimit` | `replayMode: "collect"` |
| Delivery | `deliveryMode`, resident event handler | default |
| Participant | descriptor + `methods` | none |
| Recovery | `recoveryCoordinator` | none |

The visible consequence: a conversation binds, `sessionFor` reports
`messageCount >= 1` (the message reaches the channel and is stored), the client's
`ready()` resolves — and the transcript stays empty forever, with no error
anywhere. Reproduced by `tests/e2e/flows/commandOverlay.spec.ts`.

The fix is to stop hand-rolling the join, not to re-architect the surface.

## 2. Scope: what this venue is for

The overlay agent has `panel_screenshot`, `panel_console`, `panel_eval`,
`panel_describe`, `read`/`edit`, `say`. It deliberately does **not** have
`inline_ui`, `feedback_custom` or `client_eval`.

That is quickfire's own stated scope (`docs/quickfire-overlay-spec.md` §1.4:
"look, explain, poke, small fix"), with promotion as the escape hatch — a
promoted chat panel is a full chat surface with every client feature. `panel_eval`
already covers the useful half of eval here: running code against the page the
user is looking at, over CDP. `client_eval` only ever meant the agent driving its
own chat surface.

Enforcement is structural, not advisory: client features are channel methods
advertised by the participant at join time, so an unadvertised method does not
exist for the agent. The prompt says so plainly rather than letting the model
discover it by failure.

## 3. Design

**The chrome keeps the RPC; the surface stays a view.** This is the spec's
existing division (§2.3: props in, opaque intents out, no RPC in the surface),
and nothing here challenges it.

**The chrome joins with the shared connection.** `@workspace/agentic-core`'s
connection is DOM-free and needs only what the chrome already has:

```ts
{ clientId, rpc: { call, stream, on, selfId }, protocol?, recoveryCoordinator?, replayMessageLimit? }
```

So `useQuickfireSession` swaps `connectViaRpc` for the same connection
`panels/chat` uses — stream replay, participant descriptor, delivery mode,
recovery — and keeps reducing into the transcript the surface renders.

**Not reusing `@workspace/agentic-chat`'s components.** They are built to drive
RPC through the chat context; rendering them from props alone would fight their
design and end in a bespoke path anyway. The overlay keeps its own compact
presentation — which also means the projection below is ours to fix cheaply.

## 4. Transcript presentation

**Order.** The overlay reads newest-first because its only input sits at the top
of the card. That belongs to the rendering layer; message grouping, streaming
attachment and tool/result adjacency assume chronological order underneath.

**Tool pills must carry state.** Today `projectTranscript`
(`packages/quickfire-core/src/transcript.ts:59`) collapses a turn's invocations
to a deduped list of *names*, which both clients render as flat chips
(`QuickfireSurface.tsx:402`, `QuickfireSheet.tsx:392`). So:

- a running, finished, failed and interrupted call look identical;
- five `panel_console` calls collapse into one chip;
- order and count are lost — it is a set, not a log.

That is the "I cannot tell whether the agent is doing anything" complaint, and it
is the projection lying by omission. The chat panel does not have this problem:
it renders actions through `ActionMessage`/`AckBadge`/`action-format`, which is
why a chat transcript shows `Read user_interrupted` where the overlay shows
`read`.

Fix: carry `status` (and error) per invocation instead of collapsing to names,
keep occurrences distinct, and render running/failed distinctly on both clients.
Small, local, and it gives the overlay a liveness signal without any identity
work.

## 5. Context invariants

Two things run in the **bound panel's** context:

- **The agent vessel** — already true: `sessionFor` creates it with `contextId`
  from `resolveSlotContext(slotId)`, so `read`/`edit` resolve at that panel's
  semantic working head.
- **The conversation's channel** — must be placed by the host at bind time.
  Placement goes to whoever activates the Durable Object first
  (`contextId = ref.contextId ?? …`, `src/server/index.ts:5700`); `contextPolicy:
  "initial"` only makes later resolvers accept an existing placement instead of
  throwing. Today the vessel subscribes first, so this holds by ordering luck.
  Pin it explicitly.

## 6. Staging

- **P1 — the join.** `useQuickfireSession` uses the `agentic-core` connection.
  Exit: the e2e transcript assertion passes
  (`tests/e2e/flows/commandOverlay.spec.ts`).
- **P2 — transcript.** Newest-first as a presentation option; invocation status
  carried through the projection and rendered on both clients (§4).
- **P3 — tools and prompt.** State plainly that this venue has no inline UI, no
  custom feedback and no client eval, and that promotion is where those live.
  Pin the channel's context placement (§5).

## 7. Evidence trail

- `tests/e2e/flows/commandOverlay.spec.ts` — drives the real app; asserts on the
  rendered transcript (not surface text) and on the workspace's own
  `quickfire.list`/`sessionFor` answer, which is how "the send works, delivery
  does not" was established.
- Defects fixed en route: ownerless agent vessel (403 → `runtime.createEntity`
  500), `subscribeChannel` refusing the host origin, missing
  `workspace-service:gad.workspace` in the harness manifest, the reviewed closure
  missing its own plumbing methods, and the revision-proposal path throwing
  instead of denying.

---

## Appendix — if the client features are ever wanted here

Reinstating `inline_ui`, `feedback_custom` or `client_eval` means putting a live
client in the surface, which forces an identity. The analysis, kept so it is not
re-derived:

- **The surface needs a principal.** Its preload exposes only the overlay bridge;
  a transport must be bound to some caller.
- **Not a new principal kind.** `PRINCIPAL_KIND_REGISTRY` is compile-time
  exhaustive over `CallerKind`; the ripple reaches auth, grants, membership,
  subject resolution, the dispatcher's runtime branches and the census. A chat
  panel is *also* a renderer hosting agent-authored code, and it is an ordinary
  `panel` whose trust comes from `panels/chat`'s manifest. **Trust class lives in
  the unit, not the kind.**
- **Not a panel principal.** Admission for `callerKind === "panel"` is gated
  unconditionally on a coordinator lease (`src/server/rpcServer.ts:1707`,
  `:1763`) and leases carry `slotId`. A grant-based bypass does not work:
  ordinary panels already authenticate by grant (`serverClient.openPanelSession`
  → `grantConnection`), so the rule would disable the gate for every panel. A
  slotless lease is viable but says "panel" for something with no slot, placement
  or navigation.
- **Its own app unit is the answer** — `apps/command-overlay` with a minimal
  manifest. An app view's code identity comes from the unit
  (`codeIdentityForView`), so rendering the surface from `apps/shell` would give
  agent-authored code that manifest: `members.remove` (critical),
  `storage.delete`, `runtime-state.manage` at prefix `""`.
  `PanelViewManager.createViewForApp` is generic — nothing consults `hostTargets`
  — so a non-host-target app is loadable.
- **App lifecycle, not per-view.** `AppHost.activateAppEntity` registers one
  entity per app activation, keyed by unit name with a context derived from
  `(workspaceId, "app", name, sourceRepo)`. The WebContents owns only a scoped
  connection; destroying the view closes the connection, it does not retire the
  entity. The human subject rides the connection grant (`rpcServer.ts:1576`), not
  entity lineage — app entities are deliberately shared and unsalted by user.
- **Concurrent surfaces need a delivery identity.** `PubSubChannel.subscribe`
  derives `deliveryId = callerPanelId ?? callerId` and keys subscription streams
  `(participantId, deliveryId)`, closing collisions. Panels differ per view;
  app-kind surfaces do not, so two overlay windows for the same user would evict
  each other. Fix by stamping a per-connection delivery identity for app callers.
- **Sharing with mobile needs a platform-neutral split.** `agentic-chat`'s hooks
  touch DOM in ~30 call sites across ~4,700 lines, clustered into six host
  capabilities (document title, colour scheme, persistence, lifecycle events,
  focus query, clipboard). `useScrollAnchor`, `useStickToBottom` and
  `useMentionAutocomplete` are genuinely presentational and stay DOM-side. The
  split is an adapter interface plus a subpath export, with an import-boundary
  check to keep it from rotting; the risk concentrates in `useAgenticChat.ts`
  (1,664 lines).
