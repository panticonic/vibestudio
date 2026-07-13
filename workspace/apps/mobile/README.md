# Workspace Mobile App

This directory is the hot-updatable Vibestudio mobile product: React Native
screens, navigation, panel WebViews, approvals, notifications, OAuth, and
workspace-facing services. It is a userland workspace app built by buildV2 and
delivered as a signed/verified bundle to the installed native host.

The shipped Android/iOS projects and minimal first-pairing/recovery bootstrap
live in the repository's native `apps/mobile` package. Native modules, signing,
release packaging, and OS-level integration belong there; product UI and
workspace behavior belong here.

## Checks

Run the native package's commands from the repository root; its Jest and
TypeScript configuration intentionally includes this workspace app:

```bash
pnpm -C apps/mobile test
pnpm -C apps/mobile type-check
pnpm -C apps/mobile lint
```

See [SKILL.md](SKILL.md) for the architecture and change-specific verification
matrix.
