---
name: phone-setup
description: Discover an attached phone or emulator, install Vibestudio, and pair it to the current account and workspace.
---

# Phone setup

Treat installation and pairing as one outcome. Ask only for the next physical
action supported by discovery, then rediscover. Don't require the user to
interpret adb, Xcode, provider, or pairing internals.

This is the end-user flow through a connected desktop. For repository work on a
developer device, use [mobile debug](../../extensions/mobile-debug/SKILL.md).

## Route through the desktop

The agent may run on a remote server; adb, Xcode, and the phone are attached to
the user's desktop. Resolve the live phone-provisioning service, open its live
docs, and use its provider, device, and provision methods. Preserve returned
provider and device IDs exactly.

```ts
const phone = await workers.resolveService("vibestudio.phone-provisioning.v1");
const providers = await rpc.call(phone.targetId, "providers", []);
return { targetId: phone.targetId, providers };
```

Reuse the resolved target for the complete attempt. The service is protected by
normal installed-agent requests and user review; don't add eval authority
overrides or retry a fixed-code manifest denial.

## Workflow

1. Discover connected desktop providers. If none, ask the user to open the
   Vibestudio desktop app on the same server/account. Don't change phone
   settings yet.
2. Discover devices through each provider. Auto-select only when one ready
   device is unambiguous; otherwise show a structured choice with platform,
   model, desktop, and serial suffix.
3. When no device is ready, explain the observed issue and ask for the next
   physical action from the platform guidance below. Rediscover after
   confirmation.
4. Call `provision` once with the exact provider, platform, device, and
   automatic install mode. Use development/published build mode only after
   explicit request and only when the provider supports it.
5. Report success only when the typed result confirms a compatible installation
   and newly paired device. Then tell the user the phone may be unplugged.
6. If installation succeeds but workspace readiness doesn't, diagnose the
   observed phase. Don't auto-reinstall or create another invite.

Never expose a pairing secret or ask the user to copy one through chat. Device
trust and install/pair approvals are expected security boundaries.

## Android readiness

Use only the steps discovery requires:

- Unlock the device and connect with a data-capable USB cable. Try a different
  data USB mode, cable, or port when no device appears.
- If required, enable Developer options (tap build number), then enable USB
  debugging. Menu placement varies by manufacturer.
- Keep the phone unlocked and accept the USB-debugging trust prompt. Remembering
  the desktop is optional.
- `unauthorized` = unresolved phone-side trust prompt. `offline` =
  connection/readiness problem. Don't install until discovery reports ready.

For emulators: wait for the home screen. No cable or RSA prompt needed.

## iPhone readiness

iPhone dev installation requires a connected Mac with Xcode and valid signing:

- Unlock the phone, connect to the Mac, trust the computer.
- Enable Developer Mode if iOS requests it.
- Let Xcode prepare the device and configure the development team if signing is
  missing.
- Rediscover only after Xcode reports the device ready.

Source deployment from Windows/Linux requires a Mac provider — don't present it
as a phone-side repair.

## Recovery

- **No provider**: reconnect the desktop app to the same account/server.
- **No device**: check unlock, cable/data mode, trust/debugging, provider state.
- **Unauthorized/offline**: resolve the phone-side prompt or physical
  connection, then rediscover instead of repeatedly provisioning.
- **Install failure**: preserve the exact provider issue; check storage,
  compatibility, signing, and build modes.
- **Pairing timeout**: keep both devices awake, verify connectivity, retry the
  single provision transaction. Don't mint an agent-visible invite.
- **Workspace preparation**: wait for or diagnose the real readiness condition;
  process liveness is insufficient.

For repository diagnostics, capture the physical debug-device identity before
provisioning and use `mobile-debug.verifyWorkspaceReady` afterward. A hub device
ID ≠ an adb serial; keep those identities separate. Don't use the development
extension in ordinary onboarding.

If trusted desktop provisioning is unavailable, direct the user to the shell's
Devices surface and its pairing QR. Don't split the automated operation into
manual hub-control or credential steps.
