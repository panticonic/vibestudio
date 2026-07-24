---
name: onboarding
description: State-aware first-run setup, stable capability routing, and ready-now discovery.
---

# Onboarding

Onboarding projects durable setup state from each capability owner. It does not
store completion flags, infer authority, or treat every product capability as a
checklist item.

## Opening overview

Use the chat panel's `client_eval` tool to statically import
`composeOnboardingSnapshot` from `@workspace-skills/onboarding`, then return
`await composeOnboardingSnapshot()` with no arguments. Client eval runs the
single checked-in composer inside the inviting panel, the shared boundary that
can reach both workspace owners and the redacted Electron host read.

Render the returned array with `inline_ui` from
`skills/onboarding/SetupHub.tsx`, passing `{ snapshot }`. The composer reads
Google, GitHub, model settings, agent defaults, local models, browser imports,
and web search directly from their owners. It makes one additional redacted
`onboardingStatus.read` call for device/workspace/remote topology. A failed
optional read becomes an honest `unknown` row and does not suppress the rest.

The opening message is short. The inline setup overview is the first-screen
information architecture. Clear the preparing action bar after it renders.

## Capability selections

The component sends readable text and typed message metadata:

```ts
{
  interaction: {
    source: "onboarding-setup-hub",
    kind: "onboarding-capability",
    action: "setup",
    targetId: "connection.github"
  }
}
```

Resolve the structured interaction through `client_eval`: statically import
`executeOnboardingSelection` from `@workspace-skills/onboarding` and pass the
complete `interaction` object; never route from its readable label. The
checked-in function validates the catalog and performs About, workspace-panel,
and shell navigation in the inviting client.

- `owner-skill`: read `route.ownerSkillPath` and use that owner workflow.
- `model-settings`: use the model-settings provider/default workflow.
- `conversation`: explain or begin using the ready capability.

Navigation routes return `handled: true`. Owner/model/conversation routes
return `handled: false` with the authoritative target. Unknown IDs and
unsupported actions are errors. Do not fall back to matching button prose.

## Verification and refresh

Stored Google/GitHub credentials are `connected-unverified`. For a `check`
action, use `client_eval` to call
`composeOnboardingSnapshot({ verifyCapabilityId: interaction.targetId })`.

Render a new `SetupHub.tsx` observation. Never rewrite the historical card.
Refresh, workflow success, failure, and cancellation likewise produce a new
snapshot. Inline props must not contain credential material, browser samples,
device IDs, pairing links, profile paths, or private topology.

## Product rules

- Durable preparation is setup. Ordinary work and ready-on-demand capabilities
  are not setup.
- Optional configuration is neutral unless a selected workflow failed.
- Do not show a completion denominator.
- Connection is not authorization. Repair/reconnect belongs to the owner skill;
  credential inspect/revoke to `about/credentials`; model/default change to
  model settings; grants to `about/permissions`.
- Contextual setup such as Gmail, News, custom providers, Slack, or a project
  upstream appears only after the relevant goal is selected.
- Secrets use host-owned credential input. Never ask for them in chat or keep
  them in inline UI state.

See [GETTING_STARTED.md](GETTING_STARTED.md) for the concise execution recipe,
[OVERVIEW.md](OVERVIEW.md) for product concepts, and
[REMOTE_SERVER.md](REMOTE_SERVER.md) for remote deployment details.
