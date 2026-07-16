# Commit, discard, and push

## Commit the complete local chain

Run `vcs.status` and verify the current working counts and head. Run the
relevant tests before committing.

Call `vcs.commit` from the current agent tool invocation with the exact working
head, one globally unique command ID, and an optional message. The operation
commits every local application in order and returns one immutable event. It
does not accept a subset. An authorized direct CLI or lifecycle caller may
commit without pretending to be an agent; its causal walk ends honestly at the
semantic command.

When finishing an integration, commit derives the source from decisions in the
local application chain. Those decisions must all name one source event. If
you also provide `integratesEventId`, it must match the derived source; it
cannot select a different parent. A chain containing decisions for multiple
sources and a caller/decision mismatch are both rejected. For a zero-decision
integration, provide `integratesEventId` explicitly. Commit still checks that
every effective source change is shared or covered by a compatible local
decision. On success, the new event records that source as its second parent.

After success the context is clean: both the committed pointer and working head
name the returned event.

## Discard the complete local chain

Inside an agent, call `vcs({ operation: "discard" })` only when all uncommitted
applications should be dropped; the compact tool supplies the exact live head
and invocation-bound command ID. Direct clients call `vcs.discard` with those
same exact inputs. It returns the discarded
application IDs and restores the committed event as the working head.

Use `revert` when only a named intention should be undone while other local
work survives.

## Publish an already committed event

Call `status` immediately before publication. Refuse to push while the context
is dirty. Supply the exact committed event, observed main event, and a fresh
command ID to `vcs.push`.

Push validates event ancestry and integration completeness, obtains protected
publication approval, and atomically advances protected refs through one
durable effect. It authors no new source history and does not run or certify a
build. Run checks explicitly against the context before publication when they
are useful. A semantic, approval, authorization, or atomic-ref refusal advances
nothing.

A content-identical committed event is still a real semantic-main advance and
still requires approval. Expect an event-level approval rather than a fabricated
file diff. Only replay of the same already-applied publication is approval-free.

On `RevisionChanged`, re-read status and compare with the new main when needed.
On `IntegrationIncomplete`, continue local integration and commit again. On
`Unauthorized`, stop and use the declared approval flow. On
`ExternalEffectFailed`, retain the same command ID only for an identical
uncertain retry.

After success verify the returned `eventId`, `mainEventId`, and durable effect
identity.
