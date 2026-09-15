# System Agent & Log Watcher — Design

Status: draft for review
Depends on: `capability-model-redesign.md` (§5, R1–R4 reconciliation), `multi-user-wp0-user-identity-spec.md`,
`multi-user-wp3-panel-forest.md`, `multi-user-wp5-approval-provenance.md`,
`multi-user-wp7-channels-multihuman.md`, `multi-user-wp8-presence.md`, `approvals.md`,
`stage0-unified-log-spec.md`, `agentic-architecture.md`, `ws2-channel-spec.md`

## 1. Overview

Two agents give users control and visibility over the running system:

1. **System Agent** — a product-owned conversational agent with **full eval in the shell-owned
   context**. Its model-visible operational surface is just `eval` plus `say`. Eval is the
   platform's existing persistent per-agent EvalDO with the complete portable runtime, typed
   services/RPC, context-sandboxed filesystem/VCS, workspace imports, network helpers, panel tree, channels, and
   persistent scope/db. Before every human turn it receives a fresh complete `ShellOverview`:
   every panel, runtime entity, workspace user/presence row, channel member/live participant,
   session, unit, pending-approval metadata, notification, incident, device, update, focus, and lease. One durable
   conversation exists per `(workspace,user)`, shared across that user's devices with device
   attribution.
2. **Log Watcher** — an unprivileged per-hub singleton that tails panel, worker, and server logs,
   deduplicates mechanically, detects storms, and emits notifications. It cannot call eval or
   shell services. A human explicitly forwards an incident before it enters the System Agent
   conversation.

The split controls *when* privileged eval sees an unbounded hostile stream: it does not. It does
not claim that full eval is immune to prompt injection once attacker-influenced text reaches the
model. The System Agent may inspect userland code, logs, titles, and service results, and those can
influence code it executes. The actual controls are human-initiated turns, pinned product code and
prompt, immutable identity lineage, existing service authorization/approvals, audit, locked
channel membership, and the watcher's lack of capabilities.

### Goals

- Give the System Agent the whole semantic shell, not a supervision subset or one-tool-per-command
  approximation, while preserving approval settlement as a separate consent boundary.
- Make eval the single composable execution surface and fold inspection, mutation, logs, palette
  commands, debug launch, context filesystem, web/network, and docs/discovery into eval plus prompts.
- Give every turn a current complete world model without requiring blind discovery calls.
- Ensure desktop, mobile, and eval use the same owning service/runtime implementations.
- Support narrow, revocable, expiring delegated approval policies with full provenance.
- Surface problems from logs without requiring users to tail them, with mechanical dedupe,
  backoff, and logstorm handling.
- Keep long-form repair in ordinary agent channels; the System Agent supervises and dispatches.

### Non-goals

- A proactive System Agent. Conversation turns are initiated by an attributed human gesture;
  delegated approval evaluation runs as a separate policy micro-session. Card clicks may execute
  ordinary UI service calls without a model turn.
- A “safe eval” dialect, privileged eval fork, generated System Agent tool catalog, action receipt,
  or separate typed-intent classifier.
- Exposing paint/transport internals as semantic APIs. Overlay geometry, raw mouse forwarding,
  heartbeat wiring, and equivalent renderer mechanics stay local.
- Sending human-entered secrets through the model. Eval may open/route the native form, but values
  travel directly to the owning secret store.
- Raw host-filesystem or cross-context filesystem access. Every filesystem spelling in eval is the
  ordinary context-sandboxed runtime filesystem derived from verified owner lineage.
- Giving conversation eval non-delegated approval payloads or settle methods. Only a matched,
  confirmed policy evaluation receives the exact request and its policy-scoped decision token.
- Allowing the agent to expand its future authority or mutate its own trust root. Delegation
  activation/renewal/widening and changes to blessed EVs, grants, prompt/tool policy, locked roster,
  approval rules, credential extraction rules, or audit integrity require independent human/admin
  authority.
- A new chat stack or replacement for ordinary deep-work sessions.

## 2. Architecture

```text
                   human turn                         full typed runtime/services
shell UI ─────────────────────────▶ SystemAgentWorker ────────────────▶ shell owners
                                      │       │                           host/workspace/device
                                      │       └─ eval/say
                                      ▼
                              per-channel EvalDO
                    scope/db + context-fs + imports + rpc

panel/worker/server logs ─▶ mechanical watcher ─▶ inbox ──human forward──▶ conversation
                                  no tools
```

- `SystemAgentWorker` is launched in the workspace-integrated shell context through normal channel
  machinery. The host tracks lifecycle/identity but does not import the channel substrate.
- Its EvalDO is the ordinary eval implementation keyed by the verified worker owner and channel
  subkey. No System Agent sandbox exists.
- Privileged calls carry immutable lineage
  `EvalDO → code:workspace/workers/system-agent@blessedEv → acting user/device`.
- R1 pins the product EV; R3 grants bind to that code EV; R4 locks the user-owned conversation.
- Desktop/mobile semantic handlers and eval call the same typed owning methods. A coverage map
  verifies parity and prompt recipes but creates no tools or dispatcher.
- The watcher pipeline is host-side mechanics plus an optional capability-free model evaluator.

## 3. System Agent

### 3.1 Triggers

The conversation model runs only after an attributed, verified human gesture:

- typed composer message;
- explicit incident forward;
- “Share with agent” on selected content;
- delegate action from an approval card.

Trusted chrome may post a structured card as that human-authored turn. It may not synthesize a
turn from an event, timer, log line, notification, or service result. An approval request matching
a confirmed delegation runs in the isolated §5 micro-session, not the conversation.

Card buttons are ordinary verified UI actions. They call shared services directly and do not need
a model turn.

### 3.2 Conversation and device scope

There is one conversation per `(workspaceId,userId)`. Devices are attribution, not partitions:
desktop and phone see the same transcript, while every turn and action records its originating
device. `systemAgent.resolveConversation()` accepts no identity arguments; the shell derives the
user/device and resolves or creates the pinned entity and locked channel.

Removing a user retires the conversation. Revoking a device terminates that device's sessions but
does not delete the user-owned conversation. Cross-user joins and arbitrary worker publishers fail
through R4 roster enforcement.

### 3.3 Complete per-turn `ShellOverview`

Immediately before every human model turn—and after state-changing eval before another model
step—the worker merges fresh projections from their owners:

- **host:** full WP3 panel forest; all active runtime entity kinds and contexts; focus, pins,
  leases; workspace membership and WP8 presence; units/build health; approvals; notifications;
  incidents; devices; updates; settings status;
- **workspace:** channel/session index, durable members, live participants/presence, agent bindings,
  last activity, and panel command registry;
- **device:** verified current focus/card state and availability of local semantic operations.

The overview has no depth, owner, row, or recent-activity filter. It contains bounded structural
metadata, not log bodies, message history, secrets, panel payloads, or arbitrary extension state.
Projection failures are explicit; stale state is never presented as complete. It is ephemeral
turn context, not transcript history. The same assembler is callable as a typed service from eval.

### 3.4 Full eval as the shell interface

`SystemAgentWorker.getLoopTools(channelId)` returns exactly the normal `eval` tool and `say`.
`memory_recall`, which is currently added outside `getLoopTools`, is disabled through a general
base-class seam so the invariant is real.

Eval is unchanged from ordinary agents:

- TypeScript/JavaScript, workspace imports, and the full `@workspace/runtime` surface;
- `services`, `rpc`, context-sandboxed `fs`, VCS/runtime APIs, network helpers, `panelTree`, and `chat`;
- per-conversation persistent `scope` and SQLite `db`;
- service/help discovery, console capture, async runs, output windowing, and recovery pointers.

The System Agent prompt includes a bundled eval-first shell handbook whose recipes are validated
against real service schemas. It teaches complete overview refresh, panel/entity/workspace/unit/
channel operations, approvals/delegations, logs, palette commands, device methods, cards, and
debug-session launch. There are no corresponding special model tools.

Examples of former tools folded into eval:

| Former special surface | Eval path |
| --- | --- |
| overview/list/inspect tools | call typed overview/domain services and aggregate in code |
| bounded `logs_query` | page/query unified logs, process in eval, return refs/summary |
| `palette_list` / `palette_run` | use the panel command registry/service |
| `spawn_debug_session` | call the normal agent/channel launch APIs and publish a briefing/link |
| fs/VCS/docs/web tools | use eval bindings/imports and `help()` |
| subagent tool | launch an ordinary agent/channel through runtime services |

There is no System Agent-specific log row ceiling: ordinary service/RPC/eval output limits apply,
and code can process large data without copying it all into model context.

`fs`, `node:fs`, `node:fs/promises`, file-backed eval, `services.fs`, `callMain("fs.*")`, and raw
`rpc` filesystem calls all terminate in the same context filesystem capsule. The host derives the
EvalDO's immutable `contextId` from its registered owner; eval code cannot select a context. No
route exposes native host paths or the extension-only `host-fs-access` authority.

### 3.5 Semantic parity and shared services

Every desktop/mobile user-visible shell operation maps to one typed owning service/runtime method.
Ordinary semantic methods are also reachable from System Agent eval; the explicit human-input,
consent, administration, and renderer exceptions below remain in that same service plane. If
behavior currently lives only in a React coordinator or Electron click handler, factor it into the
owning shared implementation and have chrome call it.

A CI coverage map classifies each UI operation as:

1. shared service/runtime method reachable from eval;
2. renderer plumbing with a non-semantic rationale; or
3. human secret-value input with an eval-callable form-routing method; or
4. human approval consent: protected payload/settle methods remain chrome- or exact
   delegation-micro-session-only, while delegation-policy activation, renewal, or widening is
   verified-chrome-only; or
5. independent trust-root administration, which the System Agent may inspect but cannot apply to
   its own blessed EV, grants, prompt/tool policy, locked roster, approval rules, credential
   extraction rules, or audit integrity.

CI validates the method, eval authority, UI call path, and bundled prompt recipe. The map does not
generate tools, wrappers, confirmation flows, or result envelopes. A direct service call from eval
is the intended architecture—not a bypass.

Parity covers panels/views, all runtime entities, workspaces/targets, units, profiles/presence,
channels/sessions/participants, pending-approval metadata/delegation drafting/listing/revocation, notifications/incidents, ordinary settings/updates,
apps/cache, devices/credentials/forms, autofill/external-open, panel commands, logs, and normal
agent/channel launch.

### 3.6 Runtime authority and audit

The EvalDO's own runtime id is not sufficient authority. Host calls prove its owner/subKey chain
and exercise grants bound to the seed-blessed System Agent EV. Acting user, originating device,
workspace, conversation, and turn are stamped at ingress and propagated by eval; source code
cannot supply them.

Owning-service authorization, WP0 visibility, channel membership, device binding, severity gates,
and normal approval behavior continue to run. Audit records include EvalDO, blessed owner EV,
acting user/device, conversation/turn, service method, redacted arguments, and outcome. An edited
worker, copied package name, unrelated EvalDO, or forged owner chain receives no grants.

Direct owning-service calls are intended; direct access to host databases, identity registries,
approval stores, credential material, audit storage, or other backing state is not. Credential
clients may perform an authorized use through opaque bindings but never return stored secret
material. The System Agent cannot bless its replacement, alter its grants or product prompt/tool
policy, unlock its channel, weaken approval/audit rules, or otherwise authorize itself.

Platform-wide execution limits still apply: eval cancellation/deadlines, bounded concurrent runs,
agent/channel spawn quotas, service rate limits, and fan-out limits prevent resource exhaustion.
They constrain consumption, not which semantic shell operations eval can express.

There is deliberately no `shellActionReceipt`, generated action wrapper, model proposal token, or
typed-turn intent compiler. A verified human gesture authorizes starting a privileged agent turn;
within the turn, eval can use the full service authority of that agent. This is powerful and is an
explicit product stance, not a hidden exception.

Human consent is a governance boundary outside that authority. The conversation EvalDO is denied
approval payload read/settlement regardless of its shell grants. Only shell chrome acting as the
human, or an isolated matched-policy micro-session carrying the exact evaluation token, may
read/settle the protected request.

Expanding delegated consent is part of that boundary. Conversation eval may draft, list, explain,
and revoke policies, but only a verified human chrome call may activate a draft, renew a policy,
or apply any edit that could widen scope, duration, budget, severity, or future authority.

### 3.7 Debug sessions

From eval, the System Agent calls the existing `launchAgentIntoChannel` path to create a normal
userland agent/session. It publishes a briefing with canonical target refs, selected structural
context, symptom/incident details, and log refs. The child receives its ordinary tools, skills,
model, and approval policy; it inherits no System Agent grants or conversation history. A bundled
debug-link card opens the ordinary session on desktop/mobile.

### 3.8 Prompt and model isolation

The worker uses a product-owned supervisor prompt and bundled eval handbook. Workspace prompt files,
skill indexes, channel system-prompt overrides, MCP resources, and dynamically advertised model
tools are not mounted. This controls the initial instruction/tool definition; it does not prevent
eval from reading/importing workspace code when doing work.

The model resolves from a host-level per-user System Agent setting, falling back to the workspace
default only when absent. The worker is a pinned launch at the blessed EV; product upgrades
explicitly re-bless a new EV through the independent human/admin path, never through System Agent
eval.

## 4. Trust and injection stance

Threat: userland is vibe-coded and web-touching. Panel titles, source files, service results,
participant names, command metadata, logs, watcher summaries, and approval display copy can all be
attacker-influenced.

Defenses, in order of structural strength:

1. **Watcher capability firewall.** The always-on reader of unbounded hostile logs has no eval,
   service tools, or conversation publishing path. Its worst direct outcome is a notification.
2. **Human-turn gate.** The privileged conversation never wakes on logs/events/timers. A human must
   type, forward, share, or invoke delegate.
3. **Identity and existing authorization.** Full eval calls retain blessed owner EV and acting
   user/device lineage. Owning services, ordinary approvals, visibility, and audit still apply.
4. **Environment integrity.** Product prompt/model policy, pinned code EV, EvalDO owner binding,
   and locked roster cannot be replaced by workspace code or another worker.
5. **Bounded model transport and inert rendering.** Eval can process large datasets in code;
   returned text is windowed, cards render untrusted fields inert, and the prompt advises against
   treating data as instructions.
6. **Render-don't-re-quote** as a soft quality mitigation.

Explicitly not claimed: that demarcation, prompt guidance, or the human-turn gate prevents prompt
injection from causing an authorized eval action. Full eval and that guarantee are incompatible
unless eval is reduced to a mediated action language—which this design rejects. Existing approval
gates remain meaningful, but operations already authorized to the System Agent may be performed by
model-chosen code.

## 5. Delegated approvals

The exact implementation lives in `system-agent-sa1-delegation-spec.md`.

### 5.1 Flow

1. A user chooses “Delegate similar to agent…” on an approval card.
2. The System Agent receives the structured approval as a human-authored turn and uses eval to call
   the delegation service, producing a draft policy.
3. The UI renders a review card with host-generated scope choices, TTL, use budget, severity cap,
   and presence option. Confirmation calls the ordinary delegation service as the acting user.
4. A confirmed policy immediately applies to the triggering request if it remains pending.

Full eval includes non-expanding delegation-policy management: the System Agent can propose/list/
explain/revoke through ordinary services. Eval-authored proposals and edits remain drafts;
confirmation and renewal are verified human chrome calls, and only those calls activate new
authority. These operations are not special model tools.

### 5.2 Policy and matching

Policies bind only to host-verified issuer/subject facts, never display copy. They include owner,
granting-device attribution, approval kind, issuer code identity/EV, subject matcher, optional
channel scope, evaluation mode (`agent | auto`), guidance, use budget, expiry, severity cap, and
optional grantor-presence requirement.

Defaults remain `maxUses: 100`, TTL 30 days, `maxSeverity: routine`; routine policies may be
until-revoked. Drafts expire after 24 hours. Issuer EV/options-fingerprint changes lapse rather than
silently widen a policy; human renewal re-pins verified current facts and preserves lineage.

### 5.3 Evaluation micro-sessions

Matched `evaluation: agent` requests run as fresh single-shot policy invocations with only the
structured request, policy, host-computed issuer/severity facts, and recent decisions. They receive
no conversation history, logs, workspace prompt, or full eval. Their sole output is
`approve_once | deny | escalate`, bound to a single-use evaluation token and
30-second timeout. `auto` policies skip the model when allowed by the kind-specific rules.
(An earlier draft included a `userland_choice` verdict for delegated advisory
`userlandApproval` prompts; that surface is deleted by the userland-capabilities
prerequisite's hard cut, and receiver-enforced userland capabilities delegate as
ordinary capability approvals — see the SA1 spec's excision note.)

That evaluation token is not an action receipt for ordinary eval. It binds one already-delegated
approval request to its isolated consent decision and cannot authorize or mediate any shell
operation.

The micro-session is not the System Agent conversation and therefore does not violate the
conversation's eval/say tool invariant.

### 5.4 Severity gate and provenance

- `routine`: delegable by default.
- `sensitive`: requires explicit policy opt-in and finite expiry.
- `critical`: never delegated; always falls through to human surfaces.

Unknown kinds/scopes classify critical. Decisions settle through the WP5 coordinator and stamp
policy id/version, evaluation mode, rationale, budget, issuer EV, acting user, and provenance.

## 6. Log Watcher

The exact build contract lives in `log-watcher-spec.md`.

### 6.1 Mechanical pipeline

The hub tails panel, worker, and server log stores. It byte-bounds records, normalizes volatile
values, hashes signatures, counts exact windows, tracks source attribution, and stores bounded
exemplars. `verbose`/`info` do not enter notification/model evaluation; `warn`/`error` do.

Signature state is `new | notified | muted | benign | storming`. Notifications use cooldown
backoff. Mutes/dismissals are shared and attributed; stars/watches are per user. Silence remains
inspectable through ignored-shape rows and suppression counters.

### 6.2 Model evaluator

Novel/rate-transition signatures batch into one long-running, capability-free cheap-model session
per hub (30 seconds or 16 items). It emits only `notify | ignore`, severity, and a short summary.
Exact counts/state remain mechanical. The session has no eval, services, shell access, or channel
publishing. At ~50k tokens it emits a compact pattern summary and restarts.

### 6.3 Storms and retention

A source over 120 records/min for two consecutive completed minutes enters storm mode. One storm
card replaces per-signature spam; adaptive 1-in-K sampling caps known-shape processing while novel
signatures are always retained. A dominant-signature mix change may re-notify. Ten quiet minutes
ends the storm. Signatures expire after 30 days of inactivity with tombstone folding; mutes/stars
remain retention-exempt as specified by the watcher contract.

### 6.4 Human forward

The inbox exposes dismiss, mute, star/watch, and “Investigate with System Agent.” Investigate posts
an attributed `IncidentCard` with mechanical facts and bounded exemplars into the user's locked
conversation. Once there, the full-eval System Agent may query the authorized unified logs directly,
page/aggregate them in code, launch repair sessions, or act on shell state. The forward is a turn
gate, not a promise that incident content cannot influence eval.

## 7. UI

### 7.1 Desktop and mobile

Desktop keeps an ambient mechanical status strip and an overlay drawer containing inbox,
transcript, and composer. Mobile uses a System screen with inbox first, conversation below, and
approval/delegation management. Both resolve the same per-user conversation.

### 7.2 Cards

Product-bundled cards render overview, panel/entity/presence/channel/unit state, log excerpts,
incidents/storms, delegation drafts, and debug-session links. Cards are structured message payloads,
not model tools. Eval can import their schemas/factories and publish them through `chat`.

Card buttons call ordinary owning service methods as verified UI actions. They do not route through
the model or an agent-specific dispatcher. Untrusted fields render as inert text with no dynamic
renderer registration, markdown, HTML, or executable links.

## 8. Phasing

- **SA0 — Full shell eval + runner + desktop.** General EvalDO owner-lineage support; shared shell
  service audit/parity gate; complete `ShellOverview`; pinned `SystemAgentWorker`; exactly eval/say;
  bundled schema-validated eval handbook; locked channel; cards, ambient strip, and drawer.
- **SA1 — Delegated approvals.** Policy store/confirmation, severity classifier, isolated
  micro-session evaluation, WP5 provenance, lapse/renewal, management surface.
- **SA2 — Watcher mechanics.** Signature store/normalizer, storm ladder, inbox actions, push budget.
- **SA3 — Watcher model.** Pinned cheap-model evaluator, verdict cache, summaries/severity.
- **SA4 — Mobile.** System screen, push routing, starring/watch UI.

## 9. Committed stances

1. Full eval is intentional. It includes the complete context-sandboxed filesystem, imports,
   network, service/RPC access, shell operations, and programmatic composition in the shell-owned
   context; it has no raw host- or cross-context filesystem route.
2. There is no action receipt or special intent compiler. Prompt injection can influence an
   authorized action; documentation and tests must state that honestly.
3. The watcher remains strictly weaker: no eval/tools and no automatic conversation path.
4. Renderer plumbing and human secret values are not model capabilities; semantic device/form
   routing remains callable from eval.
5. Non-delegated approval payloads and settlement remain inaccessible to conversation eval;
   matched delegation micro-sessions receive only the exact request/token in policy scope.
   Delegation activation, renewal, and widening require verified human chrome.
6. The System Agent cannot mutate its own trust root or extract stored credential material; direct
   service calls never imply access to owning services' backing stores.
7. Watcher calibration starts at 50k-token compaction, 30-second/16-item batches, and
   120 records/min for two minutes; burn-in may tune values without changing mechanisms.
