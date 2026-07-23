---
name: onboarding
description: New user onboarding — what Vibestudio is, first-time setup, API provider integrations, browser data import, workspace configuration, and pointers to other skills.
---

# Onboarding Skill

Guide new users through understanding Vibestudio and getting their workspace set up.

## Files

| Document                                             | Content                                                                                                                |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| [OVERVIEW.md](OVERVIEW.md)                           | What Vibestudio is, key concepts, architecture at a glance                                                             |
| [WORKSPACE_STRUCTURE.md](WORKSPACE_STRUCTURE.md)     | Workspace directory layout, meta/, context folders, template vs live                                                   |
| [EXTERNAL_GIT_PROJECTS.md](EXTERNAL_GIT_PROJECTS.md) | External Git declarations, exact semantic snapshot work units, branch config, startup import, and private-repo retries |
| [GETTING_STARTED.md](GETTING_STARTED.md)             | First-time setup: API provider integrations, incremental browser import/open tabs, workspace setup, first panel        |
| [REMOTE_SERVER.md](REMOTE_SERVER.md)                 | Running the state server on a different machine (home server, VPS) and connecting desktop/mobile clients to it         |
| [ActionBar.tsx](ActionBar.tsx)                       | Pinned first-run action bar loaded by the onboarding chat panel                                                        |

## Related Skills

| Skill              | When to use                                                                                           |
| ------------------ | ----------------------------------------------------------------------------------------------------- |
| `browser-import`   | Importing cookies, passwords, bookmarks, history from existing browsers                               |
| `api-integrations` | Connecting third-party APIs (Gmail, GitHub, Slack, etc.) via OAuth                                    |
| `agentic-do`       | Changing the default model/provider; tuning effort, approval, chattiness, or subagent behavior        |
| `web-research`     | Optional Tavily / Brave / Exa API key setup so `web_search` upgrades past DuckDuckGo                  |
| `sandbox`          | Learning the eval tool, inline UI, runtime APIs                                                       |
| `workspace-dev`    | Building and launching panels, workers, full development workflow                                     |
| `appdev`           | Authoring trusted workspace apps under `apps/`: Electron shell, mobile React Native, terminal clients |
| `remote-access`    | Deploying a remote server, pairing desktop/mobile clients, and troubleshooting WebRTC access          |

## First: Detect User Experience Level

Before starting the walkthrough, check whether the user is new or returning and
collect a lightweight setup snapshot:

```
eval({ code: `
  import { browserData } from "@workspace/runtime";
  import { getGoogleOnboardingStatus } from "@workspace-skills/google-workspace";
  import { getActiveSearchProvider } from "@workspace-skills/web-research";

  const config = await services.workspace.getConfig();
  const storedCredentials = await services.credentials.listStoredCredentials().catch(() => []);
  const google = await getGoogleOnboardingStatus()
    .catch(error => ({ error: error instanceof Error ? error.message : String(error) }));
  const importJobs = await browserData.listImportJobs().catch(() => []);
  const searchProvider = await getActiveSearchProvider().catch(() => "duckduckgo");
  const panels = await fs.readdir("panels").catch(() => []);
  const providerIds = [...new Set(storedCredentials.map(c =>
    String(c.metadata?.providerId ?? c.providerId ?? "unknown")
  ))];

  return {
    workspaceId: config.id,
    providerIds,
    storedCredentialCount: storedCredentials.length,
    google,
    searchProvider,
    browserImportCount: importJobs.length,
    panelCount: panels.length,
  };
`
})
```

Use static imports for runtime, workspace packages, and workspace skills in
eval snippets. For standard onboarding probes, import the documented workspace
packages directly. Only split a probe into a separate small eval if you are
checking an optional or custom package that may not be installed in a particular
workspace; tolerate that eval failing. Do not use `await import(...)` to probe
`@workspace/*`, `@workspace-skills/*`, or `@vibestudio/*` packages. `fs` paths are
rooted at the current context folder; `panels` and `/panels` refer to the same
context-root directory, but onboarding examples prefer `panels` to avoid
confusing this with a host absolute path.

- **Little setup evidence** (no stored providers, imports, or panels beyond the
  template) — give the full walkthrough with explanations of key concepts.
- **Existing setup evidence** — be succinct and ask what they need help with.

Workspace catalog operations are intentionally absent from agent eval. They
belong to the human shell's stable hub session; do not probe or mutate the
catalog through the selected workspace child.

## Typical Onboarding Flow

The template onboarding chat panel loads `skills/onboarding/ActionBar.tsx` through
`actionBarFile` in `meta/vibestudio.yml`, so the first setup actions are available
before the agent sends its first message. Treat action bar clicks as the user's
chosen setup path.

### New Users

1. **Explain** — Read [OVERVIEW.md](OVERVIEW.md), introduce key concepts based on what the user already knows
2. **Recommend first actions** — Keep the first reply short and state-aware; rely on the pinned action bar for the initial setup choices
3. **API integrations** — Highlight concrete provider choices: Google Workspace, GitHub, Slack, model/API keys, web-search providers (Tavily / Brave / Exa for `web_search`), or custom OAuth/API provider. Do not gate this on browser data import.
4. **Import browser data** — Use the `browser-import` skill only when the user wants cookies, bookmarks, passwords, or local browser state
5. **First project** — Use the `workspace-dev` skill to scaffold and launch a panel
6. **Connect devices** — If they want phone or remote-machine access, point them
   to Devices → Connect a phone, or the `remote-access` skill for
   `vibestudio remote deploy`, `remote pair-device`, and (for root/admin)
   `remote invite-user`
7. **Explore** — Point to the `sandbox` skill for runtime API exploration

### Returning Users

1. **Welcome back** — Mention their active workspace and how many workspaces they have
2. **Ask what they need** — Don't re-explain concepts. Jump straight to their goal
3. **Point to relevant skills** — Direct them to the right skill doc for what they want to do

## Interaction Patterns

See the sandbox skill's [MDX.md](../sandbox/MDX.md) and [INTERACTION_PATTERNS.md](../sandbox/INTERACTION_PATTERNS.md) for when to use MDX, inline UI, feedback UI, or eval. During onboarding:

- Use the pinned [ActionBar.tsx](ActionBar.tsx) for the initial choice list when the chat panel has loaded it. Use MDX `ActionButton`s for simple follow-up prompts in the transcript.
- Use `feedback_custom` or `inline_ui` after the user chooses a setup path that needs OAuth, provider console links, browser opens, persistence, or error handling. Use `load_action_bar` for compact pinned setup status or controls that should stay visible while the conversation continues.
- Actions like switching workspaces or importing browser data should be workflow UIs, not blind eval calls.

## Guiding Principles

- **Adapt to experience** — check workspace count first, then tailor depth accordingly.
- **Ask what they want to do** — don't dump everything at once. Tailor the walkthrough to their goals.
- **Recommend from state** — mention already configured providers, imported browser data, and existing panels before suggesting next steps.
- **Keep provider setup first-class** — API provider integrations are an initial onboarding option, independent of browser data import.
- **Show, don't tell** — use `eval`, MDX, `feedback_custom`, `inline_ui`, and `load_action_bar` to demonstrate concepts live rather than just describing them.
- **Reference, don't repeat** — point to existing skill docs for deep dives rather than duplicating content.
- **Go step by step** — confirm each step works before moving to the next.

## Environment Compatibility

- Best experience is **panel-only** — `inline_ui`, `load_action_bar`, interactive workflows, and browser import features require a panel rendering context. However, basic onboarding (workspace exploration, config, creating a first project) can still proceed via `eval` and plain text replies in non-panel environments.
