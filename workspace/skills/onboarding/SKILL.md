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
base-owned composer inside the inviting panel, the shared boundary that can
reach workspace owners and the redacted Electron host read.

Render the returned array with `inline_ui` from
`skills/onboarding/SetupHub.tsx`, passing `{ snapshot }`. The composer reads
Google, GitHub, model settings, agent defaults, local models, browser imports,
and web search directly from their owners. It composes device/workspace topology
from `hubControl.listDevices` and `hubControl.listWorkspaces`, plus the
client-local route mode. A failed read becomes an honest `unknown` row and does
not suppress the rest. These owners currently ship in the base workspace. If
one cannot be discovered, that row is **Unavailable** because the shipped base
capability is broken or incomplete; onboarding never offers a template as a
substitute.

The opening message is short. The inline setup overview is the first-screen
information architecture. Do not load or publish an onboarding action bar.

## Capability selections

For agent-owned selections, the component sends readable text and typed message
metadata.

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
checked-in function validates the selection and performs About, workspace-panel,
and shell navigation in the inviting client.

- `owner-skill`: read `route.ownerSkillPath` and use that owner workflow.
- `model-settings`: use the model-settings provider/default workflow.
- `conversation`: explain or begin using the ready capability.

Client-owned panel navigation focuses the destination and waits for its exact
application readiness before returning `handled: true` with the committed
`panelId` and `readiness: "ready"`. If the slot was committed but readiness
failed, the result is `readiness: "unconfirmed"` with the structured failure;
do not repeat the open because that panel slot is already committed.
shell navigation returns `handled: true`. Owner/model/conversation routes
return `handled: false` with the authoritative target. An unconfirmed result
also includes the structured failure. Unknown IDs and
unsupported actions are errors. Do not fall back to matching button prose.
`client_eval` owns only the client-affine snapshot and selection boundary.
After an `owner-skill` handoff, use ordinary server-side `eval` for owner
helpers unless the operation actually depends on the inviting panel's DOM,
loaded modules, panel-local scope, or Electron-local host transport. Portable
runtime helpers such as `openExternal()` work from either eval path and retain
their normal approval flow.

## Verification and refresh

Stored Google/GitHub credentials are `connected-unverified`. For a `check`
action, use `client_eval` to call
`composeOnboardingSnapshot({ verifyCapabilityId: interaction.targetId })`.

Render a new `SetupHub.tsx` observation. Never rewrite the historical card.
Refresh, workflow success, failure, and cancellation likewise produce a new
snapshot. Inline props must not contain credential material, browser samples,
device IDs, pairing links, profile paths, or private topology.

## Templates

Onboarding reflects the capabilities actually composed into the current
workspace. It does not hard-code planned template ids or advertise future
extractions. Template discovery, preparation, review, and installation belong
to the Templates surface and template composer, which may show only entries
from a verified deployed catalog. If a future optional template is installed,
ordinary runtime owner discovery can expose its setup workflow without adding
a second catalog or installation path to onboarding.

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
- A setup selection opens one owner-controlled workflow surface. Never turn a
  single capability setup into a sequence of one-question feedback forms.
  Owner workflows use persistent inline UI, call trusted helpers directly,
  ask about plain-language outcomes, preselect a recommended default, and hide
  credential formats and permission vocabulary unless an advanced case
  requires them. Do not return selections to the agent just to build an eval
  call.

See [GETTING_STARTED.md](GETTING_STARTED.md) for the concise execution recipe,
[OVERVIEW.md](OVERVIEW.md) for product concepts, and
[REMOTE_SERVER.md](REMOTE_SERVER.md) for remote deployment details.
