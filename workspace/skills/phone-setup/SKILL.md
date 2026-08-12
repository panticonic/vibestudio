---
name: phone-setup
description: Discover an Android phone, emulator, or iPhone attached to the user's connected desktop, install Vibestudio when needed, and pair it to the current account and workspace.
---

# Phone setup

Treat installation and pairing as one user outcome. Ask for only the next
physical action supported by discovery, then rediscover. Do not require the
user to interpret adb, Xcode, provider, or pairing internals.

This is the end-user flow through a connected desktop. For repository work on a
developer device or simulator, use
[mobile debug](../../extensions/mobile-debug/SKILL.md).

## Route through the desktop

The agent may run on a remote server; adb, Xcode, and the phone are attached to
the user's desktop. Resolve the live phone-provisioning service, open its live
docs, and use its documented provider, device, and provision methods. Preserve
the returned provider and device IDs exactly.

```ts
const phone = await workers.resolveService("vibestudio.phone-provisioning.v1");
const providers = await rpc.call(phone.targetId, "providers", []);
return { targetId: phone.targetId, providers };
```

Reuse the resolved target for the complete attempt. The service is protected by
normal installed-agent requests and user review; do not add eval authority
overrides or retry a fixed-code manifest denial.

## Workflow

1. Discover connected desktop providers. If none exists, ask the user to open
   the Vibestudio desktop app connected to the same server and account. Do not
   change phone settings yet.
2. Discover devices through each provider. Select automatically only when one
   ready device is unambiguous; otherwise show one structured choice using
   recognizable platform, model, desktop, and serial suffix.
3. When no device is ready, explain one observed issue and ask for the next
   physical action from the platform guidance below. Rediscover after
   confirmation.
4. Invoke `provision` once with the exact selected provider, platform, device,
   and the normal automatic install mode. Use a development or published build
   mode only after an explicit user request and only when the provider says it
   is supported.
5. Report success only when the typed result confirms a compatible installation
   and a newly paired device. Then tell the user the phone may be unplugged.
6. If installation succeeds but workspace readiness does not, diagnose the
   observed phase. Do not automatically reinstall or create another invite.

Never expose a pairing secret or ask the user to copy one through chat. Device
trust and Vibestudio install/pair approvals are expected security boundaries.

## Android readiness

Use only the steps the discovery result requires:

- Unlock the device and connect it with a data-capable USB cable. Try a data
  USB mode, cable, or port when no device appears.
- If required, enable Developer options by tapping the build number, then enable
  USB debugging. Menu placement varies by manufacturer.
- Keep the phone unlocked and accept its USB-debugging trust prompt. Remembering
  the desktop is optional.
- Treat `unauthorized` as an unresolved phone-side trust prompt and `offline` as
  a connection/readiness problem. Do not install until discovery reports ready.

For an emulator, wait for the home screen. It needs no cable or RSA prompt.

## iPhone readiness

iPhone development installation requires a connected Mac with Xcode and valid
signing:

- Unlock the phone, connect it to the Mac, and trust the computer.
- Enable Developer Mode if iOS requests it.
- Let Xcode prepare the device and configure the appropriate development team
  if signing is missing.
- Rediscover only after Xcode reports the device ready.

Do not present source deployment from Windows or Linux as a phone-side repair;
it requires a Mac provider.

## Recovery

- No provider: reconnect the desktop app to the same account/server.
- No device: check unlock, cable/data mode, trust/debugging, and provider state.
- Unauthorized/offline: resolve the phone-side prompt or physical connection,
  then rediscover instead of repeatedly provisioning.
- Install failure: preserve the exact provider issue; check storage,
  compatibility, signing, and advertised build modes.
- Pairing timeout: keep both devices awake, verify connectivity, and retry the
  single provision transaction. Do not mint an agent-visible invite.
- Workspace preparation: wait for or diagnose the real readiness condition;
  process liveness is insufficient.

For repository diagnostics, capture the physical debug-device identity before
provisioning and use `mobile-debug.verifyWorkspaceReady` afterward. A hub device
ID is not an adb serial; keep those identities separate. Do not use the
development extension in ordinary onboarding.

If trusted desktop provisioning is unavailable, direct the user to the shell's
Devices surface and its pairing QR. Do not split the automated operation into
manual hub-control or credential steps.
