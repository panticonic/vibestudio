# WP7 — Adding Human Users to Channels (implementation spec)

Companion to `docs/multi-user-workspaces-plan.md` (§8) and `docs/multi-user-wp6-handles-personalization.md`
(stable `user:<userId>` ids + principal-derived handles). Lets humans be **added to channels
as first-class participants** and makes agent ask-user routing **multi-human aware**.

Obeys the host-boundary invariants (`plan §0.1`): channels are userland
(`workspace/workers/pubsub-channel`); this is **entirely a userland-layer change** — the
host must never learn about channels (INV-1). It uses the `userId` the host passes down
(INV-3) but never has the host reach into channels.

---

## 1. Scope & exit criteria

> **Delivery (governed by plan Status):** part of a **single big-bang cutover** — not staged,
> no gates, no optionality, nothing deferred, **no legacy/compat left standing**. Every choice
> here is decided; the single-user structures it touches are deleted, not adapted.

**In scope:** a lightweight per-channel member list (invite/notify, not a hard ACL wall); a
**durable offline invite inbox** so an added user learns of it on next connect even if offline
(§7); mention/target-aware `ask_user`; confirmation that humans don't collide in the tool
namespace; workspace-membership check for who may be added.

**Out of scope:** the human participant identity itself (WP6); presence (WP8); channel
_creation_/context binding (unchanged).

**Exit criteria:**

1. Any workspace member can add another member (`@alice`) to a channel; Alice's clients
   surface the invite / auto-subscribe; she joins as `kind:"user"`, id `user:<id>`.
2. An agent can address `ask_user` to a **specific** human by handle, falling back to
   all-humans when unaddressed.
3. Adding humans requires no host knowledge of channels and no change to the channel-tools
   bare-method namespace.

---

## 2. Why this is mostly additive (investigation)

- `"user"` is already a valid `ParticipantKind`; a human is already a legitimate roster
  participant (`channel-do.ts` participants table `:251`, subscribe `:644`). WP6 gives humans
  a stable `user:<userId>` id and account handle. So "a human is in a channel" already works;
  what's missing is **membership/invite** and **multi-human routing**.
- A channel is bound to one context on first subscribe (`channel-do.ts:518-526`); within a
  workspace users are mutually trusted, so channel membership is about **notification and
  roster visibility**, not a hard access wall.

---

## 3. Channel membership / invite

A lightweight member list layered on the existing roster (userland, in the channel DO):

```ts
// channel-do.ts — new local table (userland DO SQL)
CREATE TABLE IF NOT EXISTS channel_members (
  user_id    TEXT PRIMARY KEY,   -- user:<userId>
  handle     TEXT NOT NULL,
  added_by   TEXT NOT NULL,      -- user:<userId>
  added_at   INTEGER NOT NULL
);
```

- **`channel.addMember({ userId })`** (userland RPC on the channel): records membership and
  emits a `presence`-style notify envelope (reuse `publishPresenceEvent`,
  `channel-do.ts:592-615`) addressed to the added user. Distinct from _roster presence_ (a
  live connection) — membership persists whether or not the user is currently connected.
- **`channel.removeMember`**, **`channel.listMembers`** — symmetrical.
- **`channel_members` is a SEPARATE, durable table — deliberately not the live-participant
  roster.** The participants roster row is keyed by participant `id` as PRIMARY KEY, and
  re-subscribe **DELETEs then reinserts** that single row (`channel-do.ts:723/251`). If durable
  membership lived on the roster row, a reconnect would wipe it. Keeping `channel_members` in
  its own table means a member added while offline survives every reconnect and is the durable
  source of "who belongs to this channel," while the roster stays the ephemeral "who is
  connected right now."
- **Auto-subscribe:** when the added user's client sees the notify (via their own workspace
  connection), it may auto-subscribe or surface an invite chip. Roster membership on connect
  is unchanged (WP6 handles identity).
- **Revoke cascade:** on `revokeUser` (WP9 §6.5 step 5) the user's `channel_members` rows are
  pruned. Userland reacts to the account being revoked in the shared identity DB (which the
  child reads directly — no push protocol); nothing here re-litigates authority per message.

---

## 4. Authorization (userland, membership-based)

- Any **workspace member** may add any other **workspace member** to a channel in that
  workspace (mutual trust — attribution is recorded, but there is no per-user authorization
  wall, plan §0.0). The only check is _is the added user a member of this workspace?_ —
  answered via **WP0 §3.7**: the host (child) opens the **hub-owned shared identity DB
  read-only** and calls `MembershipStore.has(userId, workspaceId)` (WP2), which works even when
  the added user is **offline** (it reads the durable membership table, not a live roster). The
  host does **not** reach into the channel (INV-1); the channel consults membership through the
  projected result the host passes down (INV-2/INV-3), keyed by the verified caller's `userId`
  (WP4 §2.4). `workspaceId` here is the opaque stable id (WP2).
- This is a _who-belongs-to-the-workspace_ gate (the coarse entry boundary we keep), **not** a
  per-channel ACL — consistent with "no trust boundary inside a workspace."

---

## 5. Multi-human `ask_user`

Today `askUserPolicy` targets "the first `panel`/`user`"
(`workspace/packages/agent-loop/src/policies/index.ts:168-173`), which assumes a single
human. Make it target-aware:

- If the agent's `ask_user`/`feedback_form` names a **target** (a handle / `user:<id>` /
  `@mention`), route the feedback form to **that** user's participant.
- If **unaddressed**, fall back to broadcasting the prompt to **all human participants**
  (`ref.kind === "user"`), first-to-answer wins (or a policy-configurable quorum).
- Mentions in messages (`agentic.trajectory.v1` `to`/`mentions`) resolve against roster
  handles → `user:<id>`.

---

## 6. Tool-namespace non-collision

- `channelToolsPolicy` maps **bare method names → owning participant**, first advertiser wins
  (`agent-loop/src/policies/index.ts:33-44`). Humans advertise **no** callable methods, so
  they never enter that namespace — adding humans is purely additive there. Confirm in tests.
- The only live coupling was `askUserPolicy`'s single-user assumption (§5), now fixed.

---

## 7. Durable offline invite inbox

Adding a human must reach them even when they are **not currently connected** to the workspace
child. The durable membership row _is_ the inbox: `channel_members` persists in the channel DO
(userland) keyed by `user:<userId>`, independent of any live roster/session, so an invite
created while the invitee is offline **survives indefinitely** and is delivered on their next
connect — not a fire-and-forget event a disconnected user misses.

Delivery on (re)connect uses the generic userland notification inbox in the workspace GAD
store. Channel membership projects an idempotent `channel.invite:<channelId>` notification
into `user_notifications`; `listUserNotificationsForMe` keys the read exclusively from the
host-stamped caller account. Acknowledgement is a durable revision-aware tombstone, so a
lost producer retry cannot resurrect a dismissed notification while a genuinely newer
membership revision can surface again.

Online delivery is snapshot-plus-signal, never interval polling: the host routes an opaque
`user-notifications-changed` nudge to every live transport session for the verified account,
and desktop/mobile clients reconcile from GAD. Initial attach and reconnect also reconcile,
so an offline or dropped nudge cannot lose state. Notification content stays userland; the
host learns only that one account's inbox changed and never learns which channel exists
(INV-1).

Live nudge:

- while online, every device for the added user gets the account-targeted inbox-change event, and
- optionally an FCM push routed **per user** (WP4 §4) carrying only "you were added to a
  channel" metadata; channel content stays userland. The push path is host-owned and
  references the user/device, never the channel internals (INV-1/INV-2): the channel emits an
  intent that the userland notification layer turns into a per-user push request.

---

## 8. Testing

- **Add member:** member A adds member B to a channel; `channel_members` has B; B's client
  gets the notify and can subscribe; B joins as `user:<B>`, `kind:"user"`.
- **Offline invite inbox:** add member B while B is fully offline; B connects later and
  `listInvitesForMe` surfaces the channel invite; acknowledging it stops re-surfacing.
- **Non-member rejected:** adding a user who isn't a workspace member fails (membership check).
- **Targeted ask:** an agent `ask_user` addressed to `@bob` routes only to Bob; unaddressed
  broadcasts to all humans, first answer wins.
- **Namespace:** a channel with 2 humans + 2 agents resolves agent tool names unchanged;
  humans contribute no method names.
- **Boundary:** the channel-member + ask-user changes live entirely in userland;
  `pnpm check:host-boundary` stays green; no host file references the channel.

---

## 9. File-change checklist

| File                                                     | Change                                                                                                                                           |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `workspace/workers/pubsub-channel/channel-do.ts`         | `channel_members`; `addMember`/`removeMember`/`listMembers`; revisioned projection into the generic durable inbox (§7)                           |
| `workspace/packages/agent-loop/src/policies/index.ts`    | `askUserPolicy` target/mention-aware (`:168-173`); fallback broadcast-to-humans                                                                  |
| `workspace/packages/agentic-protocol/participant-ref.ts` | (from WP6) `user:` kind; mention→user resolution                                                                                                 |
| `workspace/packages/agentic-chat/*`                      | invite chip / auto-subscribe UI for "added to channel"                                                                                           |
| userland notification layer                              | GAD `user_notifications` snapshot + acknowledgement tombstones; opaque per-user live nudge through the host; no channel content in the host path |

---

## 10. Decisions (resolved — nothing deferred)

1. **Adding a user notifies with one-tap join** (the durable offline invite inbox surfaces the
   channel on their next connect); a direct @mention auto-opens the channel for the mentioned
   user.
2. **Call-group `ask_user` is first-answer-wins:** a prompt addressed to a group is delivered
   to all eligible members and the first answer resolves it for the group.
3. **A user may remove themselves from a channel;** history stays visible (mutual
   inspectability within the workspace).
