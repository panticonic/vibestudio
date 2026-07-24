# Getting started

The first-run chat opens with a compact “Preparing setup overview…” action bar.
The agent reads [SKILL.md](SKILL.md), composes the authoritative snapshot, gives
a short welcome, renders [SetupHub.tsx](SetupHub.tsx), and clears the action
bar.

## Run the setup projection

Use `client_eval` to statically import `composeOnboardingSnapshot` from
`@workspace-skills/onboarding` and return its result. This runs the one
composer inside the inviting chat panel, where direct owner APIs and the
redacted Electron host topology read are both reachable.

Render that array as the `snapshot` prop of the checked-in setup hub. Do not
recreate its catalog in prose. In a non-panel client, summarize blocking or
attention states concisely and mention that all other configuration is
optional.

## Handle a choice

The user message contains an `interaction` object. Through `client_eval`,
statically import `executeOnboardingSelection` from
`@workspace-skills/onboarding` and pass the complete structured object, then
follow an unhandled owner target. The function performs validated About, panel,
and shell navigation. This is the only selection route; the visible sentence
is for people and transcript replay, not dispatch.

Owner workflows remain authoritative:

- Google and GitHub setup/checks use their dedicated skill helpers.
- Browser migration uses `extensions/browser-data/SKILL.md`.
- Enhanced search uses `skills/web-research/SKILL.md`; DuckDuckGo is already a
  healthy default.
- Model/provider and agent-default changes use model settings.
- Device and remote controls open the typed shell connection surface.
- Credential inspection/revocation and agent grants open their distinct About
  pages.

After any check or workflow outcome, call the composer through `client_eval`
again and render a new observation. A Google/GitHub check passes the selected
ID as `verifyCapabilityId`. Do not update an old card optimistically.

## Continue from intent

Ready-now choices begin work directly. For example, a PDF choice asks for the
document or starts an ingestion task; it never creates a PDF setup flow.
Channel and project configuration is disclosed only when the user chooses that
channel or project goal.

Use the owner’s trusted workflow UI for OAuth, credential entry, browser
imports, and other side effects. Use `feedback_custom` when the turn must wait
for structured user input and `inline_ui` for durable results.
