---
name: onboarding
description: Open the state-aware setup overview, route selections to owner workflows, refresh state, or hand off template installations.
---

# Onboarding

Onboarding projects durable state from each capability owner. It doesn't keep
completion flags, infer authority, or turn features into a checklist.

## Open the overview

```text
inline_ui({
  id: "onboarding-setup-overview",
  path: "skills/onboarding/SetupHub.tsx",
  props: {}
})
```

Don't compose a snapshot first or pass private state as props. The component
uses its panel cache immediately, then reads capability-owner state. A failed
owner read becomes an honest unknown or unavailable row without suppressing
other capabilities.

Template-registry discovery is user-initiated through the overview — don't
contact the registry during initial capability load.

## Route a selection

The component sends readable text plus typed interaction metadata. Route the
complete interaction object, never its label:

- **Capability interaction**: call `executeOnboardingSelection` from
  `@workspace-skills/onboarding` through `client_eval` (navigation is
  client-affine).
- **Template interaction**: call `resolveOnboardingTemplateSelection`, then pass
  its exact registry-bound selection to [Templates](../templates/SKILL.md).

Follow the returned discriminant. A committed panel slot with unconfirmed
readiness must not be opened again. Owner-skill, model-setting, and conversation
routes return their authoritative next target; don't match button prose or
invent a fallback.

After the client-affine handoff, use ordinary server-side eval unless work
depends on the inviting client's DOM, panel state, or native transport.

## Refresh

The component owns check and refresh controls. After setup succeeds, fails, is
cancelled, or changes externally, render the same component ID with no snapshot
props. Report the operation but don't claim a row's refreshed state before the
component reads it.

For template operations, honor the composer's `contextIntegration` result:
refresh after `integrated`, merge normally after `needs-merge`, don't claim this
conversation observes it after `unavailable`.

## Product rules

- Show durable preparation, not every ready-on-demand capability.
- Keep optional configuration neutral; omit completion denominators.
- Connection status is not effect authorization. Route repair, credentials,
  model settings, and grants to their owning surfaces.
- Secrets go through host-owned credential input, never chat or inline props.
- Open one owner-controlled workflow per selection. Don't replace it with
  feedback questions or a custom approval UI.
- Onboarding may suggest verified template outcomes, but Templates remains the
  sole install/update path.

Read [GETTING_STARTED.md](GETTING_STARTED.md) for the execution recipe,
[OVERVIEW.md](OVERVIEW.md) for product concepts, and
[REMOTE_SERVER.md](REMOTE_SERVER.md) for remote setup.
