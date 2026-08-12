---
name: appdev
description: Create or modify trusted workspace apps for Electron, React Native, or terminal targets.
---

# Trusted app development

Apps under `apps/` are approved client runtimes. Panels are UI surfaces, workers
and DOs are sandboxed services, extensions are trusted Node services.

## Read by task

| Task | Reference |
| --- | --- |
| Package, manifest, source, dependencies, panel commands | [AUTHORING.md](AUTHORING.md) |
| Electron, React Native, or terminal contracts | [TARGETS.md](TARGETS.md) |
| Capability declarations | [CAPABILITIES.md](CAPABILITIES.md) |
| Semantic development and diagnostics | [DEV_LOOP.md](DEV_LOOP.md) |
| Native bootstrap, pairing, mobile artifacts | [MOBILE.md](MOBILE.md) |
| Remote clients and credentials | [REMOTE_CLIENTS.md](REMOTE_CLIENTS.md) |
| Focused checks and smoke coverage | [TESTING.md](TESTING.md) |

Read only references relevant to the target and change.

## Invariants

- `@workspace-apps/<name>` maps to `apps/<name>`. Identity comes from the
  package manifest and approved build, not display path.
- Give each app a semantic `vibestudio.icon` per the [icon
  guide](../workspace-dev/references/icons.md). Use `@workspace/ui/icons` for
  host UI icons.
- Declare only the capabilities the target requires; let the normal review flow
  approve them.
- Read [Vibestudio VCS](../vibestudio-vcs/SKILL.md) before editing managed
  source. Check the working head, commit the complete local chain, and publish
  explicitly.
- Electron layout hosts declare `panel-hosting`. React Native pairing must work
  in the shipped bootstrap before a workspace bundle exists. Terminal apps run
  only as explicitly activated supervised processes.
- Put durable shared data behind a manifest-declared worker or DO service with
  explicit RPC authority. Use version-controlled project files when content
  benefits from history and collaboration.
- Use `usePanelTheme()` and responsive layouts. Shared client behavior needs
  focused evidence in every affected target.
- Panel commands are generic and host-local: panels own command meaning; apps
  own presentation and routing.

## Workflow

Create `apps/<name>` with package name `@workspace-apps/<name>`, declare it
under `apps:` in `meta/vibestudio.yml`. Use live generated docs and manifest
schema for exact fields.

Run the smallest target-specific checks from [TESTING.md](TESTING.md). Use
[system testing](../system-testing/SKILL.md) when a change crosses startup,
pairing, shell UI, mobile bootstrap, or client-auth boundaries.

Use [workspace development](../workspace-dev/SKILL.md) for panels and workers,
[extension development](../extensiondev/SKILL.md) for trusted Node services.
