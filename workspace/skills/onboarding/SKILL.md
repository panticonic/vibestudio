---
name: onboarding
description: Open or maintain Vibestudio's state-aware setup overview, route a selected capability to its owner workflow, refresh owner state, or hand off an optional template installation.
---

# Onboarding

Onboarding projects durable state from each capability owner. It does not keep
completion flags, infer authority, or turn ordinary product features into a
checklist.

## Open the overview

Render the checked-in component with a stable ID:

```text
inline_ui({
  id: "onboarding-setup-overview",
  path: "skills/onboarding/SetupHub.tsx",
  props: {}
})
```

Do not compose a snapshot first or pass private state as props. The component
uses its panel cache immediately, then reads capability-owner state. A failed
owner read becomes an honest unknown or unavailable row without suppressing
other capabilities.

Template-registry discovery is user-initiated through the overview. Do not
contact the registry during the initial capability load.

## Route a selection

The component sends readable text plus typed interaction metadata. Route the
complete interaction object, never its label:

- For a capability interaction, call `executeOnboardingSelection` from
  `@workspace-skills/onboarding` through `client_eval` because navigation is
  client-affine.
- For a template interaction, call `resolveOnboardingTemplateSelection`, then
  pass its exact registry-bound selection to
  [Templates](../templates/SKILL.md).

Follow the returned discriminant. A committed panel slot with unconfirmed
readiness must not be opened again. Owner-skill, model-setting, and conversation
routes return their authoritative next target; do not match button prose or
invent a fallback route.

After the client-affine handoff, use ordinary server-side eval unless work
depends on the inviting client's DOM, panel state, or native transport.

## Refresh

The component owns check and refresh controls. After setup succeeds, fails, is
cancelled, or changes externally, render the same component ID again with no
snapshot props. Report the operation, but do not claim a row's refreshed state
before the component reads it.

For template operations, honor the composer's `contextIntegration` result:
refresh after `integrated`, merge normally after `needs-merge`, and do not claim
this conversation observes the result after `unavailable`.

## Product rules

- Show durable preparation, not every ready-on-demand capability.
- Keep optional configuration neutral and omit completion denominators.
- Connection status is not effect authorization. Route repair, credentials,
  model settings, and grants to their owning surfaces.
- Keep secrets in host-owned credential input, never chat or inline props.
- Open one owner-controlled workflow for each selection. Do not replace it with
  a chain of feedback questions or a custom approval UI.
- Onboarding may suggest verified template outcomes, but Templates remains the
  sole installation and update path.

Read [GETTING_STARTED.md](GETTING_STARTED.md) for the execution recipe,
[OVERVIEW.md](OVERVIEW.md) for product concepts, and
[REMOTE_SERVER.md](REMOTE_SERVER.md) for remote setup.
