# Getting started

The first-run chat opens directly in the transcript. The agent reads
[SKILL.md](SKILL.md), composes the authoritative snapshot, gives a short
welcome, and renders [SetupHub.tsx](SetupHub.tsx) inline. Onboarding does not
install an action bar.

## Run the setup projection

Use `client_eval` to statically import `composeOnboardingOverview` from
`@workspace-skills/onboarding` and return its result. This runs the one
composer inside the inviting chat panel, where direct owner APIs and the
redacted Electron host topology read are both reachable.

Render `{ catalog, snapshot, templates }` with the base-owned setup hub using
the stable inline UI ID `onboarding-setup-overview`. In a non-panel client,
summarize blocking and attention states concisely and mention that all other
configuration is optional. A missing owner for a capability shipped in base is
unavailable, not installable.

## Handle a choice

The user message contains an `interaction` object. Through `client_eval`,
statically import `executeOnboardingSelection` from
`@workspace-skills/onboarding` and pass the complete structured object, then
follow an unhandled owner target. The function performs validated About, panel,
and shell navigation. This is the only selection route; the visible sentence
is for people and transcript replay, not dispatch.

Panel navigation focuses the destination and waits for application readiness.
It includes the committed `panelId` and reports `readiness: "ready"`. An
`unconfirmed` result means the slot was committed but readiness failed; it
includes the structured failure, so do not retry the open while readiness is
uncertain.

Owner workflows remain authoritative:

- Google and GitHub setup/checks use their dedicated skill helpers.
- Browser migration uses `extensions/browser-data/SKILL.md`.
- Enhanced search uses `skills/web-research/SKILL.md`; DuckDuckGo is already a
  healthy default.
- Model/provider and agent-default changes use model settings.
- Device and remote controls open the typed shell connection surface.
- Credential inspection/revocation and agent grants open their distinct About
  pages.

For an `onboarding-template` interaction, call
`resolveOnboardingTemplateSelection` through `client_eval`, read its returned
Templates skill, and use its registry-bound selection with the canonical `prepareAdd` and
reviewed `add` workflow. The onboarding card never installs directly. The
Templates workflow owns exact selection, contribution review, approval, and
operation recovery.

After any check or workflow outcome, call the composer through `client_eval`
again and render the setup hub with the same stable ID. The fresh projection
replaces the existing card and bumps it to the end of the transcript. A
capability check passes the selected ID as `verifyCapabilityId`; do not update
the card optimistically before the owner observation completes.

## Continue from intent

Ready-now choices begin work directly. For example, a PDF choice asks for the
document or starts an ingestion task; it never creates a PDF setup flow.
Channel and project configuration is disclosed only when the user chooses that
channel or project goal.

Use the owner’s trusted workflow UI for OAuth, credential entry, browser
imports, and other side effects. A self-contained setup workflow uses
`inline_ui` and calls its trusted helpers directly; it does not return choices
to the agent for translation into eval code. Use `feedback_custom` only when
the agent truly needs structured input for later reasoning. One setup
selection produces one cohesive owner workflow; do not chain small feedback
forms for access, provider, browser, or permission choices that can be shown
together or derived from a recommended default.
