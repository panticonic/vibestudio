# WP6 — Handles & Personalization (implementation spec)

Companion to `docs/multi-user-workspaces-plan.md` (§7) and `docs/multi-user-wp0-user-identity-spec.md`
(`User.{handle,displayName,avatarBlob,color}`; `UserSubject` on `VerifiedCaller`). Makes
account personalization **propagate to handles** in the agentic messaging system, replacing
the anonymous `@user` every human shares today.

Obeys the host-boundary invariants (`plan §0.1`): identity flows host→userland via the
verified `subject` on the connection (INV-3); the channel (userland) reads that subject —
the host does not reach into channels (INV-1).

---

## 1. Scope & exit criteria

> **Delivery (governed by plan Status):** part of a **single big-bang cutover** — not staged,
> no gates, no optionality, nothing deferred, **no legacy/compat left standing**. Every choice
> here is decided; the single-user structures it touches are deleted, not adapted.

**In scope:** account-derived channel handles; retire the hardcoded `@user`/"Chat Panel";
**principal-derived** (not client-asserted) handles as a data-hygiene/attribution fix — one
reliable identity per human, not an inter-user security wall (plan §0.0); stable `user:<userId>`
participant ids; live profile projection (mutable fields resolved, not frozen); a profile RPC;
end-to-end propagation of personalization.

**Out of scope:** adding *other* humans to channels (WP7); presence (WP8); the `User` store
itself (WP0).

**Exit criteria:**
1. Two humans in a channel show **distinct** account handles/display names, not two `@user`.
2. A client cannot spoof its handle — the channel stamps it from the verified subject.
3. A user has one **stable** participant id (`user:<userId>`) across their panels/devices.
4. Personalization (handle/displayName/avatar/color) set once on the account renders
   everywhere a human is named (roster, transcript, presence).

---

## 2. The core issue (investigation)

- The channel `"user"` `ParticipantKind` (`workspace/packages/agentic-protocol/events.ts:22-41`)
  and GAD `"user"` actor kind are **semantic roles** — "a human authored this" — **not
  accounts**. Account identity is a **distinct field** carried alongside; never conflate.
- Every human panel today joins **hardcoded** as `{name:"Chat Panel", type:"panel",
  handle:"user"}` (`workspace/packages/agentic-chat/hooks/useAgenticChat.ts:224`,
  `hooks/core/useChatCore.ts:267`), with an **ephemeral** participant id = the panel's
  `clientId` (`workspace/packages/pubsub/src/rpc-client.ts:178`). So `wergomat` and a teammate
  are both `@user`, and identity is unstable across panels.
- Handles are **client-asserted** at `subscribe` (`channel-do.ts:644-793` enforces only
  *uniqueness*), which becomes a spoofing surface the moment handles carry real identity.

---

## 3. Account-derived, principal-stamped handles

The fix is to **derive** the human's identity from the verified caller at the channel DO,
mirroring what `sendAsCaller` already does for authenticated callers
(`channel-do.ts:1021-1041`, `handle = caller.callerId`):

- On `subscribe`, when the caller is a human panel/shell, the channel DO reads the
  **host-verified `userId`** carried on the caller envelope (`AuthenticatedCaller.userId` /
  DO-dispatch envelope, threaded by **WP4 §2.4**) and stamps `id: user:<userId>`,
  `kind: "user"` — **ignoring** any client-supplied `metadata.handle`/`id`. The mutable profile
  fields (`handle`, `displayName`, `color`, `avatar`) are **resolved live** — not taken from
  the client and not frozen into the roster row — via the **host-projected identity read**
  (WP0 §3.7: the host reads the shared identity DB and passes the projected
  `{handle, displayName, color, avatar}` down to userland; userland never opens the DB itself,
  INV-2). This keeps one source of truth: a later profile edit re-renders everywhere without a
  roster rewrite. `UserSubject` itself carries only the *stable* `{userId, handle}` (WP0 §3.1);
  everything mutable comes from the live projection.
- **Why stamp from the verified id, not the client's assertion:** so a human's handle is a
  *reliable* attribution, not a self-declared label — this is data hygiene (one source of
  truth for who authored a message), **not** an inter-user security boundary (members are
  mutually trusted, plan §0.0). We simply don't want two members both showing as `@user`, or a
  typo'd handle, or identity that drifts between a person's panels.
- Agents/vessels keep supplying their own descriptor (they are not human accounts); their
  handles are unchanged.
- Uniqueness: the existing partial unique index on `participants(handle)`
  (`channel-do.ts:786-793`) still holds; a user's stable handle is unique server-wide (WP0),
  so no collision within a channel.

---

## 4. Stable `user:<userId>` participant id

- Replace the ephemeral panel-`clientId` participant id with **`user:<userId>`** for human
  participants. This makes a user one identity across all their panels/devices and is the key
  that WP8 channel-presence aggregation groups on.
- `participantKindFromMetadata` (`participant-ref.ts:227`) gains a **`user:` id-prefix →
  `user`** case (today an unprefixed id falls through to `external`).
- Multiple live panels of the same user share the `user:<userId>` identity in the roster
  (deduped/ref-counted), rather than N anonymous `@user` rows.

---

## 5. Client-side wiring

- **Retire the hardcoded identity.** `useAgenticChat.ts:224` and `useChatCore.ts:267` stop
  hardcoding `{handle:"user", name:"Chat Panel"}`; they pass through the account subject the
  connection already carries. `actorForClient` (`useAgenticChat.ts:91-99`) and
  `actorKindFromMetadata` (`:81`) resolve `kind:"user"` with the real handle/displayName.
- **Connection path.** `ConnectionManager.connect` (`workspace/packages/agentic-core/src/connection.ts:71-105`)
  no longer needs the client to assert a human handle — the channel derives it (§3). The
  client may still send a *panel* label for its own UI, but the authoritative participant
  identity is host-verified.

---

## 6. Personalization store & propagation

- **Source of truth = `User`** (WP0): `handle`, `displayName`, `avatarBlob` (blobstore
  digest), `color`.
- **Profile RPC:** `account.updateProfile({displayName, avatar, color})` (self, or root for
  others) — a **hub write** to the shared identity DB (the hub is the sole writer, WP0 §2).
  **Reads of any user's profile from inside a child go through the WP0 §3.7 shared identity DB**
  (the child opens it read-only: `identityDb.resolveUsers`), and the child **projects** the
  needed `{handle, displayName, color, avatar}` down to userland (userland never opens the DB
  — INV-2). Avatar resolves per **WP0 §3.8** (inline `data:` URI on the account row by default),
  not the per-workspace userland blobstore.
- **Propagation chain (one source, rendered everywhere):**
  ```
  User account ─▶ connection subject (host-verified)
              ─▶ channel roster participant {handle, displayName, id: user:<id>}
              ─▶ agentic.trajectory.v1 actor.displayName
              ─▶ GAD actor (metadata.userId; kind stays semantic)
              ─▶ presence (WP8), approval provenance resolvedBy (WP5)
  ```
- **Handle uniqueness scope: server-wide** (plan default) — a person keeps one identity across
  every workspace they belong to. Validated against `/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/` and the
  reserved set (`pubsub-channel/types.ts:17`, `{read,edit,write,grep,find,ls}`).

---

## 7. Testing

- **Distinct handles:** two humans subscribe to one channel; roster shows two distinct
  account handles/display names, each `kind:"user"`, id `user:<id>`.
- **Single source of truth (not anti-spoof):** a client subscribing with
  `metadata.handle:"root"` (not its own) is stamped with its **own** account identity from the
  verified `userId`; the asserted value is ignored — a data-hygiene guarantee, not an
  inter-user security boundary.
- **Live profile:** the roster stores `user:<userId>` + `kind`; handle/displayName/color/avatar
  render from the live host-projected read, so an `updateProfile` re-renders without rewriting
  roster rows.
- **Stability:** the same user opening a second panel appears as the **same**
  `user:<userId>` participant, not a new `@user`.
- **Kind mapping:** a `user:` id resolves to `participantKindFromMetadata === "user"`.
- **Propagation:** changing `displayName`/`color` via `updateProfile` updates the rendered
  handle in a live channel and in the transcript actor.
- **Semantic vs account:** a human message's GAD `actor.kind` remains the semantic role;
  `actor.metadata.userId` carries the account (no conflation).

---

## 8. File-change checklist

| File | Change |
|---|---|
| `workspace/workers/pubsub-channel/channel-do.ts` | `subscribe` stamps human `id:user:<userId>`/`kind:user` from the verified `AuthenticatedCaller.userId` (WP4 §2.4); mutable `handle`/`displayName`/`color`/`avatar` render from the live host-projected identity read (WP0 §3.7), not the roster row; ignore client-asserted identity for humans |
| `workspace/packages/agentic-protocol/participant-ref.ts` | `user:` id-prefix → `user` kind (`:227`); `status`/`avatar`/`color` whitelist prep (shared w/ WP8, `:17-26`) |
| `workspace/packages/agentic-chat/hooks/useAgenticChat.ts`, `hooks/core/useChatCore.ts` | retire hardcoded `@user`/"Chat Panel"; pass account subject |
| `workspace/packages/agentic-core/src/connection.ts` | stop asserting human handle; rely on host-verified subject |
| `workspace/packages/pubsub/src/rpc-client.ts` | human participant id = `user:<userId>` |
| `packages/shared/src/users/*` (WP0) | `account.getProfile`/`updateProfile` RPC surface |
| shell chat components | render avatar/color from profile |

---

## 9. Decisions (resolved — nothing deferred)

1. **Handle uniqueness is server-wide** — a person keeps one identity across every workspace
   they belong to (plan §13). Not per-workspace.
2. **Avatar delivery: inline `data:` URI on the account row** (WP0 §3.8). No hub-owned blob
   store.
3. **Agent handles keep the agent's own identity** — an agent's display name does not fold in
   its owning user; ownership shows via attribution/provenance, not the handle.
