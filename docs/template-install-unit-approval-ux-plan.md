# Template Install and Unit Approval UX Plan

Status: implemented (2026-07-31). See §0.

This plan refines the template-install flow described by
[`official-template-repositories-plan.md`](official-template-repositories-plan.md)
and the installed-unit authority model in
[`capability-model-redesign.md`](capability-model-redesign.md). It supersedes
the all-or-nothing `unit-batch` startup experience. It does not change template
composition or repository split boundaries, and it does not change
`evaluateAuthority`. It does change two things around the evaluator: where
installed-code grants come from (§6.4) and how an unresolved review classifies
acquisition (U6).

## 0. Implementation status (2026-07-31)

**Landed: Phases A through E.** The plan is implemented.

- **Prerequisite — the code principal.** The grant subject for installed code is
  now `code:<repoPath>@<effectiveVersion>` (`authority/codePrincipal.ts`). The
  execution digest is its own authenticated field on the harness fact rather
  than being smuggled inside the principal, and `isCanonicalPrincipal` validates
  structure instead of asserting that versions are hashes. This is what lets
  clearance be minted at admission — before anything is built — and what stops a
  toolchain bump from silently retiring grants a user already gave.
- **Phase A.** Boot derives no review. `startupApproval()` is gone; the creation
  review is held in the new workspace immediately after it opens, behind the
  durable marker the ungated creation publication writes. It is not awaited by
  boot: the workspace opens, and the review sits inside it.
- **Phase B.** `UnitAdmissionStore` (origin, batch writes, retirement) replaces
  `UnitVersionApprovalStore`. `productAuthorityGrants` no longer synthesizes a
  grant for a declared request — admission grants nothing, and a declared
  request with no stored grant prompts. `unitClearanceGrants.ts` mints ordinary
  version-bound grants through the canonical store at admission, retires the
  outgoing version's in the same transaction, and never mints a row the review
  could not have offered. The `app`/`extension` bypass in `isCodeApproved` and
  the unconditional `grantCode` are deleted. `review-pending` (U6) is wired
  through the dispatcher: a unit whose review is open answers one recoverable
  `EREVIEWPENDING` instead of one acquisition entry per method.
- **Phase C.** `notability` is a required field on every reviewed capability and
  on `UserlandCapabilityDefinition`; `scripts/check-capability-notability.mjs`
  fails the build when the catalog names a capability the reviewed list does not
  cover. U7's rule is implemented in the build provider: a declared-authority
  change produces a row, an EV-only change is admitted by the accepting decision
  with no row of its own and is reported as a one-line count.
- **Phase D.** `unit-batch` is gone. `PendingUnitInstallReviewApproval` carries
  server-derived `InstallReviewPart`s; `shellApproval.resolveInstallReview`
  carries the typed acceptance and refuses any identity or row the review did
  not offer. The collection surface ships in the shell (`InstallReview.tsx`) and
  on mobile, the launch gate is rebuilt around origin (§7.6) in the bootstrap
  window, the host-targets section, and the terminal.
- **Phase E.** This section, `approval-prompt-ux-spec.md` §5.8b/§5.8c.

Cutover, not migration, as §1 requires: an older admission file is discarded
rather than read, and discarding it re-offers the creation review, which is the
decision that mints clearance honestly.

### 0.1 Corrections after review

A pass over the shipped implementation found the obligation and the gate both
resting on state that could not carry them, and the review surface built at the
wrong scale. All are fixed; each is worth stating because the mistake is easy to
repeat.

- **The creation review is derived from the parts, never from a marker.** The
  guard was `marker.isPending() || admissions.isEmpty()`. Neither holds for a
  workspace created before this change set: no marker was ever written, and
  seed-trusted host-build units are admitted *before* the guard runs, so the
  store is never empty. Every such workspace skipped the review entirely, left
  every panel and worker unadmitted, minted no clearance at all, and prompted at
  each use with no review anywhere to answer. `creationReview()` now answers
  "what is still owed?" directly, and it owes for a part **never reviewed at any
  version** — not one unadmitted at the current version. An effective version
  commits `dependencyEvs`, so a host upgrade moves every unit's EV at once;
  keyed on the version, the boot after any upgrade would greet the user with
  the whole workspace as a creation review, which is the card §5.4 and U7 exist
  to delete. A part whose EV moved has been reviewed, and what changed about it
  is `unitChangeApprovalForCommit`'s differential question.
- **U6 answers from the set actually under review.** Asking "is this version
  unadmitted?" instead swept in `apps/shell`, which is decided at the launch
  gate and is the only thing that can render the review — the workspace booted
  to `apps/shell is waiting on the review you already have open`. Client apps
  and host-target extensions are excluded outright, and once the owed set is
  known it is the whole answer.
- **The startup gate has one publication point.** `publishPending("startup")`
  ran inside the extension branch's background chain, so anything staged after
  it landed in a batch with no timer that nothing would ever publish. It now
  runs once, after both branches stage; the coordinator also latches a released
  trigger so a late arrival publishes itself rather than hanging forever.
- **The review is not an alarm.** Every install review carried a hazard triangle
  and, because the base ships extensions, a red danger frame — over `Welcome —
  here's what's in your workspace`. Adopting a root is `standard` tone with a
  neutral icon; a chosen template carrying native code is `caution`. The
  native-code sentence is unchanged and still unhidable (§7.2); only its volume
  moved.
- **Scale, ordering, and reach.** The review rendered inside the notification-
  shaped approval card with its accept action below all fifty-three parts,
  sorted alphabetically, its per-permission disclosure on a `div` that no
  keyboard could reach. It now has the §7.2 dialog with a persistent detail
  pane, one shared comparator that floats notable parts to the top on desktop
  and mobile, a kind filter beside the search, domain-grouped everyday rows on
  both, a real `button` for the disclosure, and its actions in the card's own
  footer.
- **`review-pending` reads as waiting, not failing.** The runtime raised the
  typed outcome and no surface consumed it. `authority/reviewPending.ts` reads
  it; the message names the review rather than the repo path of whichever part
  asked first; and the notification bar shows a calm line that clears itself
  when the review resolves, instead of an amber failure with a Retry that could
  only fail again.
- **§7.7 states where a permission came from.** Permissions now carries
  `Part of Vibestudio` / `Added with News 1.2.0` / `You allowed this when it was
  needed`, read from the admission record the review itself wrote, and no longer
  prints a 64-character effective version at a person. Templates lists its
  origin URL beside the version and part count.

Two judgment calls worth naming, both live and both dials rather than
mechanisms:

- **`rpc:` and `event:` are everyday and install-clearable.** Parts calling and
  hearing from other parts is the ordinary machinery of being a part here; the
  receiving part's own method policy remains the authorization floor. Treating
  them as unreviewed would have made a simple panel read like a threat and
  prompted on essentially every first use.
- **A receiver-declared capability is classified when its provider rides the
  same reviewed set.** The user is accepting the receiver and its declaration in
  one decision. The declaration stays a ceiling and a vocabulary: `admin` and
  `destructive` sensitivity, and the code-installation families, are reduced to
  contextual whatever tier the provider chose.

Open questions 1, 2, and 8 remain open by design and are unchanged. Question 3
is confirmed (no path lets a non-chrome caller publish through chrome).
Questions 4, 5, 6, 7, and 9 are closed: repair rows are selectable and default
to unchecked; `review-pending` is wired; an unrecognized capability degrades to
an unknown, contextual, headline row instead of breaking inspection; the
Phase A→D window is closed; the notability list exists and is enforced.

## 1. Design stance

Four constraints govern every decision below. They overrule the tidier-looking
alternative in several places, so they are stated first.

**UX first.** A workspace nobody can use is not secure, it is abandoned. Where a
stricter rule adds prompts without removing a real risk in a trusted family/team
workspace, the rule loses. Friction is spent on three things only: is this
blessed code or something edited five minutes ago; is this the dangerous surface
(credentials, external effects, destructive changes); can an agent recover from a
denial.

**No speculative narrowing.** Manifests declare broadly — `panels/chat` declares
17 requests, 16 of them `evidence: "intentional-broad"` at an empty prefix; the
14 About panels declare 6–15 each. This plan does not audit or narrow them. We
do not know which are load-bearing, and finding out costs more than we have. The
plan makes broad declarations _legible_; it does not make them smaller. No CI
ratchet, no justification field, no manifest edits.

**No migration, no compatibility.** This is pre-release software. Development
approval state is deleted at cutover. There is no backfill, no dual schema, no
legacy reader, and no accommodation of existing workspaces.

**Prefer deleting a feature to specifying it twice.** Where a mechanism turned
out to need enforcement in six places to be honest, it was cut rather than
half-built (U5).

## 2. Outcome

A template is a distributable collection of apps. It is not an authority
principal. Every executable unit is an independent app-like security principal
with its own manifest, exact code identity and effective version, declared
maximum authority, admission record, grants, and runtime attribution.

Three changes:

1. **Admission is recorded wherever code arrives.** It already rides protected
   publication. The gap is workspace creation, which lands the first snapshot and
   records nothing — that is what produces the startup card. Closing it deletes
   the card. No release concept, no new trust anchor.
2. **Admission stops implying blanket authority.** Admitting a unit mints
   ordinary version-bound grants for the part of its manifest that platform
   policy clears at install. The rest still prompts at use.
3. **One surface reviews every arrival of code, and the user can dial it.**
   Creating a workspace from any template, installing one, and updating one share
   the same components and the same decision. Every part is always installed;
   selection decides only what is pre-authorized versus what asks at use.
   Upgrades are differential — they show what _changed_ and say nothing about the
   rest.

Manifest declaration remains necessary but not sufficient:

```text
installed unit call
  = exact admitted unit version
  ∩ declared unit authority
  ∩ receiver-owned method policy
  ∩ applicable user grant
```

Eval is unchanged by this plan: it has no static manifest and receives no install
clearance.

## 3. Problems in the current system

The clean-state startup observed on 2026-07-30:

- one card presents 23 panels and 14 workers as a single all-or-nothing decision,
  all of them base units arriving at workspace creation;
- every row exposes implementation-oriented chips, and broad declarations make
  simple panels appear to manage credentials, agents, conversations, models,
  files, and publishing;
- dismissing it makes first use fall through into per-unit cards, because an
  unadmitted unit is not stopped — `grantCode: false` means its declared requests
  reach the evaluator with no grant, return `approval-required`, and each becomes
  an acquirable prompt (`serviceDispatcher.ts:1729`);
- the action says `Approve all`; there is no typed partial result;
- accepting it grants the _entire_ declared manifest of every unit: admission
  sets `caller.codeApproved` → `grantCode` → `productAuthorityGrants` synthesizes
  an allow for every declared request (`productAuthorityGrants.ts:54-67`,
  `src/server/index.ts:869`, `src/server/rpcServer.ts:3510`,
  `src/main/index.ts:1922`);
- `UnitBatchEntryKind` models neither Durable Objects nor providers.

The decision semantics are wrong, not the card size. And note what the fix is
_not_: those 37 units are base, arriving at creation. Letting the user pick among
them is a better-looking version of a question they have no basis to answer. The
template case is the opposite — foreign code, a real choice, worth building well.

## 4. Invariants

### U1. Units remain the authority principals

Template identity never appears in `evaluateAuthority()` as an authorizing
subject. A template cannot lend one unit's declaration or grant to another.
Provenance is displayed and audited — `Part of News, github.com/panticonic/news`
— while the
requester and grant subject remain the exact News Agent unit version.

### U2. Templates package, compose, and remove units

A template owns repository provenance, its immutable version, a collection of
unit declarations, composition and dependency metadata, descriptions, and one
atomic install/update/removal operation. It owns no permissions.

**Removal severs the relationship; it does not delete anything.**
`workspace-template-composition-plan.md` §U5 and the shipped `template.remove`
copy both say so — _"Its parts stay in your workspace and become yours to
manage."_ Removed parts keep their source, their admission, and their grants.
What ends is the live relationship: no more updates, and the parts are now the
user's to manage.

**Historical origin survives.** Current ownership and where something came from
are different facts. A removed part still reads `Originally installed from News
1.2.0` in its details and in grant explanations — the audit trail for why it
holds what it holds does not evaporate because the relationship ended.

The consequence is that **there is currently no way to get rid of a single
part**, or of a template's parts at all. That gap is real and is §14 open
question 1.

### U3. Declaration never grants authority by itself

The manifest describes the maximum a unit can request. Neither template
membership nor source inference creates a grant. Install clearance mints ordinary
grants through the canonical store, bounded by both the manifest and platform
policy. Static analysis may propose or audit; it never adds authority, admits
code, or writes a grant.

### U4. The platform owns the clearance and notability classifications

Unit authors do not decide whether their own effects clear at install (§6) or
count as notable (§10). Receivers still own their method policy — including
userland services, which declare tier, sensitivity, grant scopes, and
presentation in `UserlandCapabilityDefinition`. That declaration is a _ceiling and
a vocabulary_: a receiver may declare a method critical or restrict its
principals, and the platform may make a request more contextual or more prominent
than the receiver asked for, never less.

### U5. Selection controls clearance, not admission and not existence

Two different things are easy to conflate, so they are named once here and used
consistently everywhere else:

- **Admission** — this exact unit version was reviewed and accepted. Every unit
  an accepted operation lands is admitted, selected or not.
- **Clearance** — a standing grant, minted at admission, for the part of the
  manifest platform policy allows to be pre-authorized.

**Selection withholds clearance. It never withholds admission.** A unit with no
clearance grant still runs; its declared gated requests evaluate to
`approval-required`, which the dispatcher classifies as acquirable
(`serviceDispatcher.ts:1729`), so the ordinary prompt appears the first time the
code actually needs the thing.

That is the mechanism selection uses, and it is why selection is meaningful
without any new machinery:

> **Selecting a part or a permission means "allow this now." Deselecting it means
> "ask me when it's needed."** Nothing is disabled, nothing is withheld from the
> workspace, and no lifecycle state exists to get out of sync.

Deselection therefore costs nothing to enforce. The prompt path is the system's
normal behavior; choosing not to pre-authorize is choosing the default.

What selection deliberately does **not** do is stop a part from existing or
running. Two adjacent needs are out of its scope and are met elsewhere:

- _"I don't want to see it"_ — panel-list and launcher curation, an ordinary UI
  preference with no authority meaning;
- _"I don't want it running at all"_ — for scheduled and unattended agents this
  is the mission machinery's pause, not a unit-level flag.

An honest unit-level "off" would need enforcement in at least six independent
start paths — `appHost.ts`, `workerdManager.ts` (including its persisted-image
restore path), `panelRuntimeRegistration.ts`,
`packages/extension-host/src/service.ts`, `recurringRegistry.ts`, and the
`singletonObjects`/`services` parse at `src/server/index.ts:516` — and a
half-enforced one is a UI that lies. This plan does not build it.

### U6. Pending review suppresses acquisition explicitly

Because non-admission produces prompts rather than silence, "no prompt spam"
needs a mechanism. While a review covering unit U is unresolved, U's
`approval-required` leaves are marked **not acquirable** and resolve to a typed
`review-pending` outcome naming the open review. The caller gets one recoverable
error, the UI focuses the existing review, and no acquisition entries are
created.

### U7. Exact-version trust remains exact — but versions are not the review unit

Admission binds unit source identity, effective version, manifest digest,
executable dependency identities, and external dependency lock. Any change to a
unit's code requires new admission.

But **admission is not the same as review**. Effective version includes
`dependencyEvs` (`buildV2/index.ts:1202-1213`), so bumping one shared package
cascades new EVs across the workspace. Presenting every EV change as a decision
would replay the 37-unit card on every upgrade, forever. Therefore:

> A change that alters a unit's **declared authority** is reviewed. A change that
> alters only its code identity is admitted by the accepting decision without a
> row of its own.

The user still consents to the exact bytes — the publication they accept covers
them — but they are asked about what changed in what the code can _do_, not about
digest churn they cannot evaluate. This is the invariant that makes §7.3
possible.

### U8. No compatibility layer

Replace the all-or-nothing resolution contract. No second decision path, no
record translation, no dual schema. Development approval state is deleted at
cutover; the finished runtime contains no old-schema reader.

## 5. Where admission comes from

There is no "release" concept and no separate trust anchor. Admission has one
correct home and one hole.

### 5.1 Admission rides publication

Every unit's bytes enter through exactly one protected-main publication, and
publications are already gated. `mainAdvanceApproval.ts:496-525` computes
`unitChangeApprovalForCommit(candidate.stateHash)`, raises one prompt carrying
both the server-computed diff and the changed units, and on acceptance calls
`provider.acceptPreapprovedTrust(identityKeys)`, which writes admission.

The rule, kept as-is:

> **A unit is admitted when a publication a human accepted introduced its exact
> version.**

A user writing their own panel, an agent editing a worker, a template landing
foreign code — all publications, all reviewed where the change is visible.

### 5.2 The hole: workspace creation

`mainAdvanceApproval.ts:121` — `if (context.kind === "workspace-initialization")
return;` — the publication installing the first snapshot skips the gate.
Correctly: there is no workspace yet and nobody to ask. But it records no
admission, so every unit it installed has none. Boot then calls
`startupApproval()` (`src/server/index.ts:5516`), which re-derives a review for
every unadmitted unit — all 37 — and shows the card.

Fix: **the creation publication records admission for the units in the snapshot
it installs**, and `startupApproval()` and its re-derivation path are deleted.
Nothing is weakened: any later change is an ordinary gated publication with a
diff.

Creation is not a silent trust path: the units it lands are admitted by the
**creation review** (§7.1), held in the new workspace immediately after it opens.
So the predicate is not "bytes passed through initialization" — it is an ordinary
user decision, taken on the same surface as a template install, and it works the
same way whoever published the root template.

`isAuthorizedChrome` (`mainAdvanceApproval.ts:474`) also returns before the unit
review. Its publications are the trusted first-party UI writing for the user in
front of it — setup, settings, layout — where the click _is_ the consent and
gating would confirm a dialog the user just confirmed. Those **record admission
directly** and stay silent.

But `isAuthorizedChrome` is just `callerHasCapability(caller, "panel-hosting")`,
and `PLATFORM_PRINCIPAL_CAPABILITIES` (`chromeTrust.ts:27`) grants that to
`server` and `headless-host` as well as `shell` and `electron-main`. A headless
host has no user and no click, so the justification does not reach it. **Silent
admission is scoped to the interactive principals** — `shell`, `electron-main`,
device-scoped `shell:<deviceId>`, and the apps in `trust.chromeApps`. A `server`
or `headless-host` publication takes the ordinary gate, or in a headless run the
explicit decision of §7.9.

This is a narrowing of an existing check, not a new mechanism; no publication
token is introduced. The remaining code question: confirm chrome never publishes
_on behalf of_ a non-chrome caller, which would admit agent-written code without
review.

### 5.3 Template install: the case where review earns its keep

A template pulls foreign code over the network. Categorically unlike an edit to
code already present, and the one moment worth a human's full attention.

A template operation does not fall through to the generic main-advance card. The
publication gate recognizes it and presents the collection surface (§7.2) as its
prompt, using the `template.add` / `template.update` / `template.remove` card
types already in the prompt registry. One decision, one publication, admission
recorded per unit.

**A template publication may also contain agent-authored repairs.** The build
gate explicitly ships in-context fixes in the same publication
(`official-template-repositories-plan.md` D1). Those edits touch units the
template does not own, so the collection surface shows them in a distinct,
always-expanded section:

```text
Also changes 2 parts already in your workspace
  Chat            Fixed to work with News. No new permissions.
  Model Settings  Fixed to work with News.
                  + The web · Fetches pages from any site.
  [Review changes]
```

Repairs that add declared authority rank with the template's own notable rows and
are never folded away. Declining a repair-bearing install discards the whole
operation context, repairs included.

### 5.4 Upgrades are differential

Upgrading base or a template is one publication carrying a large EV cascade and,
usually, almost no authority change. Per U7 it is presented as a _difference_:

- units whose declared authority is unchanged produce **no row**, regardless of
  EV or dependency churn, and are admitted by the accepting decision;
- units whose declared authority changed produce a row showing exactly the
  `AuthorityRowDiff` — added, removed, retiered;
- units newly added by the upgrade produce a row with their notable rows;
- units removed produce a row and have their grants retired.

An upgrade that changes no declared authority anywhere shows a one-line
confirmation, not a list. This is what stops §3's card from returning on every
release.

### 5.5 Client apps and extensions

They keep the launch-gate presentation (§7.6) and the same admission store and
typed resolution. They do not use the collection surface, because the app that
would render it is itself under review. The unconditional bypass — `isCodeApproved`
returning `true` for every `app` and `extension` caller
(`src/server/index.ts:940-944`) — is deleted; their admission comes from the
publication that introduced them.

## 6. Clearance classification

Method tiers remain the authorization floor:

| Method tier | Manifest requirement | Standing grant              | Prompt behavior                   |
| ----------- | -------------------- | --------------------------- | --------------------------------- |
| `open`      | None                 | None                        | No authority prompt               |
| `gated`     | Required             | Allowed when policy permits | Cleared at install, or contextual |
| `critical`  | Required             | Forbidden                   | Fresh per-operation approval      |

Gated requests get one platform-owned dimension:

```ts
interface CapabilityClearancePolicy {
  clearance: "install" | "contextual";
  reusableScopes: readonly ("task" | "unit-version")[];
  presentation: "declared" | "concrete-use";
}
```

For userland capabilities this composes with the existing
`UserlandCapabilityDefinition` fields rather than duplicating them: `tier` and
`grantScopes` stay provider-authored as the ceiling; the platform supplies
`clearance` and may only reduce.

### 6.1 The default is install clearance

**Reviewed gated requests clear at install unless listed below.**

**Unreviewed capabilities do not.** A capability the platform has not classified
— a new userland capability shipped by a third-party template, anything not yet
in the reviewed catalog — defaults to `contextual`, and to `headline` for display
(§10). Otherwise a foreign template could ship a capability that is both
auto-granted and auto-hidden, which is the one genuinely new hole this plan could
open.

This costs nothing today: the catalog is finite and largely reviewed, so the
default applies to capabilities that do not yet exist. It is a review step for
_capabilities_, of which there are a bounded number, not for _declarations_,
which §1 leaves alone.

With manifests left broad, a contextual default would convert one bad card into a
prompt on essentially every first use. The gain would be theatre: the user clicks
through, and the workspace's entire friction budget is spent on requests already
reviewed at admission.

This default is a judgment call. What actually produces prompts is what code
_calls_, not what it declares, so the real volume will only be visible in use;
the contextual list (§6.2) is the dial and is expected to move. Selection (U5)
gives the user their own dial in the meantime — anything they would rather be
asked about, they uncheck.

### 6.2 Contextual list

Requests that keep prompting at use regardless of declaration:

- **Accounts & sign-ins** — credentials, secrets, connected accounts, tokens. The
  prompt names the concrete account. This boundary already exists independently:
  credential-_use_ grants live in the credential system, so declaring
  `agent.credentials.manage` never itself hands over a credential.
- **Device access** — camera, microphone, location, clipboard, paired devices.
- **Widened external network reach** — egress beyond the unit's declared
  origins/domains.
- **Cross-user or protected data** where the receiver restricts principals.

### 6.3 Critical is unchanged

Installing or updating executable code, advancing protected main, publishing or
sending externally, destructive changes, account and security administration, and
financial effects require a fresh decision against a prepared effect and reject
standing scopes. They are never cleared at install; they appear on the install
surface as a disclosure only.

### 6.4 Clearance grants are ordinary grants

Install clearance creates unit-version-scoped `AuthorityGrant`s in the canonical
store through the same evaluator path as contextual acquisition — not a bypass
flag. Records carry `origin: "template-install"`, `"publication"`, or
`"workspace-creation"` for inventory and audit.

This replaces the synthesized-per-call grant in `productAuthorityGrants.ts:54-67`.
After the change, a declared request with no stored grant prompts rather than
resolving itself, which is what makes revocation mean anything.

### 6.5 What a grant binds to

The subject algebra already separates code from identity: `PrincipalKind` is
`host | user | code | session | mission`, `agent:<bindingId>` is a grant subject,
and `entity:` is deliberately _not_ one (`packages/rpc/src/authority.ts:5-9`,
capability-model-redesign D5). This plan follows that split rather than widening
it:

> **Install clearance always binds to code** — `code:<repoPath>@<version>` —
> because it derives from the manifest, and the manifest is a property of code.
> **An at-use grant binds to whatever the prompt named**, because that is the
> object the user actually consented to.

**Installed code always matches exactly one subject: its own code identity.**
`subjectsForOrigin` (`authorization.ts:448-462`) seeds the set with
`authorizingOrigin.principal` and adds more only when the origin kind is
`session` — so `session:<id>` and `agent:<bindingId>` are available to evaluated
runs, never to a panel, worker, or Durable Object. There are **no per-instance
grants**: two open Chat panels, and every instance of a per-key Durable Object,
share one subject. The runtime instance is known (`AuthorizationContext.entity`,
`ApprovalRequesterIdentity.ephemeralInstanceKey`) and used for attribution and
lifetime only.

So an at-use grant for installed code is a `code:` grant — "always allow for this
exact unit version" mints one with `scope: "version"` — and everything that code
runs shares it. That is correct, because sharing is what the user agreed to.

Where per-object differentiation is genuinely needed, it belongs on the
**resource** axis, not the subject axis: a grant on
`{kind: "exact", key: <channelId>}` distinguishes which object is being acted on
while the subject stays the code. "This channel but not that one" is expressible;
"this running instance but not that one" is not, and nothing in this plan should
be designed as though it were.

This also answers "should a Durable Object be its own principal" (§8). A DO class
has no `repoPath` of its own, so it shares its worker's subject. Per-class
authority is not impossible — a manifest could declare blocks keyed by
`{source, className}` — it is simply not what the manifest is today, and adding
it is a format change this plan excludes (§1).

It also would not buy what it appears to. Every worker that declares a DO
declares exactly one (`model-settings`, `pubsub-channel`, `system-test-runner`,
`testkit-driver`, `workspace-source`), so there are no siblings to separate; and
because per-instance grants do not exist for anything, per-class subjects would
still not distinguish two live objects of the same class. Revisit if a worker
ever hosts two classes with genuinely different needs.

What must hold is narrower, and it is D6's rule rather than a new one: **the
grant subject matches the object of consent stated in the prompt.** A prompt that
names a unit version may mint a code grant; a prompt that names one actor may not
mint a grant its siblings can use. The failure mode to avoid is not sharing — it
is a prompt that says one thing and a grant that records another. The evaluator
still consults one subject set, and no grant unions into a sibling's authority
without a decision that said so (D5's confused-deputy rule).

No implementation is required now: singleton objects are one-to-one with their
workers today.

## 7. User experience

Copy is normative and conforms to the prompt registry's banned-vocabulary rules
(`packages/shared/src/authority/promptRegistry.ts`). Permission text renders from
`AuthorityRow` (`action`, `resource`, `domain`) grouped by the eight
`AUTHORITY_DOMAINS` labels. Nothing renders package-authored prose directly.

The user-facing noun for a unit is **part**, with four kinds:

| Kind      | Label          | What it is                                   |
| --------- | -------------- | -------------------------------------------- |
| panel     | **Panel**      | Something you open and look at               |
| worker    | **Agent**      | Something that works on its own              |
| worker    | **Service**    | Something other parts rely on                |
| app       | **Client App** | The desktop, mobile, or terminal app itself  |
| extension | **Extension**  | Native code that adds an ability to the host |

Workers split by a computable test rather than by judgment: a worker that
declares a service or Durable Object surface (§8) displays as **Service**; one
that declares none displays as **Agent**. That keeps `workers/model-settings`
from being called an agent while a template's `news-agent` is correctly named.

Durable Objects and services are not kinds; they are surfaces of the Agent that
hosts them (§8). Providers display as Extensions.

### 7.1 Workspace creation

A workspace can be created from **any template**, not only the base we publish.
So creation gets a real review rather than an argument about why it doesn't need
one.

**Placement: in the new workspace, immediately after creation.** Before creation
there is no workspace and, on first run, no shell to render in — the same
bootstrap constraint that forces the launch gate to exist (§7.6). After creation
everything is up and every primitive from the install surface is available.

The flow:

1. Creation lands the root template's source and publishes it, as today.
2. Its units are **not yet admitted**, so per U6 their calls resolve to
   `review-pending` and generate no prompts.
3. The workspace opens on the collection surface (§7.2) in review-and-confirm
   mode, headed by the template being adopted:

   ```text
   Welcome — here's what's in your workspace
   Vibestudio Base 1.4.0, from Vibestudio

   23 panels · 14 agents and services · 3 client apps · 13 extensions
   ```

4. Accepting records admission and mints clearance for the selected parts and
   permissions, exactly like a template install.

Same components, same rows, same copy, same selection semantics as §7.2 — the
only differences are the heading and that there is no "Not now," since the
workspace is already created. The equivalent escape is deselecting everything,
which leaves every part asking at use.

Because this is a real review, nothing depends on who published the root
template, and no special trust attaches to the creation path.

For a large root the list is long, which is exactly what §10's notability split
is for: most base parts read `Nothing unusual` and collapse, and the handful with
headline permissions rise to the top. A user who wants to accept and get on with
it clicks once.

### 7.2 Installing a template

Entry points — onboarding catalog, About → Templates, an agent proposing an
install — all open the same route.

Desktop: a two-pane dialog, preferring 1100×720 and never wider than the window.
Below roughly 720 logical pixels of width it collapses to the mobile list/detail
model in place — there is no minimum size that can leave the dialog unusable or
clipped. Mobile: a full-screen route with list and detail as separate navigation
levels and a normal back action.

Header:

```text
Add News
Read and discuss personalized news briefings.

github.com/panticonic/news · News 1.2.0
Adds 1 panel and 2 agents
```

List:

```text
☑  News                                     Panel
    Reads your feeds and shows briefings.
    Nothing unusual · 9 everyday permissions

☑  News Agent                               Agent
    Fetches and summarizes articles on a schedule.
    Works on its own · Can send things outside this workspace

☑  Feed Importer                            Agent
    Imports subscriptions from other readers.
    Fetches pages from any site
```

Row anatomy, fixed:

1. Checkbox, checked by default.
2. Title, from the template.
3. Kind, right-aligned, from the table above.
4. One-sentence purpose, from the template, one line, ellipsized.
5. **Notable line** — the headline rows for this part (§10), at most two, in
   plain language. A part with no headline rows states its ordinary footprint
   rather than claiming innocence: `Nothing unusual · 9 everyday permissions`.

**What a checkbox means (U5).** Checked is _allow now_: the part's cleared
permissions are granted when the template is added. Unchecked is _ask when
needed_: nothing is granted, the part still arrives and still works, and the
ordinary prompt appears the first time it actually needs something. Unchecking
never removes a part and never stops it running. The row says so on hover and
focus: `Will ask before it does these things.`

Deselecting a part deselects its permissions; individual permissions can be
unchecked in the detail pane without unchecking the whole part.

Search and a kind filter appear above twelve parts and are absent below it — a
threshold, not an assumption that templates stay small.

Detail pane / detail level, ordered by notability rather than by section:

```text
News Agent
Agent · from News 1.2.0

Fetches and summarizes articles on a schedule, and posts them into
a conversation you can reply to.

Worth knowing
  Works on its own        Runs in the background on a schedule,
                          without you opening anything.
  Publishing & sending    Can send things outside this workspace.
                          Asks every time, showing exactly what.
  Accounts & sign-ins     Can use an account you've connected.
                          Asks when it needs one, and you pick which.
  The web                 Fetches pages from any site.

Plus 8 everyday permissions ▾

Details ▾
  Version 1.2.0 · github.com/panticonic/news
  What it needs from the rest of your workspace
```

**Only install-clearable rows carry a checkbox.** Those are the only ones a
decision here can grant, so they are the only ones offered — checked by default,
and uncheckable so a user can accept a part but require it to ask before one
specific thing: _"you can fetch pages, but ask me before you send anything out."_

Contextual and critical rows are **disclosures, never checkboxes**. They already
ask at use by policy (§6.2, §6.3), so a checkbox would promise something this
decision cannot deliver and the server would refuse. Their timing line carries
the whole meaning — `Asks when it needs one, and you pick which.` — and they
render with a distinct non-interactive marker so the difference is visible at a
glance rather than inferred from a missing control.

**Worth knowing** carries **every** headline row (§10) plus every behavioral
fact — nothing notable is ever dropped. Five is a collapse threshold, not a cap:
beyond five, the remainder folds under `Show all N notable ▾`, expanded by
default when any of them is critical. Each is the plain-language `AuthorityRow.action`, its resource
phrase, and a second line stating _when_ it applies:

- cleared at install → no second line; it simply works once added;
- contextual → `Asks when it needs one, and you pick which.`;
- critical → `Asks every time, showing exactly what.`;
- behavioral → `Runs in the background on a schedule, without you opening
anything.`

Timing lives on the row, not in a section heading. Grouping by our
cleared/contextual/critical model sorts by the platform's concerns and buries a
part's one alarming power under a heading two scrolls down.

**Plus N everyday permissions** collapses the ordinary rows (§10). Expanding
lists them in full, grouped by domain, under one line of honest framing: `These
are the ordinary things parts do here. Ordinary doesn't mean harmless — open any
one to see what it does.`

Footer:

```text
3 parts · everything allowed now          [Add template]  [Not now]
```

One click adds the complete slate with everything allowed. The status line
restates the selection in plain terms and updates live:

- `3 parts · everything allowed now`
- `3 parts · 1 will ask before it does 2 things`
- `3 parts · 1 will ask before anything`

`Not now` discards the operation context and leaves the workspace untouched;
onboarding may offer the template again later and reports the capability as not
installed.

Result:

```text
News added
Open News →
```

Failures name the parts that failed and leave nothing behind.

### 7.3 Updating a template or upgrading base

Same route, differential mode (§5.4). The list contains only parts whose
**declared authority changed**. EV and dependency churn produce nothing.

```text
Update News
News 1.2.0 → 1.4.0 · github.com/panticonic/news

News Agent                                  Agent
  + The web             Fetches pages from any site
  − Your files & work   Reads and writes files in this workspace

Feed Importer                               Agent · new
  Imports subscriptions from other readers.
  Fetches pages from any site

9 other parts updated with no permission changes ▾

[Update]  [Not now]
```

Ordering: new or widened permissions first, then permissions that moved to
asking-at-use or always-confirms, then new background behavior, then newly added
parts, then removed parts.

An upgrade with no authority change anywhere renders as one line — `Updates 12
parts. No permission changes.` — with the same two actions.

**Which clearance survives an update.** Grants are version-bound, so every one
must be re-minted against the new exact version — including for parts whose
review shows no rows at all. Re-minting everything declared would silently undo
the user's earlier deselections; re-minting nothing would break parts that were
working. The rule is therefore explicit:

```text
new clearance
  = rows the user had already cleared
  ∩ the new manifest
  ∩ current install-clearable policy
```

Consequences, each deliberate:

- a code-only update re-mints exactly what was there, and shows nothing;
- a permission the user declined at install stays declined across every future
  update, without needing to be declined again;
- a permission that was cleared but has since become contextual by policy is not
  re-minted, and starts asking at use;
- a **newly declared** permission is never carried in by inference — it appears
  in the review as a row with a checkbox, and the user decides;
- contextual and critical grants never transfer, since they were never standing
  in the first place.

Removed parts and their grants retire in the same transaction.

### 7.4 A part changed in your workspace

Raised when a publication changes a unit already present — the
agent-edits-its-own-code case. This is the existing `source-change` main-advance
prompt, kept, with §7.2's row treatment and U7's rule applied: authority changes
produce rows, code-only changes produce a diff link and no permission rows.

```text
News Agent changed
Someone edited this part in your workspace.

  + The web             Fetches pages from any site

[Review changes]  [Use the new version]  [Keep the old version]
```

Until decided, the part keeps its previously admitted version if it has one; if
not, its calls resolve to `review-pending` (U6) and focus this card.

### 7.5 Runtime prompts

Mechanics unchanged; provenance added.

```text
Allow News Agent to use an account you've connected?
Part of News

Account:  Panticonic GitHub

[Allow for this task]  [Just once]  [Don't allow]
```

`Always allow for News Agent` appears only where policy permits a `unit-version`
reusable scope. Critical prompts show the prepared effect and offer no standing
decision.

### 7.6 The launch gate

Client apps and extensions are decided before the workspace UI exists, in a
host-owned window and in the terminal (`bootstrapLaunchGate.ts`). This surface
cannot be replaced by the collection route: `apps/shell` is itself under review,
so it cannot render its own approval. Each host target reviews its own app and
the extensions that target requires — desktop in the Electron main window, mobile
on a native pre-workspace screen, terminal as text.

Once an admitted client is running, its approval queue shows every pending
review, including reviews containing other client apps. A part's app kind does
not establish that a launch gate is presenting its review. Pending counts and
notifications use the same rule; only reviews still preparing lack an actionable
decision.

It is also, after §7.1, the **only** review these units ever get, including for a
third-party root. So it is specified properly here rather than treated as chrome.

**The surface is more capable than "pre-shell" suggests.** It is a host-owned web
page (`src/bootstrap/index.html`, `src/bootstrap/index.ts`), not a system dialog.
It cannot use components built from workspace source, but it can render whatever
the host ships. Nothing below is constrained by the surface; it is constrained by
what is worth saying at this moment.

**Anyone may publish apps and extensions.** There is no allowlist, no registry
requirement, and no publisher gate. An unfamiliar origin is a normal case, not an
exception. The gate's job is therefore not to vet — it is to **highlight the risk
plainly enough that the user can judge it**, using only facts we actually hold
(§7.6.3).

#### 7.6.1 What this decision is actually about

Not permissions. Extensions are native code running outside Vibestudio's
protections with access to the computer, and apps are the client itself. Listing
their individual permissions at this moment invites the user to weigh details
that are downstream of the only question that matters:

> **Whose code is this, and do I want it running on my computer?**

So the organizing axis here is **origin**, not kind and not permission. That is
the opposite of §7.2, where the code is sandboxed and the interesting axis is
what it can reach — and the difference is deliberate.

#### 7.6.2 The common case is one sentence

A fresh workspace from our own base is the overwhelmingly common case, and it
should read as one fact and one button:

```text
Start this workspace?

Vibestudio needs to run 16 programs on this computer —
3 apps and 13 extensions, all from Vibestudio 1.4.0.

                                      [Start]   [Quit]

See what runs ▾
```

#### 7.6.3 Highlighting the risk

Three rules, because the gate cannot lean on any notion of an approved
publisher:

**There is no publisher identity, so the origin URL is the identity.** Nothing in
the system establishes who published anything: `WorkspaceTemplatePin` carries
`url`, `ref`, `commit`, and `snapshot`, and there is no signing, no publisher
account, and no key. A name a template gives itself is self-asserted and
unverified — a hostile template can call itself "Vibestudio."

So the gate shows **where the bytes came from**, which is the one non-asserted
fact we have:

```text
github.com/acme/studio          at v2.1
```

This follows the browser precedent deliberately. Browsers stopped displaying
verified company names because users cannot distinguish the real entity from a
lookalike registration; the domain is what gets shown. Same rule here:

- the origin URL is the identity, rendered prominently and never abbreviated
  away;
- a template's self-given name may appear as its **title**, in a slot that
  obviously belongs to the template, and never in a `From X` position that reads
  as a verified publisher;
- the registrable domain is emphasized within the URL, internationalized domains
  render as punycode, and no unicode trickery is permitted in any part of the
  string that a user reads as identity;
- "first encounter" (below) keys on the origin, never on a name.

The one exception is our own base, whose URL ships in the host build — the host
naming its own origin is a build vouching for itself, not a claim about a third
party.

And never render a badge like "verified": we verify that the bytes match the
exact commit and snapshot we fetched, which is integrity, not endorsement, and a
badge saying so will be read as approval.

**No digests, anywhere a user reads.** Commit ids and content digests are not
shown on any review surface — not at the top level, not under a disclosure, not
in "details." A 40-character hash is unreadable, and printing it implies the user
should check it against something, which they have no way to do. That is the same
theatre as the badge. Identity at human scale means the **origin URL and the
version tag** and nothing else. Digests remain in audit records and can be copied
out for support; they are never part of a decision a person is asked to make.

**Say what native code can do, once and plainly.** Extensions run outside
Vibestudio's protections with access to the computer. That sentence is the risk,
it applies to every extension regardless of origin, and it appears at the top
level rather than inside a disclosure.

**Mark the first encounter with an origin.** `You haven't run code from
github.com/acme before.` is a fact, not a judgment, it is cheap to compute from
the admission store, and it is the single most useful signal available without an
identity system. It keys on the origin — registrable domain plus owner path
segment — so a new repository under a domain the user already runs code from is
distinguished from a wholly new source. An origin the user has run before does
not get the line.

Risk is highlighted by **prominence and plain language**, never by blocking, and
never by implying we have checked something we have not.

#### 7.6.4 Anything from elsewhere is named, not buried

The moment a second source appears, sources become the list, ordered with
unfamiliar origins first:

```text
Start this workspace?

Vibestudio needs to run 17 programs on this computer.

  github.com/panticonic/news  at v1.2.0           1 extension
    Feed Reader — reads and writes files on this computer

  Vibestudio 1.4.0                     3 apps · 13 extensions

Extensions run outside Vibestudio's protections, with access to
this computer.

                                      [Start]   [Quit]
```

And a workspace built from a root published by someone else leads with that
fact — not because it is disallowed, but because it is the thing worth knowing:

```text
Start this workspace?

This workspace is built from code at github.com/acme/studio.
You haven't run code from github.com/acme before.

It needs to run 9 programs on this computer, including 4
extensions. Extensions run outside Vibestudio's protections,
with access to this computer.

  github.com/acme/studio  at v2.1       2 apps · 4 extensions
      "Acme Studio" — name given by this template
  Vibestudio 1.4.0                      1 app  · 2 extensions

  Review each ▾

                                      [Start]   [Don't start]
```

#### 7.6.5 Progressive disclosure, three levels

1. **Sources** — origin URL, version, and counts. Collapsed by default when there
   is one source; expanded when there is more than one.
2. **Units** — one line per app or extension: name, and its notable rows from §10
   in plain language. A unit with nothing notable shows its purpose only.
3. **Details** — version, origin URL, and what each unit is for. Nothing
   machine-shaped.

Notability is computed exactly as in §7.2 (§10), so the copy a user reads here
matches what they will later see in About → Templates for the same unit. Nothing
renders a raw capability string at any level.

#### 7.6.6 Declining says what it costs

The gate never leaves a half-started host, so there is no partial selection —
but declining must be honest about its consequence, and the consequence differs:

- at creation, or for the app the user is launching:
  `Vibestudio won't start. Nothing is installed or changed.`
- for a later change that adds an extension:
  `The News extension won't run. The rest of your workspace works normally.`

A declined gate does not loop. It is re-offered the next time the app launches,
and the terminal form exits with a distinct status so scripts can tell decline
from failure.

#### 7.6.7 Rules

- The decision is recorded as per-unit admission through the same store as every
  other surface, with the same typed resolution.
- Accept/decline for the set shown; no partial selection, because a half-launched
  host is not a state worth modelling.
- Origin ordering is stable and puts unfamiliar origins first; it never hides a
  source behind a count.
- No string implies we have reviewed, approved, or vouched for anyone, because we
  have not, and no self-asserted name is rendered where it reads as identity.
- The terminal form carries the same content and the same decision as the window
  — same sources, same notable lines, same consequence copy — as plain text with
  an explicit prompt, never a truncated summary.
- Keyboard-complete: the disclosure levels, both actions, and focus order work
  without a pointer. Screen readers announce the source count and the
  outside-protections sentence before the actions.
- No user-facing string here trips the prompt registry's banned-vocabulary
  check, and this surface's copy is registered alongside the other cards.

### 7.7 Management and revocation

- **About → Templates** lists installed templates — base included — with version,
  origin, and parts, each opening the §7.2 detail view. The available action is
  **Remove template**, which severs the relationship only. Its parts stay, keep
  working, and become the user's to manage; the confirmation says exactly that,
  matching the shipped `template.remove` copy. Nothing is deleted and no grant is
  retired. Each part keeps `Originally installed from News 1.2.0` in its details.
- **About → Permissions** lists per-part permissions with origin — `Added with
News`, `You allowed this`, `Part of Vibestudio` — and revocation.
- **Revocation states its consequence before it happens.** Revoking a cleared
  permission means the part asks at next use or stops working, with no visible
  link back to this screen. The confirmation names the part and the effect:

  ```text
  Stop letting Chat read your files?
  Chat will ask the next time it needs to, and may not work
  properly until you allow it.

  [Stop allowing]  [Cancel]
  ```

  Permissions is where an install-time decision is revisited in both directions:
  a permission allowed then can be revoked, and one declined then can be granted
  without reinstalling anything. It is the same choice as the install
  checkbox (U5), after the fact.

- **Part details** show version, origin, source template, everything the part may
  ever ask for, and what it currently holds.

### 7.8 Cross-surface contract

Desktop, mobile, terminal, and headless implement the same server-owned decision,
the same immutable review snapshot, and the same per-unit admission. Responsive
presentation must not produce a weaker review anywhere.

Both interactive surfaces provide: a persistent action area that never covers
content; identical action meanings; the same notable/everyday split and copy;
provenance and versions under disclosure; resumable loading and error states; an
explicit final result; and immediate invalidation when another device resolves the
review.

Text wraps vertically; neither surface uses nested horizontal scrolling.

Mobile: 44pt minimum touch targets; back gesture never submits or silently
discards; rotation, backgrounding, reconnect, and process restoration reload the
authoritative snapshot; screen-reader announcements include the notable rows;
diffs fully inspectable on the phone.

Desktop: full keyboard coverage of rows, details, and submission; large windows
use the space; small windows collapse to the mobile list/detail model; focus
returns to the originating panel or onboarding step.

Push notifications say `Review what News adds` or `Review the News update` and
open the in-app route. They never resolve an install or approve code from the
lock screen.

### 7.9 Headless and CLI

Non-interactive callers (`src/cli/systemTestCommands.ts`, agentic system tests)
resolve a review with an explicit typed decision or an explicit `--accept`. There
is no implicit accept-everything. A review with no policy to resolve it fails
closed and reports what it was waiting on.

## 8. Server contract

Template inspection returns a host-verified catalog:

```ts
interface TemplateUnitCandidate {
  identityKey: string;
  kind: "panel" | "worker" | "app" | "extension";
  /** Durable Objects and services this part hosts, shown nested under it. */
  surfaces: Array<{ kind: "durable-object" | "service"; name: string }>;
  name: string;
  title: string;
  purpose: string;
  effectiveVersion: string;
  manifestDigest: string;
  requiredUnitKeys: string[];
  runsInBackground: boolean;
  /** Headline rows for "Worth knowing" (§10), platform-classified. */
  notableRows: Array<{
    row: AuthorityRow;
    timing: "on-add" | "asks-when-needed" | "asks-every-time" | "behavioral";
  }>;
  /** Everything else, rendered one level down. */
  everydayRows: AuthorityRow[];
}
```

The template supplies titles and purposes. Identity, dependency closure, rows, the
clearance partition, and the notability split are derived and verified by the
platform.

**Durable Objects are not rows.** A DO class lives inside a worker unit and has no
independent code identity — `singletonObjects` entries name
`{source: workers/…, className: …}`, and admission binds the worker's path and
version. DOs and services appear as `surfaces` under their Agent.

`scheduled-job` and `agent-heartbeat` leave this enum; unattended charters are
reviewed as missions (`PendingMissionReviewApproval`).

Resolution:

```ts
interface TemplateAcceptance {
  decision: "install" | "update" | "adopt-root";
  /** Parts whose cleared permissions are granted now. Absent = ask at use. */
  allowNow: Array<{
    identityKey: string;
    /** Row keys to clear. Absent means every cleared row for the part. */
    permissions?: string[];
  }>;
}

type TemplateInstallResolution = TemplateAcceptance | { decision: "cancel" };
```

Every part of the template is always installed; `allowNow` decides only what is
pre-authorized. There is no "install a subset" result, because there is no
mechanism behind one (U5).

The server validates the pending immutable review, rejects any identity or row
key absent from it, rejects any row key whose policy is contextual or whose tier
is critical, rejects stale template or workspace state, records admission
per unit **for every unit the operation lands**, mints clearance grants only for
`allowNow`, publishes atomically, activates only after admission commits, and
leaves no grants or partial activation after cancel or failure.

Note that admission and clearance separate here: an unselected part is still
admitted — its exact version was reviewed and accepted — it simply holds no
standing grants, which is what makes it ask.

Renames, no aliases retained:

- `unit-batch` → `unit-install-review`
- `ServerUnitApprovalCoordinator` → `UnitInstallReviewCoordinator`
- `UnitVersionApprovalStore` → `UnitAdmissionStore`, gaining batch writes and an
  `origin` field
- `applyApproved()` → typed admission/publication callbacks
- `Approve all` → `Add template`

Surfaces that move with the rename: `packages/shared/src/approvals.ts`,
`approvalContract.ts`, `approvalCopy.ts`, `bootstrapApprovals.ts`,
`bootstrapLaunchGate.ts`, `authority/promptRegistry.ts`,
`src/server/services/approvalPushBridge.ts`, the shell `ApprovalCard`, the mobile
`ApprovalSheet`, `terminal-browser/ApprovalsOverlay`, and
`src/cli/systemTestCommands.ts`.

## 9. Eval

Eval is not an installed unit and never appears as a part. It remains dynamic
under
[`agentic-authority-negotiation-plan.md`](agentic-authority-negotiation-plan.md):
an admitted agent/session fact is mandatory; requests derive from the evaluated
program closure; open methods need no grant; gated methods acquire contextually;
critical methods require fresh prepared-effect approval. Install clearance is
never minted for Eval, Eval cannot claim a unit identity or consume a unit's
clearance grant, and installed code cannot route fixed behavior through Eval to
escape its manifest.

## 10. Notability: a reviewed list, not a computed signal

The presentation problem is that with today's manifests every part looks identical
and equally alarming. The fix is deciding, once, which capabilities are worth a
user's attention — semantically, by reading the list.

**Notability is a curated field on the reviewed capability metadata**, alongside
the `domain`, `verb`, and `action` that already live there
(`HOST_SEMANTIC_CAPABILITY_COPY`, the generated host and product catalogs):

```ts
notability: "headline" | "everyday";
```

`headline` means: a reasonable non-technical person, told a part can do this,
would want to know before adding it — sending things outside the workspace,
touching accounts and sign-ins, reaching arbitrary sites, controlling the
computer, changing security settings. `everyday` means the ordinary machinery of
being a part here — reading and writing workspace files, posting into
conversations, using models, panel bookkeeping.

Registration fails without the field, the same way it fails without a tier or a
presentation. Userland capabilities carry the same field, provider-authored; the
platform may promote to `headline` but never demote.

Two rules on top of the flag:

- **Critical is always headline**, whatever the flag says.
- **Behavioral facts are headline** — runs in the background, runs on a schedule,
  reachable without the user opening anything. These matter to users and no
  capability row states them.

An earlier draft computed notability statistically, by comparing a part against
others of its kind. That is rejected: it measures "is this like our other code,"
which is not "is this important," and it fails worst exactly where review matters
— a foreign template copying the standard declaration bundle would read as
unremarkable. A reviewed list is smaller, honest, and auditable.

The list is eyeballed once against the real capability catalog and maintained like
any other reviewed copy. It requires no manifest change, which is what keeps it
compatible with §1.

## 11. Manifest posture

Manifests are not audited, narrowed, or gated by this plan. No CI ratchet, no
justification requirement, no manifest edits.

Instead: every row renders through the reviewed presentation registry, so a broad
request reads as `Your files & work — Reads and writes files in this workspace`
rather than a capability string; §10 decides what a user reads first; the full set
is one disclosure away; and the advisory declared-vs-evident scanner stays
available as reporting-only tooling.

If a later pass narrows declarations it shows up here as shorter notable lists and
cleaner diffs, with no contract change.

## 12. Implementation sequence

### Phase A — Close the creation gap

Smallest phase, largest visible win, no new UI. Worth landing alone.

1. Delete `startupApproval()` and its re-derivation path
   (`buildUnitChangeApprovalProvider.ts:147`, `src/server/index.ts:5516`), so
   boot never re-derives a review.
2. Have the creation publication record admission for the units it lands, with
   the creation review (§7.1) as the decision that accepts them. Until Phase D
   ships that surface, creation accepts them directly.

   _Interim semantics:_ between Phase A and Phase D, a newly created workspace
   trusts its root template without showing the review. That is strictly less
   permissive than today, where admission already grants every declared request
   via `productAuthorityGrants.ts:54-67` and the startup card is dismissed
   anyway — but it is a real gap, and it closes in Phase D. It must not outlive
   Phase D.

3. Make chrome publications record admission (§5.2), and confirm in code that
   chrome never publishes on behalf of a non-chrome caller.
4. Verify: a fresh workspace boots to Chat with no card.

### Phase B — Clearance policy and grants

1. Add `CapabilityClearancePolicy` with the §6.2 contextual list; compose with
   `UserlandCapabilityDefinition` as ceiling-only.
2. Rename `UnitVersionApprovalStore` → `UnitAdmissionStore`; add `origin` and batch
   writes.
3. Replace the synthesized code grants in `productAuthorityGrants.ts:54-67` with
   lookups against stored clearance grants.
4. Mint clearance grants into `capabilityGrantStore` at admission, per unit
   version, per policy.
5. Delete the `app`/`extension` bypass in `isCodeApproved` and the unconditional
   `grantCode` in `src/main/index.ts:1922`.
6. Add the `review-pending` non-acquirable outcome (U6) and wire the review kinds
   to it.
7. Delete development approval state at cutover. No backfill.

### Phase C — Notability and differential review

1. Add the `notability` field; fail registration without it.
2. Eyeball the capability catalog and classify it.
3. Implement U7's rule: declared-authority changes produce rows, EV-only changes
   do not.
4. Implement the differential update/upgrade surface (§5.4, §7.3).

### Phase D — Install and creation UI

1. Build the collection route in the shell and the full-screen route on mobile on
   the same typed contract.
2. Implement row anatomy, per-part and per-permission selection, Worth knowing,
   the everyday fold, and the timing lines.
3. Implement the creation review (§7.1) and the repair section (§5.3).
4. Route template operations to the collection surface; make notifications
   deep-link, not resolve.
5. Update the launch gate (§7.6), Permissions, and Templates management.
6. Delete `UnitBatchDetails`, `UnitBatchActions`, and the terminal-browser
   unit-batch branch.

### Phase E — Documentation

`docs/approvals.md`, `docs/approval-prompt-ux-spec.md` (registering the install,
update, and part-changed cards), `docs/capability-model-redesign.md`,
`docs/official-template-repositories-plan.md`, template authoring and onboarding
skills, authoring docs, Permissions terminology.

## 13. Test plan

### 13.1 Creation and admission

- Boot never re-derives a unit review; `startupApproval()` no longer exists.
- Creation opens the creation review, and accepting it admits the root
  template's units in one transaction.
- Creation from a third-party root behaves identically to creation from base —
  no path grants trust the other does not.
- Units are not admitted before the creation review resolves, and their calls
  return `review-pending` rather than prompting.
- Chrome publications record admission and raise no prompt.
- A declared request with no stored grant prompts — not a silent allow, not a hard
  denial.
- An undeclared request still hard-fails with the manifest remediation.
- Editing an admitted unit routes through the ordinary gated publication with a
  diff; reverting restores the admitted version with no new decision.
- One unit cannot consume another's grant.
- Client apps and extensions admitted at creation raise no launch gate.

### 13.2 Differential review

- An upgrade that changes only EVs and dependencies produces zero rows and one
  confirmation line.
- An upgrade that adds one permission to one part produces exactly one row.
- Retiered and removed permissions appear with the right sign.
- Newly added and removed parts appear.
- A base upgrade across a shared-package bump does not reproduce a 37-unit list.

### 13.3 Pending review

- A unit under unresolved review returns `review-pending` for every gated leaf and
  creates no acquisition entries, however many methods it calls.
- Resolving the review clears suppression and the retried call proceeds.

### 13.4 Template install and selection

- Adding a template records one admission per unit it ships, selected or not.
- A deselected part is installed, runs, holds no clearance grant, and prompts on
  first use of a gated request.
- A deselected individual permission prompts while the part's other permissions
  do not.
- Re-selecting later from Permissions mints the clearance grant without
  reinstalling anything.
- Contextual and critical rows have no checkbox and are never pre-authorized.
- The server rejects an `allowNow` row key whose policy is contextual or whose
  tier is critical.
- An `allowNow` entry naming an identity or row absent from the review is
  rejected.
- Cancel leaves main, admissions, grants, and runtimes unchanged.
- Publication failure leaves no residue.
- Removal severs the relationship only: parts stay, keep running, and keep their
  admission and grants.
- A removed template's parts still report their original source in details and in
  grant explanations.
- Stale registry, workspace, or candidate state fails closed.
- A publication carrying both a template install and agent repairs shows both, and
  declining discards both.

### 13.5 Notability

- Every capability has exactly one notability value; registration fails without.
- Critical rows are always headline regardless of the flag.
- Background and scheduled behavior appear as headline rows.
- A part with no headline rows reads `Nothing unusual · N everyday permissions`,
  with N accurate.
- Worth knowing renders every headline and behavioral row; beyond five it
  collapses behind `Show all N notable`, auto-expanded when any is critical, and
  drops none.
- The everyday fold is reachable in one click and complete.
- A userland provider cannot demote a platform `headline`.

### 13.6 The launch gate

- A fresh workspace from base renders one sentence, one source line, and two
  actions — never a per-extension list.
- A second source is always named and never folded into a count.
- A root from another origin leads with that origin URL and, on first encounter,
  with the fact that the user has not run code from it before.
- An origin the user has run before gets no first-encounter line.
- A template's self-given name never appears in an identity position; it renders
  only as a template-attributed title.
- A template naming itself "Vibestudio" does not render as Vibestudio anywhere
  identity is shown.
- Internationalized origins render as punycode, with the registrable domain
  emphasized.
- No string anywhere on the gate implies review, approval, or vouching.
- No commit id or content digest appears on any review surface, at any
  disclosure level.
- Sources order unfamiliar origins first, stably.
- Every unit line renders notable rows in the same words the collection route
  uses for the same unit; no raw capability string appears at any level.
- Declining at creation says the app will not start and changes nothing;
  declining a later extension says only that extension will not run.
- A declined gate does not loop, and the terminal form exits with a status
  distinct from failure.
- The terminal form carries the same sources, notable lines, and consequence copy
  as the window.
- Keyboard alone completes disclosure and both actions; screen readers announce
  the source count and the outside-protections sentence before the actions.
- The decision writes per-unit admission through the same store as every other
  surface.

### 13.7 UI and accessibility

- Timing lines never imply a disclosure is already permitted, and only the four
  defined strings are used.
- Keyboard and screen-reader flows cover rows, details, disclosure, and submit.
- Desktop wide, desktop narrow, phone portrait, phone landscape, and tablet
  preserve the same information and actions.
- Rotation, background/resume, reconnect, and back navigation reload authoritative
  state.
- A compact card or push notification can open but cannot resolve an install.
- Simultaneous desktop/mobile review resolves once.
- No user-facing string trips the prompt registry's banned-vocabulary check.
- Revoking a permission shows the named consequence before it applies.

### 13.8 End-to-end

1. Fresh creation opens the creation review; accepting it reaches Chat, and no
   card appears on any later boot.
2. Opening Chat, Settings, and three About panels produces no permission prompts.
3. The root template is fully readable in the creation review and afterwards in
   About → Templates.
4. Installing News is one click and records one admission per part.
   4b. Installing News with its agent deselected installs the agent, which then
   prompts the first time it fetches — and allowing it there is durable.
5. First account use prompts for the concrete account and names the real part.
6. A protected-main push shows the prepared change and cannot be permanently
   allowed.
7. A host upgrade produces no permission-change list when nothing changed.
8. An agent edits a base worker; one card, with a diff, and `review-pending`
   rather than one prompt per method.
9. Eval acquires a gated effect dynamically and cannot use a unit's grant.
10. Template removal leaves every part working and workspace-owned, matching the
    shipped removal copy.
11. The same install, update, prompt, and removal scenarios pass on mobile.
12. A headless install with an explicit decision succeeds; one with no policy fails
    closed.

Run the Electron E2E suite, WebRTC smoke, and headless agentic system tests
against exact host + exact base, plus each optional template, plus representative
multi-template compositions.

### 13.9 Adversarial

- A template claims a contextual or critical request clears at install.
- A template marks a headline capability everyday.
- A template declares a host capability that does not exist, and inspection
  degrades to an unknown contextual row rather than failing.
- A creation-admission record is forged for a version the snapshot does not
  contain.
- A template operation is disguised as an ordinary publication to get the generic
  card.
- An authority-changing edit is disguised as EV churn to skip differential review.
- A worker impersonates a sibling unit or a template identity.
- A unit changes source between inspection and publication.
- A standing grant is injected for a critical method.
- Installed code instantiates Eval to escape its manifest.

Every case fails at the server boundary, independent of client behavior.

## 14. Open questions

1. **Getting rid of a part entirely.** Selection (U5) answers "I don't trust this
   power" — deselect it and the part asks instead. It does not answer the two
   adjacent needs, and neither is solved here:
   - _"I don't want to see it"_ — panel-list and launcher curation. An ordinary
     UI preference with no authority meaning, and cheap; it simply is not
     specified yet.
   - _"I don't want it running at all"_ — real for scheduled and unattended
     agents, which cost money and act without being opened. The likely answer is
     the mission machinery's existing pause rather than anything unit-level;
     confirm what it already offers before designing.

   Whatever these become, do not close them with a unit lifecycle flag — that is
   the six-enforcement-point trap U5 rejects.

2. **Service-consuming parts across templates.** Nothing models that a panel in
   one template depends on a service a worker in another provides. The edges are
   computable from data already checked in — units declare
   `workspace-service:<name>` requests, and `meta/vibestudio.yml` maps each
   service to its hosting worker — so a warning could name what breaks. Low
   urgency while nothing removes anything: selection withholds grants rather than
   parts, and template removal severs without deleting.

3. **Chrome relay.** §5.2 has chrome publications record admission silently,
   which is correct for a user acting in trusted UI. Confirm no path lets a
   non-chrome caller publish through chrome; if one exists, route it to the
   ordinary gate.

4. **Repair rows and selection.** §5.3 shows agent-authored repairs to
   already-installed parts in their own section. Unstated: whether a repair that
   _adds_ a permission to an existing part gets a checkbox, and whether accepting
   the install pre-authorizes it. It is a clearance decision arriving inside a
   section designed as a disclosure. Most likely answer: repair rows are
   selectable exactly like any other install-clearable row, and default to
   unchecked because the user did not ask for them.

5. **`review-pending` plumbing.** U6 is specified as an outcome but not as
   wiring. `serviceDispatcher.ts:1729` derives acquirable from the decision code
   alone; suppressing acquisition needs the dispatcher to know a unit is under an
   open review, which is approval-queue state it may not have in reach. U6 is
   load-bearing for both the creation review and the part-changed card, so
   confirm the lookup exists before either ships.

6. **An unknown host capability fails inspection instead of degrading.**
   `authorityRow()` throws when a capability has no reviewed presentation and no
   provider-supplied action, while §6.1 and §10 say unreviewed capabilities
   default to contextual and headline. A userland capability supplies its own
   category and action, so a template declaring its own service is fine; a
   template declaring a _host_ capability we do not have would fail inspection
   outright. A foreign template should not be able to break inspection with a
   typo — it should render as an unknown, contextual, headline row.

7. **The Phase A→D window.** Phase A records interim semantics: between it and
   Phase D a new workspace trusts its root without showing the creation review.
   Strictly less permissive than today, but real, and it becomes permanent by
   default if Phase D slips. Track it as a gap, not as a footnote.

8. **No identity system.** §7.6.3 works around this by treating the origin URL as
   the identity, which is honest and matches browser practice, but it is a
   workaround. A user cannot distinguish `github.com/acme` from
   `github.com/acme-studio`, and nothing binds an origin to a real party. Signing,
   or a publisher account bound to registry entries, would give a real identity —
   substantial work, deliberately not started here. Until then, no surface may
   imply we know who published anything.

9. **The notability list does not exist yet.** Phase C says "eyeball the
   capability catalog and classify it." That single list decides whether every
   surface in §7 reads as informative or as noise, and it is unsized work with no
   owner. It is not a design gap — it is the work the design is waiting on.

## 15. Acceptance criteria

1. A fresh workspace is reviewed once, on the same surface as a template
   install, and thereafter opening base panels asks for nothing that was allowed
   there. Boot raises no card ever again.
2. A host or base upgrade that changes no declared authority shows one line, never
   a per-unit list.
3. Templates never appear in evaluator subject matching; install clearance binds
   to code, and every at-use grant's subject matches what its prompt named.
4. Every executable unit has an exact independent admission record, written by
   whichever publication introduced it.
5. Admission alone grants nothing; every allowed gated call resolves to a stored
   grant.
6. Contextual and critical permissions still prompt at concrete use, and critical
   authority is never persisted.
7. Adding a template is one click, and the same surface explains every part in
   plain language, at human scale throughout.
   7b. A user can accept a template while requiring any part, or any single
   permission, to ask at use instead — and that choice withholds a grant rather
   than disabling anything.
8. Every capability carries a reviewed notability value; unreviewed capabilities
   are contextual and headline; no notable row is ever dropped from a review.
9. Editing a unit's source raises a review showing what changed about what it can
   do.
10. No unresolved review produces per-part prompt spam.
11. The all-or-nothing `unit-batch` resolution and the synthesized manifest grants
    are deleted, with no compatibility path and no migrated state.
12. No manifest was narrowed to achieve any of the above.
13. Creation review, template install, and template update share one set of
    components and one decision contract.
14. Desktop, mobile, terminal, and headless complete every install decision with
    the same semantics.
15. Electron, mobile, WebRTC, E2E, and agentic system tests prove it.
