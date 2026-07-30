---
name: phone-setup
description: Discover a phone attached to the user's desktop, install Vibestudio only when needed, and pair it with the same current server and workspace. Use for Android or iOS setup, USB/device diagnostics, mobile installation, and desktop-to-phone pairing.
---

# Phone setup

Guide the user from “I want Vibestudio on this phone” to a working, paired
mobile workspace. Do not assume they know about developer options, adb, device
trust, signing, providers, or pairing links. Ask them to do only the next
physical action that is actually needed, then rediscover.

This is the end-user workflow for a phone attached to a connected desktop. For
repository development against an emulator or a developer device, use
`extensions/mobile-debug/SKILL.md` instead. The two workflows share the mobile
installer but have different ownership: the `vibestudio.phone-provisioning.v1`
builtin routes work through the user's connected desktop, while `mobile-debug`
runs on the development host.

The agent may be running on a remote server. Never assume adb, Xcode, or the
phone is present beside the agent. The builtin securely routes discovery and
provisioning to a desktop connected under the requesting user's account.

## User experience

- Start with discovery. If the phone is already ready, do not make the user
  enable settings again or answer setup questions.
- Explain why a physical action is needed in one sentence, then give short,
  screen-level steps. Avoid dumping the whole troubleshooting guide at once.
- After the user confirms an action, rerun provider/device discovery. Do not ask
  them to interpret adb output or run terminal commands.
- Ask the user to choose only when more than one ready phone or desktop is
  present. Use recognizable labels such as model, platform, and serial suffix.
- Treat installation and pairing as one operation. Never expose a pairing
  secret, ask the user to copy one, or report success after installation alone.
- Normal security prompts are expected: the phone's operating-system trust
  prompt and Vibestudio's scoped install-and-pair approval are meaningful
  boundaries. Do not promise a prompt-free flow.

This skill is documentation, not an importable code package. From ordinary
server-side eval, call the services through the injected portable RPC client:

```ts
const phone = await workers.resolveService("vibestudio.phone-provisioning.v1");
const providers = await rpc.call(phone.targetId, "providers", []);
const discovery = await rpc.call(phone.targetId, "devices", [
  { providerId: providers[0]?.providerId },
]);
return { providers, discovery };
```

Use ordinary eval exactly as shown. Do not add an eval-level `authority`
override such as `approvals: "pregranted-only"`: the builtin receiver grant is
scoped and enforced by the resolved service itself, while a fresh
pregranted-only eval run is intentionally forbidden from acquiring it.

Reuse `phone.targetId` for `providers`, `devices`, and `provision`. Do not
import `@workspace-skills/phone-setup`; no such runtime package exists.

## Authority contract

The installed agent unit must request the exact gated capabilities
`mobile.devices.read` and `mobile.provision`. The first covers private attached
device discovery. The second is the single reviewed transaction that may
install software and add the selected phone to the current account. These
declarations make the workflow eligible for normal user review; they do not
pre-approve either operation. A `fixed-code-not-requested` denial is a manifest
defect and must not be retried.

## Workflow

1. Resolve `vibestudio.phone-provisioning.v1`, then call its `providers` method.
2. If no provider is returned, say: “I need the Vibestudio desktop app that the
   phone is plugged into to be open and connected to this same server.” Ask the
   user to open that desktop app and keep it running, then retry discovery once
   they confirm. This is a desktop-connectivity problem, not a phone problem;
   do not send them into developer settings yet.
3. Call the resolved service's `devices` method for each provider. If one ready phone exists,
   select it. If none is ready, use the relevant guided setup below and
   rediscover after the user's next action.
4. Ask the user to choose only when multiple providers or ready phones exist.
   Present every applicable provider/device choice in one structured surface;
   never ask separate provider, platform, device, install-mode, and pairing
   questions. Hide install mode unless the user explicitly requests a
   development build. This is one of the exceptional cases where a feedback
   result may be needed because only the agent has the typed provisioning
   tools. If those tools become panel-callable, replace the feedback handoff
   with a persistent inline component that invokes them directly.
5. Call the resolved service's `provision` method once with the selected provider, platform,
   device, and `mode: "auto"`. This is the transaction boundary: the connected
   desktop skips a compatible install, otherwise resolves `auto` to a local
   build when it owns a source checkout or to the version-matched release in a
   packaged desktop; it then mints a same-account invite, delivers it to the
   exact phone, and waits for the new paired device. Use `mode: "source"` only
   when the user explicitly requests a development build and the provider
   advertises that platform in `sourcePlatforms`; use `mode: "release"` only
   when the user explicitly requests the published release.
6. Report success only when the result says `compatibleAppInstalled: true`,
   `pairingStatus: "paired"`, and includes the newly created `pairedDevice`.
   On Android, the desktop delivers the invite through an adb-shell-only
   provisioning component, so the app consumes it immediately. Ordinary
   browser, QR, and pasted links still require confirmation on the phone.
7. Tell the user that the app is installed, paired to the current workspace,
   and safe to unplug. A first source launch may spend a minute or two preparing
   the mobile workspace; describe that as preparation, not another pairing
   step. If the app does not reach the workspace, continue with diagnostics
   instead of asking the user to pair again.

## Guided Android setup

Use only the steps needed for the device's current state:

1. Ask the user to unlock the phone and connect it to the desktop with a USB
   cable that supports data. If discovery is empty, suggest trying the phone's
   **File transfer / Android Auto** USB mode or another data cable/port.
2. If USB debugging is not enabled, guide them to **Settings > About phone** and
   tap **Build number** seven times. They may need to enter their screen lock.
   Then open **Settings > System > Developer options** (the exact location can
   vary by manufacturer) and turn on **USB debugging**.
3. Ask them to keep the phone unlocked and accept **Allow USB debugging?** for
   this computer. “Always allow from this computer” is optional and should be
   presented as a convenience on a trusted personal desktop, not a requirement.
4. Rediscover. A device reported as `unauthorized` means the phone-side trust
   prompt is still unresolved; `offline` usually means reconnecting the cable
   or toggling USB debugging is needed. Do not attempt installation until the
   device is ready.

For an emulator, ask the user to boot it fully and wait for the Android home
screen. It needs no cable or phone-side RSA prompt, but only one ready emulator
should be selected automatically.

## Guided iPhone setup

iPhone deployment requires a Mac with Xcode and a signed development setup.
Guide the user to:

1. Unlock the iPhone, connect it to the Mac, and choose **Trust This Computer**
   on the phone.
2. Enable **Settings > Privacy & Security > Developer Mode** if iOS requests it;
   the phone may restart and ask for confirmation.
3. Open Xcode once, select the phone under **Window > Devices and Simulators**,
   and allow Xcode to finish preparing it. If signing is missing, the user must
   choose their Apple development team in the Vibestudio mobile project.
4. Rediscover after Xcode shows the device as ready.

Do not present iOS source deployment from Windows or Linux as recoverable phone
setup. Explain that a connected Mac provider is required.

## Recovery by observed state

- **No desktop provider:** open and connect the desktop app to the same
  account/server; keep it running.
- **No devices:** check unlock, data cable/USB mode, debugging or trust, then
  rediscover.
- **Unauthorized Android device:** accept the RSA prompt on the unlocked phone.
  If it never appears, revoke USB debugging authorizations in Developer options,
  reconnect, and accept the new prompt.
- **Offline device:** reconnect the cable, wait for the home screen, and
  rediscover. Do not repeatedly invoke provisioning.
- **Install failed:** preserve and explain the concrete provider issue. Check
  storage, platform compatibility, signing, and whether the selected provider
  advertises the requested source platform. Do not silently switch installation
  modes.
- **Pairing timed out after delivery:** keep the desktop and phone awake, verify
  network reachability, and retry the single `provision` transaction. Do not
  create a separate agent-visible invite.
- **App opens but workspace is still preparing:** allow the cold workspace build
  to finish. For repository diagnostics, use `verifyWorkspaceReady`; do not
  reinstall or re-pair merely because preparation exceeds one minute.

For repository development and system tests, pair that semantic result with
`mobile-debug.verifyWorkspaceReady`, using a `sinceMs` captured before
provisioning. This is diagnostic evidence that the newly paired app completed
workspace and panel-host initialization; process liveness alone is not enough.
Do not use the development extension in ordinary end-user onboarding.

## Manual fallback

If trusted desktop provisioning is unavailable, ask the user to use **Remote
server > Show pairing QR** on the desktop and scan it from the installed mobile
app. Do not split the automated transaction into agent-visible invite or hub
control calls, and do not invent another pairing flow, credential store, socket,
or static platform-specific wizard.
