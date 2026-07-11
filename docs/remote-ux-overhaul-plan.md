# Remote UX Overhaul - Implementation Record

**Status:** Implemented in this change set. The original one-shot plan has been
retired as an active task list; this document now records the completed scope,
the owning artifacts, and the verification gates for future maintainers.

## Invariants

- WebRTC is the only remote reach path for desktop and mobile clients.
- Signaling resolves to the hosted default unless an operator supplies the
  canonical flag or environment variable.
- WebRTC ingress is available by default for servers that can accept remote
  clients.
- Pairing invites are complete objects: scheme link, HTTPS pair URL, QR payload,
  expiry, room, fingerprint, signaling URL, and ICE policy are produced by the
  server contract.
- Desktop paired-device state lives in the single encrypted
  `device-credentials.json` store. Old split stores are not read, migrated, or
  recreated.
- The server identity is one combined `identity.pem`; no split-file layout is
  recognized. Replacement is an explicit operator action.
- Desktop remote sessions and local loopback sessions share the same connection
  establishment and shell/app serving path after pairing.
- Repo-local and workspace-wide skills document the paths shipped here.

## Work Package Outcomes

| WP | Outcome | Primary artifacts |
| --- | --- | --- |
| WP1 zero-config signaling | Default signaling is centralized and used by server spawn, CLI pairing, mobile dev, and smoke scripts. Self-hosted endpoints use the canonical flag or environment variable. | `packages/shared/src/connect.ts`, `scripts/cli/lib/pair-server.mjs`, `docs/webrtc-deployment.md` |
| WP2 identity/preflight | `identity.pem` is the only accepted DTLS identity. Doctor reports missing/corrupt current identities; repair replaces that one file deliberately. | `src/main/webrtc/cert.ts`, `src/main/webrtc/nodeDatachannelPeer.ts`, `scripts/cli/remote-doctor.mjs`, `scripts/cli/remote-repair-identity.mjs` |
| WP3 remote deploy | SSH deploy/status/log/update/remove automation is implemented with a user systemd unit and version-pinned artifacts. | `scripts/cli/remote-deploy.mjs`, `src/cli/client.ts`, `docs/cli.md`, `workspace/skills/remote-access/SKILL.md` |
| WP4 invites | Invite creation returns the complete link shape and supports local loopback admin minting for colocated server CLI use. | `packages/shared/src/serviceSchemas/auth.ts`, `src/server/services/authService.test.ts`, `src/server/hubServer.ts`, `src/cli/remoteClient.ts`, `scripts/cli/lib/connect-utils.mjs` |
| WP5 desktop Connect a device | The desktop shell exposes paired-device management, invite creation, QR/pair URL display, countdown, copy, and revoke. | `workspace/apps/shell/components/PairedDevicesSection.tsx`, `workspace/apps/shell/components/ConnectionSettingsDialog.tsx`, `workspace/apps/shell/shell/client.ts`, `workspace/apps/shell/SKILL.md` |
| WP6 HTTPS pair carrier | Pair URLs use the HTTPS carrier, app-link metadata is generated, and fallback behavior requires explicit user action. | `scripts/cli/lib/connect-utils.mjs`, `apps/well-known/build.ts`, `apps/well-known/config.json`, `apps/well-known/src/apple-app-site-association.template.json`, `apps/mobile/android/app/src/main/AndroidManifest.xml`, `apps/mobile/ios/Vibestudio/Info.plist` |
| WP7 mobile packaging | Android and iOS install/dev/smoke paths are platform-aware. The native shell includes scanner and paste-link entry points. | `scripts/cli/mobile-install.mjs`, `scripts/cli/mobile-dev.mjs`, `scripts/cli/mobile-smoke.mjs`, `scripts/cli/mobile-doctor.mjs`, `apps/mobile/index.js`, `apps/mobile/README.md` |
| WP8 one credential store | Desktop remote and loopback credentials use one encrypted store keyed by server identity. Split store modules and tests are deleted. | `src/main/services/deviceCredentialStore.ts`, `src/main/services/deviceCredentialStore.test.ts`, `src/main/services/remoteCredService.ts`, `STATE_DIRECTORY.md` |
| WP9 one connect path | Remote desktop shells serve manifests, panels, assets, CDP provider streams, and app launches over the paired bridge. | `src/main/serverSession.ts`, `src/main/panelOrchestrator.ts`, `src/main/index.ts`, `src/server/services/gatewayFetchService.ts`, `tests/webrtc-system.e2e.test.ts` |
| WP10 docs and skills | Operator docs, state docs, CLI docs, workspace-wide skills, and repo-local skills cover deploy, pair, mobile, iOS, troubleshooting, and smoke verification. | `docs/cli.md`, `docs/webrtc-deployment.md`, `docs/webrtc-local-e2e.md`, `workspace/skills/remote-access/SKILL.md`, `workspace/apps/mobile/SKILL.md`, `workspace/extensions/mobile-debug/SKILL.md`, `workspace/extensions/react-native/SKILL.md` |

## CLI Surface

```bash
vibestudio remote deploy <user@host> [--artifact <tgz>] [--signal-url <url>] [--port 3030]
vibestudio remote deploy status|logs|update|remove <user@host>
vibestudio remote doctor [--signal-url <url>] [--workspace <name> | --identity <identity.pem>]
vibestudio remote repair-identity --yes [--workspace <name> | --identity <identity.pem>]
vibestudio remote pair "https://vibestudio.app/pair#..."
vibestudio remote invite-user --handle <handle> --workspace <name>
vibestudio remote pair-device [--workspace <name>]
vibestudio remote add-member|remove-member --workspace <name> --handle <handle>
vibestudio remote list-users --workspace <name>
vibestudio remote list-devices

vibestudio mobile install [--platform android|ios] [--from-source] [--launch]
vibestudio mobile dev --platform android|ios
vibestudio mobile logs --platform android|ios
vibestudio mobile doctor
```

## Verification

Use focused gates for the shipped behavior:

```bash
pnpm vitest run tests/remote-overhaul-skill-guard.test.ts tests/ios-entitlements.test.ts packages/shared/src/connect.test.ts tests/pair-server.test.ts --config vitest.host.config.ts
pnpm vitest run tests/remote-deploy.test.ts src/cli/client.test.ts src/server/hubServer.test.ts --config vitest.host.config.ts
pnpm test:desktop-pairing-smoke
node scripts/cli/mobile-smoke.mjs --platform android --avd NatStack_Test --timeout-ms 420000 --no-build
pnpm smoke:full
```

`pnpm smoke:full` is the composition ladder: build, desktop WebRTC pairing,
desktop e2e, and Android emulator pairing. Run the narrower desktop pairing and
mobile smoke commands when iterating on one side of the system.

## Documentation And Skills

- `workspace/skills/remote-access/SKILL.md` is the operational guide for deploy,
  invite, doctor, repair, logs, and composition smoke.
- `workspace/skills/appdev/MOBILE.md` and `REMOTE_CLIENTS.md` describe the
  mobile shell, streamed app delivery, and pairing contract.
- `workspace/apps/mobile/SKILL.md` documents native host expectations for the
  mobile app repo.
- `workspace/apps/shell/SKILL.md` documents the desktop connect-device UI.
- `workspace/extensions/mobile-debug/SKILL.md` and
  `workspace/extensions/react-native/SKILL.md` cover simulator/device debugging
  and platform-tagged React Native artifacts.
