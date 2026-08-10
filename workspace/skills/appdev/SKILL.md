---
name: appdev
description: Author Vibestudio trusted workspace apps for Electron, React Native, and terminal targets, including manifests, capabilities, pairing/client auth, build artifacts, approval flow, and development workflow.
---

# App Development Skill

Use this skill when creating or modifying trusted workspace apps under `apps/`.
Apps are trusted client units with explicit target runtimes. They are different
from panels, workers, and extensions:

- Panels are ordinary user-facing workspace surfaces.
- Workers and Durable Objects are userland runtime services.
- Extensions are trusted Node service units.
- Apps are trusted client runtimes that can become shell/mobile/terminal
  principals.

## Files

| Document                               | Content                                                                                         |
| -------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [AUTHORING.md](AUTHORING.md)           | Package layout, manifest shape, source paths, dependencies, and declaration rules               |
| [TARGETS.md](TARGETS.md)               | Electron, React Native, and terminal target contracts                                           |
| [CAPABILITIES.md](CAPABILITIES.md)     | Capability declarations and what each app capability unlocks                                    |
| [DEV_LOOP.md](DEV_LOOP.md)             | Semantic source, explicit context checks, publication, approval, reload, and debugging workflow |
| [MOBILE.md](MOBILE.md)                 | Native mobile host bootstrap, pairing, principal grants, and RN build artifacts                 |
| [REMOTE_CLIENTS.md](REMOTE_CLIENTS.md) | Server pairing, remote shells, terminal-client direction, and credential model                  |
| [TESTING.md](TESTING.md)               | Focused checks and smoke scenarios for app changes                                              |

## Critical Rules

0. **Build production-ready systems** — apps are trusted workspace
   infrastructure, not throwaway prototypes. Design for real use from the
   start: proper state persistence, error handling, principled authority, and
   tested edge cases. Do not populate apps with hardcoded demo/fake data —
   build real empty states and real data entry flows.
1. `@workspace-apps/foo` maps to `apps/foo`, not `apps/@workspace-apps/foo`.
2. App identity comes from `package.json` package name plus the approved build
   identity, not from a special filesystem path.
3. Give every app a semantic `vibestudio.icon`. Prefer a single meaningful emoji;
   use a repo-local image such as `./assets/icon.svg` for a real branded icon.
   Image paths are relative to `package.json`, may not traverse outside the unit,
   and must be at most 1 MiB. Do not use generated initials or remote favicon
   services.
4. App code is trusted client code. Add capabilities deliberately and keep the
   capability list no broader than the target needs.
5. App source participates in the workspace-wide semantic VCS. Read
   [vibestudio-vcs](../vibestudio-vcs/SKILL.md) before changing it. Author exact
   working intent, build or test the returned working head, commit the complete
   local application chain, and publish through `vcs.push`. Explicit checks are
   fast local feedback; push validates semantic ancestry/integration, reruns
   the exact-candidate build/typecheck gate, obtains approval, and atomically
   advances protected refs. Do not reconstruct the workflow from
   filesystem dirtiness, paths, or repository state hashes.
6. Electron shell apps that manage panel layout must declare `panel-hosting`.
7. React Native workspace apps are loaded by the shipped native host bootstrap;
   clean-install pairing must work before the workspace app bundle is available.
8. Terminal apps run as supervised Node processes only after they are selected
   for launch or explicitly activated through
   `runtime.supervision.activate({ kind: "app", releaseId: appName })`.
9. Apps that need durable shared data should call a manifest-declared worker
   Durable Object service. The app itself does not get a generic workspace SQL
   database; use `workers.resolveService(...)` + `rpc.call(...)` against narrow
   DO methods. Admit the relevant authenticated principal families in both the
   service's `authority.principals` and each DO method's
   `@rpc({ principals, effect, tier, sensitivity })` policy. For editable
   content that benefits from history and agent collaboration, use
   version-controlled files under `projects/` instead.
10. **Respect the host theme** — use `usePanelTheme()` from `@workspace/react`
    for live dark/light awareness. Do not hardcode a color scheme. Build
    mobile-friendly, responsive layouts — apps render on desktop and mobile
    hosts.
11. **Agentically enabled by default** — expose app DO methods with explicit
    `@rpc` contracts so agents can call them alongside human UIs. If the app has
    a conversational or collaborative dimension, integrate it with the workspace
    channel/messaging system using `addAgentToChannel`. Every meaningful app
    surface should be programmable by agents as a first-class concern.

## Quick Start

Create an app repo under `apps/<name>` with package name
`@workspace-apps/<name>`, then declare the app in `meta/vibestudio.yml`:

```yaml
apps:
  - source: apps/my-app
    ref: main
```

Minimal Electron app package:

```json
{
  "name": "@workspace-apps/my-app",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "vibestudio": {
    "displayName": "My App",
    "icon": "✨",
    "app": {
      "target": "electron",
      "renderer": "index.tsx",
      "capabilities": ["notifications"]
    }
  },
  "dependencies": {
    "@vibestudio/rpc": "workspace:*",
    "@vibestudio/shared": "workspace:*",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  }
}
```

For shell/mobile/remote-client work, read [TARGETS.md](TARGETS.md),
[CAPABILITIES.md](CAPABILITIES.md), and [REMOTE_CLIENTS.md](REMOTE_CLIENTS.md)
before editing.

## Related Skills

- Use `workspace-dev` for ordinary panels and workers.
- Use `workspace-dev/WORKERS.md` for DO-backed app databases and worker service
  declarations.
- Use `extensiondev` for trusted Node service units.
- Use `system-testing` after app changes that affect startup, pairing, shell
  UX, mobile bootstrap, or client auth.
- Use `vibestudio-vcs` for every app-source mutation, comparison, semantic
  commit, external snapshot import, and publication.
