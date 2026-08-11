# Getting started

The first-run chat opens directly in the transcript. The agent reads
[SKILL.md](SKILL.md), gives a short welcome, and renders
[SetupHub.tsx](SetupHub.tsx) inline with the stable ID
`onboarding-setup-overview`. The component displays its panel-scope cache and
refreshes capability-owner state on mount. Onboarding does not install an
action bar.

## Run the setup projection

Render the base-owned setup hub by path with no leading `client_eval` and no
snapshot props. In a non-panel client,
summarize blocking and attention states concisely and mention that all other
configuration is optional. A missing owner for a capability shipped in base is
unavailable, not installable.

The component loads installed capability definitions and statuses directly.
It does not load optional templates on mount. The user must choose **Load
optional templates** after reading the explanation that templates are reviewed
workspace additions and discovery contacts the verified registry.

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
Templates skill, and pass its registry-bound selection to the canonical
reviewed `add` workflow. The onboarding card never edits the workspace directly. The
Templates workflow owns resolution, contribution merge, approval, and
operation recovery.

The component handles refresh and connection checks directly and caches the
result in panel scope. After any external workflow outcome, render the setup
hub by path with the same stable ID and no snapshot props. The update replaces
and bumps the card; its render revision triggers a fresh owner read.

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

Template trust/provider suggestions are not structured input for agent
reasoning. Propose them through the Templates workflow and let the protected
workspace approval card carry the decision. Never ask for the same choice in
`feedback_custom`, chat, inline UI, or an action bar first.
