# Authority Domain Vocabulary

Status: specification (companion to
[../agentic-authority-negotiation-plan.md](../agentic-authority-negotiation-plan.md))

Date: 2026-07-24

This document defines the **user-facing authority vocabulary**: the small set
of domains and verb classes in which every permission decision in Vibestudio is
presented — at install review, on just-in-time approval cards, in mission
charters, and on the Permissions page. It also defines the mapping from the
reviewed semantic-capability layer into that vocabulary, and the rules that
make the mapping a trust boundary.

Related documents:

- [agent-authority-profile.md](agent-authority-profile.md) — the per-agent
  profile built from this vocabulary.
- [approval-ux-copy.md](approval-ux-copy.md) — exact user-facing strings.
- [mission-governance-ux.md](mission-governance-ux.md) — unattended-work
  review flows in this vocabulary.

## 1. Design rules

1. **Three levels, one direction.** Concrete operations (wire methods +
   resources) map to semantic capabilities; semantic capabilities map to
   exactly one domain and one verb class. Users see domains and verbs;
   policy is written in capabilities; enforcement happens on concrete
   operations. Information flows *up* for display only.
2. **The domain is never a grant key.** No *positive* authority — grant,
   ceiling, or mission exposure — is ever stored, matched, or evaluated at
   domain granularity. Grants remain `(capability, concrete resource,
   principal, scope)` records. (This is the Android "Storage permission"
   lesson: a comprehension group that becomes a grant unit silently
   over-grants.) **Deny-only records are the one deliberate exception**: a
   user's cell-level "Never" is stored as a domain×verb lock
   ([agent-authority-profile.md](agent-authority-profile.md) §2.2) so that
   capabilities added to the cell later are automatically covered. Widening
   a denial by domain fails closed and matches user intent; widening a
   grant by domain fails open and is forbidden.
3. **Categorization is reviewed copy, not runtime inference.** The
   capability → (domain, verb) assignment lives in a static, type-checked,
   ledger-audited table. Nothing at runtime — not the agent, not a model,
   not a heuristic over method names — may choose or alter the domain a
   request displays under. A miscategorized capability is a security defect
   of the same class as wrong prompt copy.
4. **Every promptable capability is categorized.** A gated or critical
   capability without a domain/verb assignment fails typecheck and fails the
   authority-ledger audit. There is no "miscellaneous" domain.
5. **Users learn the vocabulary once.** The same domain names, icons, and
   verb labels appear in every surface. No surface introduces synonyms.

## 2. The domains

Eight domains, named after things the user owns or cares about — never after
system components. Stable ids are lowercase slugs; user labels are the only
strings users see.

| Id | User label | One-line description (shown in UI) |
| --- | --- | --- |
| `files` | **Your files & work** | Documents, code, and project content in your workspace |
| `sharing` | **Publishing & sending** | Anything that leaves your workspace: publishing, sending, posting |
| `accounts` | **Accounts & sign-ins** | Connected accounts, passwords, and credentials |
| `web` | **The web** | Browsing data, websites, downloads |
| `automation` | **Apps & automation** | Installing, running, and scheduling apps and agents |
| `people` | **People & devices** | Workspace members, presence, and paired devices |
| `computer` | **This computer** | The Vibestudio application and the machine it runs on |
| `safety` | **Safety controls** | Approvals, permissions, and audit — the controls themselves |

Notes:

- **`sharing` is the highest-anxiety domain** and is deliberately separated
  from `files`. Reading and editing your own content is routine; content
  *leaving* the workspace (publish, send, open externally, webhook out,
  push notification to others) is the moment users most want to control.
  Categorization reviews must treat any capability with egress semantics as
  `sharing`, even when its API surface looks file-like.
- **`safety` exists to be visibly locked.** Capabilities in this domain
  (deciding approvals, revoking permissions, changing trust policy, mission
  governance, audit access) are never admissible to evaluated agent code:
  their receiver contracts do not admit `session` principals. The domain
  still appears in every per-agent view, permanently padlocked, so users can
  *see* that agents structurally cannot grant themselves permissions. This is
  presentation of an enforcement fact, not a revocable setting.
- **Future domains.** `money` (payments, purchases) is reserved for when the
  platform gains such capabilities; do not fold money-adjacent capabilities
  into `sharing`. Domain additions are a reviewed vocabulary change (§6).

## 3. The verb classes

Every capability carries exactly one verb class:

| Id | User label | Meaning | Examples |
| --- | --- | --- | --- |
| `see` | **See** | Read without changing anything | read browser history, list members, read logs |
| `act` | **Do** | Change, create, send, or delete things | publish, write bookmarks, install a dependency |
| `manage` | **Manage** | Change how things are set up or who has access | configure providers, manage members, change settings |

Rules:

- A capability whose method group mixes reads and writes is classed by its
  most consequential member (`act` over `see`, `manage` over `act`) — or,
  preferably, split into separate capabilities so the classes stay honest.
- `manage` is reserved for configuration/administration semantics. It is the
  verb users are most cautious about; do not dilute it with ordinary writes.
- Critical-tier capabilities keep their verb class; criticality is expressed
  by the confirmation flow, not by a special verb.

A **cell** is a (domain, verb) pair — e.g. *Publishing & sending / Do*. The
cell is the unit of comprehension in every per-agent view: "News can **see**
the web, **asks first** before **doing** anything in Publishing & sending."
Cells are display groupings only (rule 2 applies: never a grant key).

## 4. Sentence grammar

All user-facing authority sentences are generated from one grammar so every
surface sounds the same:

```
<Agent> <verb-phrase> <object-phrase> [<resource-phrase>] [<qualifier>]
```

- **Verb-phrase** comes from the capability's reviewed `action` copy (see
  `hostCapabilityPresentations.ts`), not from the verb class. The verb class
  organizes; the action copy communicates. Example: capability `git.publish`
  → action "publish to a repository", class `act`, domain `sharing`.
- **Resource-phrase** is derived from the concrete resource by the
  receiver's reviewed resource presentation (e.g. repository name, website
  origin, file path prefix). Raw identifiers (object keys, digests, DO ids)
  never appear in primary copy.
- **Qualifier** carries lineage and reversibility flags ("using content from
  outside your workspace", "this can't be undone").

The full string inventory is in [approval-ux-copy.md](approval-ux-copy.md).

## 5. The capability census

This section assigns every current semantic capability. It is the seed of the
authoritative table that will live next to `hostMethodCapabilities.ts` (as
`capabilityDomains.ts`) and be enforced by typecheck plus the ledger audit;
this document is the reviewed source it is generated from. Capabilities added
later must be assigned here first.

Legend: domain / verb. `⛔` marks capabilities whose receivers must **never
admit `session` principals** (structurally unavailable to evaluated agent
code — most of `safety`, plus infra-only entries).

### Your files & work (`files`)

| Capability | Verb | Action copy (draft) |
| --- | --- | --- |
| `workspaces.read` | see | look at a workspace |
| `workspaces.open` | act | open a workspace |
| `context.clone` | act | make a working copy of project content |
| `context.materialize` | act | check out project content |
| `context.relationships.record` | act | record how project versions relate |
| `git.pull` | act | bring in updates from a repository |
| `git.project.import` | act | import a project |
| `workspace.storage.materialize` | act | unpack stored project files |
| `workspace.storage.delete` | act | delete stored project files |
| `blobstore.delete` | act | delete stored files |
| `workspace.graph.delete` | act | delete project history records |

Reading project content through open read methods is ungated and does not
prompt; it still displays under this domain in profile summaries ("can see
your files") so the picture is complete.

### Publishing & sending (`sharing`)

| Capability | Verb | Action copy (draft) |
| --- | --- | --- |
| `git.publish` | act | publish to a repository |
| `git.remotes.manage` | manage | change where a project publishes to |
| `external.open` | act | open something outside Vibestudio |
| `push.send` | act | send a notification to your devices |
| `webhooks.manage` | manage | set up connections that send data out |
| `channel.admin` | manage | manage a conversation channel |
| `channel.archive` | act | archive a conversation channel |

Egress rule: any future capability that transmits workspace content to a
destination outside the workspace belongs here, regardless of its API family.

### Accounts & sign-ins (`accounts`)

| Capability | Verb | Action copy (draft) |
| --- | --- | --- |
| `accounts.connect` | manage | connect an account |
| `accounts.disconnect` | manage | disconnect an account |
| `account-providers.configure` | manage | set up a sign-in provider |
| `account-providers.delete` | manage | remove a sign-in provider |
| `account.profile.read` | see | see your profile |
| `account.profile.update` | act | change your profile |
| `credential.use` | act | use a saved sign-in |
| `credentials.connect` | manage | save a new sign-in |
| `credentials.audit.read` | see | see how saved sign-ins were used |
| `agent.credentials.manage` | manage | create or revoke an agent's credential |
| `browser-passwords.read` | see | see saved website passwords |
| `browser-passwords.manage` | manage | change saved website passwords |
| `browser-passwords.delete` | act | delete a saved website password |
| `protected-input.submit` | act | fill in a protected field |
| `browser-form-fill.manage` | act | fill a form with saved details |

`browser-passwords.*` sits here, not in `web`: the object of anxiety is the
credential, not the browsing.

### The web (`web`)

| Capability | Verb | Action copy (draft) |
| --- | --- | --- |
| `browser-data.read` | see | see your browsing data |
| `browser-data.write` | act | change your browsing data |
| `browser-data.delete` | act | delete browsing data |
| `network.response.read` | see | read a website's response |
| `gateway.fetch` | see | fetch from the web |
| `workspace.gateway.access` | see | reach the web through the workspace gateway |
| `adblock.manage` | manage | change ad-blocking settings |

### Apps & automation (`automation`)

| Capability | Verb | Action copy (draft) |
| --- | --- | --- |
| `workspace-units.manage` | manage | install, update, or remove apps |
| `workspace-units.publish` | act | publish an app version |
| `workspace.units.restart` | act | restart an app |
| `workspace.units.rollback` | act | roll an app back to an earlier version |
| `workspace-panels.manage` | manage | add or remove panels |
| `workspace.runtime-state.manage` | act | rearrange panels and views |
| `automations.register` | manage | set up an automation |
| `automations.control` | act | start or stop an automation |
| `subagents.create` | act | start a helper agent |
| `runtime.code-execution.manage` | act | run code in the workspace |
| `code-runner.reset` | act | reset the code runner |
| `eval.reset` | act | reset a code-execution session |
| `workspaces.create` | act | create a workspace |
| `workspaces.delete` | act | delete a workspace |
| `workspace.configure` | manage | change workspace settings |
| `workspace.dependencies.inspect` | see | look at installed dependencies |
| `workspace.dependencies.install` | act | install dependencies |
| `workspace.build-cache.manage` | act | clear or rebuild build caches |
| `workspace.heartbeats.pause` | act | pause background activity |
| `workspace.heartbeats.resume` | act | resume background activity |
| `workspace-service:<name>` | (declared) | (declared by the service, see §5.9) |

`subagents.create` is the confused-deputy pivot; its card copy must always
name what the helper will be able to do (inherited profile, see
[agent-authority-profile.md](agent-authority-profile.md) §7).

### People & devices (`people`)

| Capability | Verb | Action copy (draft) |
| --- | --- | --- |
| `workspace.members.read` | see | see who is in the workspace |
| `workspace.members.manage` | manage | change members' roles |
| `workspace.members.remove` | manage | remove a member |
| `users.revoke` | manage | revoke a user's access |
| `channel.members.remove` | manage | remove someone from a conversation |
| `presence.read` | see | see who is active |
| `panel.presence.read` | see | see who is viewing a panel |
| `panel.presence.update` | act | update your presence on a panel |
| `devices.read` | see | see paired devices |
| `devices.pair` | manage | pair a new device |
| `devices.revoke` | manage | unpair a device |
| `mobile.devices.read` | see | see paired phones and tablets |
| `mobile.pair` | manage | pair a phone or tablet |
| `mobile.install` | act | install to a paired phone or tablet |
| `remote-client.read` | see | see remote connections |
| `remote-client.connect` | manage | set up a remote connection |
| `remote-client.clear` | manage | remove a remote connection |
| `push.register` / `push.unregister` | manage | register this device for notifications |
| `push.manage` | manage | manage notification delivery |

### This computer (`computer`)

| Capability | Verb | Action copy (draft) |
| --- | --- | --- |
| `application.update` | act | install a Vibestudio update |
| `application.shutdown` | act | shut Vibestudio down |
| `settings.read` | see | see app settings |
| `server-logs.read` | see | read server logs |
| `runtime.inspect` | see | inspect running code |
| `panel.inspect` | see | inspect a panel |
| `extensions.reload` | act | reload an extension |
| `extensions.diagnose` | see | diagnose an extension |
| `workspace-host.manage` | manage | manage the workspace host |
| `connections.approve` | ⛔ manage | approve a new connection |

### Safety controls (`safety`) — structurally locked

Every capability below is `⛔`, and for this domain the exclusion is
two-fold: receiver contracts must admit **neither `session` principals nor
userland `code` principals** — evaluated agent code cannot request them, and
installed panels/workers/apps cannot declare them in a manifest. Only host
and shell surfaces reach these operations. This is the enforcement predicate
behind the user-facing sentence "no agent or app can ask for these"
([approval-ux-copy.md](approval-ux-copy.md) §8): the copy claims exactly
what the ledger audit verifies, no more. The Permissions page shows this
domain padlocked.

| Capability | Verb | Why locked |
| --- | --- | --- |
| `approvals.read` / `approvals.decide` / `approvals.block` | manage | an agent must never answer or suppress its own prompts |
| `user-approval.request` | act | prompt creation is host-mediated, not a grantable effect (see note) |
| `user-approval.revoke` | manage | revoking consent is a human act |
| `permissions.list` / `permissions.read` / `permissions.revoke` | manage | the policy surface belongs to the user |
| `governance.read` / `governance.list` | see | mission governance is human-only |
| `mission.requestReview/edit/pause/resume/retire` (and `missions.*`) | manage | charter changes require human review; approval itself is a human queue decision, not an RPC capability |
| `content.trust.policy.manage` / `content.trust.vouch` | manage | trust policy must not be self-modifiable |
| `security.audit.read` / `audit.query` | see | audit is the user's record of the agent, not vice versa |
| `credentials.audit` | see | as above |

Note on `user-approval.request`: agents cause approval requests implicitly by
attempting operations; the *direct* request-a-prompt capability remains
host/panel-side so agents cannot manufacture arbitrary consent dialogs with
attacker-controlled copy.

### Infra-only capabilities (no domain)

A small set is `⛔` infra-plumbing that never renders in user surfaces and
must never be promptable: `workspace-state.*` (slot/panel/entity/heartbeat
records), `context.boundary`, `tier`, `open`, `build.gc`/`build.recompute`
internals not already grouped above. The audit must verify each is closed to
userland principals rather than categorized. If one of these ever becomes
promptable, that is a categorization review, not a default.

### 5.9 Dynamic workspace services (`workspace-service:<name>`)

Workspace-defined services declare their own methods, so their capabilities
cannot appear in the static census. Their categorization is therefore
**untrusted-author, not untrusted-runtime**, and the rules below keep that
distinction honest:

1. **Sealed and ratified, never request-time.** A workspace service's
   domain/verb/copy declaration is part of its unit's sealed version and is
   shown (as declared rows) in that unit's version review. It cannot vary
   per request, per caller, or after activation. A declaration change is a
   version change.
2. A declaration **must** include, per gated method: a domain id from §2, a
   verb class from §3, and action copy meeting the copy rules
   ([approval-ux-copy.md](approval-ux-copy.md) §2). Missing or invalid
   declarations make the method non-promptable (receiver-rejected with a
   developer repair packet) — never "default domain".
3. **Attributed categorization.** For workspace-service capabilities, the
   domain chip renders with declared-by provenance (`{domain} · declared by
   {unit}`) and the declared copy renders inside the framed userland area;
   the agent identity, resource phrase, and scope choices remain
   host-rendered. Host-census categorization and third-party categorization
   are never visually identical.
4. **A categorization lie cannot manufacture egress.** A service that
   declares a method `files`/`see` but internally sends data out needs
   `sharing`/network capabilities in its *own* manifest, which its own
   version review displays and its own grants bound. Miscategorization is
   still a defect (and version review is where it is caught), but it cannot
   widen enforcement.
5. Stricter standing-grant default, keyed to **manifest-visible authority,
   not self-declared domain**: if the service's own manifest requests any
   `sharing`, `accounts`, or network-egress capability, no "always" scope
   is offered for its methods until the user has approved the same
   (capability, resource) at least twice
   ([agent-authority-profile.md](agent-authority-profile.md) §5.4). Keying
   off the manifest closes the "declare yourself files/see to skip the
   cooldown" bypass.
6. `workspace-service:*` (the wildcard) is not a capability and cannot be
   declared, requested, or granted. It exists today only inside eval
   ceilings, which this plan deletes.
7. `safety` may not be declared by a workspace service.

## 6. Change control — the trust boundary

The mapping is security-relevant copy. Controls:

- **Single source.** `packages/shared/src/authority/capabilityDomains.ts`
  exports `CAPABILITY_DOMAINS: Record<SemanticCapability, { domain, verb }>`.
  Typecheck fails if any promptable capability lacks an entry (same pattern
  as `HOST_CAPABILITY_PRESENTATIONS`).
- **Ledger audit.** The authority-ledger generator joins rows to domains and
  fails on: unmapped promptable capability; `safety`-domain capability whose
  receiver admits `session` or userland `code` principals; egress-flagged
  receiver mapped outside `sharing`; infra capability that is promptable.
- **Review requirement.** Changes to `capabilityDomains.ts`, domain labels,
  or verb labels require the same review bar as prompt copy. Moving a
  capability *to a lower-anxiety domain* (e.g. out of `sharing`) must be
  called out explicitly in review.
- **Runtime immutability.** The mapping ships in the host build. No RPC,
  setting, manifest, or agent output can override it. Card rendering reads
  the mapping by capability id; it never accepts a domain from the request
  payload.
- **Localization.** Domain and verb labels localize as a set; ids never
  change. A locale missing a domain label fails the copy audit.

## 7. What this vocabulary must never do

- Become a grant key, matching rule, or ceiling (§1 rule 2).
- Gain an "other/misc" domain.
- Grow past ~10 domains. If a proposed capability doesn't fit, the pressure
  is on the capability's design, not on the vocabulary. New domains need a
  product-level review, not a PR-level one.
- Be extended, reordered, or relabeled by workspace code, manifests, or
  agent output.
- Appear in developer-facing error copy as a substitute for the precise
  capability/receiver diagnostics (developers get capabilities; users get
  domains).
