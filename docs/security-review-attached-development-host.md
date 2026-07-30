# Attached development host threat model

Status: accepted for RFS-4C\
Date: 2026-07-27

## Scope

RFS-4C connects a development run on a parent Vibestudio host to one exact
generation of an isolated child host. The route lets ordinary generated service
clients reach the child and lets the child present an approval challenge on the
parent.

This review covers only that route. Local semantic builds, isolated process
launch, the current-host Electron client, and native-tool checkpoints do not
cross this trust boundary and do not depend on it.

## Security objective

Compromise of either route endpoint must not create authority that the other
host would refuse locally. A routed invocation is admitted only by the
intersection of:

1. the parent's verified initiating runtime/user authority;
2. the immutable route ceiling;
3. the child's verified caller/session and receiver policy;
4. the child's live grants, relationships, locks, and denials.

The route transports an invocation. It is neither a principal nor a grant.

## Required protocol

### Session establishment

The parent and child generate fresh ephemeral Ed25519 keypairs. Private keys
remain process-memory-only and are zeroized on close where the platform permits.
The durable session record contains public keys and hashes, never a private key,
admin token, device secret, or reusable bearer credential.

Both sides sign the same canonical transcript:

```text
protocol version
parent host id
child host id
child generation id
development run id
initiating runtime id
initiating runtime kind
initiating user id
authority ceiling digest
issued at
expires at
parent route public key
child route public key
```

The transcript is accepted only after each side independently verifies all
locally owned facts. In particular, the child derives and stores the effective
ceiling; it never accepts a ceiling asserted only by the parent.

The executor's ordinary pairing credential is bootstrap-only. It is scoped to
the exact child generation, exchanged for the route session, and revoked once
the route is ready. It cannot remain as an unbounded alternate data path.

### Routed invocation

Every routed envelope contains a monotonically unique message id, session id,
child generation, expiry, method, canonical arguments digest, and the signed
parent invocation reference. The child rejects:

- unknown or closed sessions;
- wrong generation, owner, run, or host;
- expired messages;
- repeated message ids;
- a method/argument digest mismatch;
- an invocation outside the child-stored ceiling.

Relationship facts such as context, owner, channel, mission, entity, and host
generation are resolved from the verified session and child state. They are not
accepted from method arguments.

### Approval challenge

The child first performs its ordinary dispatch preparation and signs:

```text
route session id
child generation
single-use challenge nonce
canonical invocation snapshot digest
capability and resource
tier and operation-substance digest
challenge expiry
```

The parent verifies the signature and session facts, reconstructs presentation
from the signed canonical snapshot, and records the exact digest shown to the
user. A decision signs that same digest, nonce, session, generation, decision,
and expiry.

The child consumes a decision at most once and only for the still-pending
prepared invocation with the identical snapshot digest. It then runs its own
authority evaluator and mints its own exact once grant or denial. The
parent-signed decision is evidence for that one acquisition; it is not itself a
child grant.

## Threats and controls

### Route-key compromise

A stolen private route key is bounded to one run, one child generation, one
owner, one ceiling, and a short expiry. It cannot authenticate after restart or
generation change. Session closure immediately revokes the public key binding.

Keys and signed envelopes must be redacted from ordinary logs. Diagnostics may
retain public fingerprints, session ids, and invocation digests.

### Approval replay or substitution

Generation, session, challenge nonce, invocation digest, decision, and expiry
are signed together. The child durably marks the nonce consumed before exposing
the grant. A decision for invocation A therefore cannot authorize invocation B,
survive a child generation change, or be replayed after a lost response.

Run ids are not sufficient replay protection and never replace the nonce or
invocation digest.

### Ceiling bypass

The child computes the effective ceiling from its local policy and the
mutually-signed transcript, stores its digest, and intersects it during every
dispatch. A compromised parent can request a broader transcript, but the child
refuses it. A compromised child cannot make the parent present an acquisition
outside the parent-side initiating authority.

The implementation must represent authority as an intersection over ceilings.
It must not convert the ceiling into a copied grant list.

### Confused deputy and dishonest presentation

The parent never displays free-form child prose as the operation substance.
Presentation is derived from the signed canonical invocation snapshot,
capability metadata, resource key, tier, and prepared operation digest. Before
execution, the child proves it is resuming that exact prepared invocation.

If either side cannot resolve the same canonical substance, the challenge
fails; no "best effort" prompt is shown.

### Route loss and partition

Route loss closes all pending challenges. The parent records them as
`route-lost`, not denied or approved. The child mints no grant until it verifies
the signed decision, so a decision stranded on the parent has no effect.

An already-running child effect retains only its ordinary child-side cleanup
authority. Cleanup does not depend on the parent route. The development run
surfaces the interruption and offers inspect, reattach/restart where provable,
force-retire, or keep.

### Credential isolation

The execution environment must omit parent and child admin tokens, database
paths, inspector endpoints, profile encryption keys, unrelated device
credentials, and management secrets. The route endpoint receives only its
ephemeral private key through an inherited private handle or equivalently
protected channel; it does not receive a general RPC credential.

The child admin token is never serialized into a route message or development
record.

### Downgrade

An attached development run has exactly one supported remote service path. The
parent refuses an unattached direct child address, an older generation, an
expired route, an unsigned envelope, or a bootstrap credential after exchange.
Protocol versions are exact; there is no fallback reader for an older or weaker
shape.

## Availability and cleanup

Security failure is fail-closed and may retain resources:

- uncertain process ownership retains the process/root and enters
  `requires-repair`;
- route or provider failure suppresses destructive cleanup that depends on the
  missing proof;
- cleanup errors remain secondary to the original build, start, invocation, or
  approval failure and are retained for inspection.

Force-retire may remove only roots, processes, credentials, and registry rows
whose ownership is proven by the exact run and generation.

## Mandatory negative tests

RFS-4C cannot ship until automated tests prove:

- a stolen key cannot cross run, owner, host, generation, ceiling, or expiry;
- a decision cannot be replayed, substituted, or consumed twice;
- a parent-requested broader ceiling is rejected by the child;
- a child-provided display string cannot change approval substance;
- route loss before decision consumption mints no grant;
- bootstrap credentials are unusable after route establishment;
- direct/old-generation/expired downgrade paths are rejected;
- admin and unrelated credentials are absent from the executor environment and
  persisted records;
- force-retire refuses a foreign process or path;
- cleanup failure preserves the primary error and exact retained-resource ids.

Passing happy-path connectivity tests is not acceptance for this threat model.

## Acceptance evidence

The review is accepted only with the implementation and automated evidence
below. Every row names the test that fails if the asserted boundary regresses.

| Claim | Automated evidence |
|---|---|
| Session keys are exact-run, exact-owner, exact-runtime-kind, exact-host, exact-generation, ceiling-bound, and expiring | `src/server/services/attachedHostProtocol.test.ts` — “rejects a stolen/substituted route proof crossing …”, “does not let one host's stolen route key cross to another child host”, “rejects expired sessions …” |
| Protocol, argument, direct-address, old-generation, and replay downgrades fail closed | `src/server/services/attachedHostProtocol.test.ts` — “rejects argument substitution and monotonically replayed envelopes”, “accepts valid concurrent delivery out of message-id order”, “rejects expired sessions and downgrade to an unknown direct route”; `src/server/services/attachedHostController.test.ts` — foreign generation and recovery drift |
| A parent cannot widen the child-local ceiling; a fixed-code initiator cannot be widened to interactive authority | `src/server/services/attachedHostProtocol.test.ts` — “rejects a parent-requested ceiling broader than child-local policy”; `packages/shared/src/serviceDispatcher.attachedHost.test.ts` — broad live grants, expiry, and digest drift; `src/server/services/developmentService.test.ts` — “persists a fixed-code initiator's manifest as the attached route ceiling” |
| Approval presentation is parent-canonical and child prose is inert | `src/server/services/attachedHostProtocol.test.ts` — canonical decision/dishonest presentation cases and explicit display-text exclusion; `src/server/services/attachedHostTransport.test.ts` — canonical parent queue request |
| Decisions cannot be substituted, replayed, or consumed twice | `src/server/services/attachedHostProtocol.test.ts` — exact decision binding, substitution, and second-consumption rejection; `src/server/services/attachedHostSessionStore.test.ts` — durable replay rejection across reopen |
| Route loss before child consumption mints no grant and eval reports a distinct restartable terminal condition | `src/server/services/attachedHostProtocol.test.ts` and `src/server/services/attachedHostTransport.test.ts` — route-loss/no-grant cases; `packages/builtin/src/eval-engine/EvalDO.cancel.test.ts` — “persists approval route loss as a distinct restartable terminal condition” |
| Bootstrap credentials are revoked and cannot remain as a management fallback | `src/server/services/attachedHostTransport.test.ts` — exact remote-device revocation, file removal, and later-use rejection; `src/server/services/isolatedDevelopmentHostExecutor.test.ts` — attachment/management lifecycle |
| Private keys and reusable credentials are absent from durable attached records | `src/server/services/attachedHostProtocol.test.ts` — public-material-only record; `src/server/services/attachedHostSessionStore.test.ts` — explicit private-key/refresh-token persistence rejection |
| Parent/admin/unrelated credentials are absent from the child environment | `src/server/services/isolatedDevelopmentHostExecutor.test.ts` — explicit forbidden environment-key census and no refresh-token serialization |
| Intentional stop wins the child-exit race; a foreign process generation is never signalled or unregistered | `src/server/services/isolatedDevelopmentHostExecutor.test.ts` — “makes intentional stop own the exit race and refuses a foreign generation”; `src/dev/devInstanceSupervisor.test.ts` — exact process-group termination |
| A foreign or escaped execution root is never executed or deleted | `src/server/services/developmentExecutor.test.ts` — “refuses path escapes and foreign owner markers before execution or deletion” |
| Cleanup failure preserves the original failure plus exact retained run/artifact identities | `src/server/services/developmentService.test.ts` — “preserves the primary failure and exact retained ids when force-retire cleanup fails”; unproven process ownership remains `requires-repair` rather than claiming retirement |
| Production exposes the promised owner-scoped ordinary child-service surface | `src/server/services/attachedHostController.test.ts` — owner validation and generic child invocation; `workspace/packages/runtime/src/shared/hostedRuntime.test.ts` — `hosts.attach(...).services.<service>.<method>`; `src/server/index.ts` is the production controller/service/runtime-route composition |

Acceptance command boundary:

```text
pnpm exec tsc --noEmit --pretty false
pnpm vitest run \
  src/server/services/attachedHostProtocol.test.ts \
  src/server/services/attachedHostSessionStore.test.ts \
  src/server/services/attachedHostController.test.ts \
  src/server/services/attachedHostTransport.test.ts \
  packages/shared/src/serviceDispatcher.attachedHost.test.ts \
  src/server/services/developmentService.test.ts \
  src/server/services/developmentExecutor.test.ts \
  src/server/services/isolatedDevelopmentHostExecutor.test.ts \
  src/dev/devInstanceSupervisor.test.ts \
  packages/builtin/src/eval-engine/EvalDO.cancel.test.ts \
  workspace/packages/runtime/src/shared/hostedRuntime.test.ts
```
