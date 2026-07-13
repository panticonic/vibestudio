---
name: phone-setup
description: Discover a phone attached to the user's desktop, install Vibestudio only when needed, and pair it with the same current server and workspace. Use for Android or iOS setup, USB/device diagnostics, mobile installation, and desktop-to-phone pairing.
---

# Phone setup

Set up the phone through the typed `phoneProvisioning` and `hubControl` tools. The agent may be running on a remote server; never assume `adb`, Xcode, or the phone is present there. `phoneProvisioning` routes operations to a desktop connected under the requesting user's account.

## Workflow

1. Call `phoneProvisioning.providers`. If none are returned, explain that the user's desktop must remain open and connected to this server.
2. Call `phoneProvisioning.devices`. Surface its issues directly. For Android, ask the user to connect and unlock the phone, enable USB debugging, and accept the computer authorization prompt. For iOS, require macOS, trust, Xcode, and signing.
3. Ask the user to choose only when multiple providers or ready phones exist. Prefer a structured feedback choice when available.
4. If the selected phone reports `compatibleAppInstalled`, do not build or reinstall. Otherwise call `phoneProvisioning.install` with `mode: "auto"`. Use `mode: "source"` only when the user requests a development build and the provider advertises that platform in `sourcePlatforms`.
5. Snapshot `hubControl.listDevices`, then call `hubControl.pairDevice` for the current workspace. Treat the returned pairing URL as a secret.
6. Call `phoneProvisioning.openPairing` with that URL and the selected provider/device. Do not quote the URL in chat, logs, or errors.
7. Poll `hubControl.listDevices` until the new mobile device appears or the invite expires. Confirm the account, server, workspace, and recovery behavior rather than reporting success after installation alone.

## Recovery

If automatic launch is unavailable, ask the user to use **Remote server > Show pairing QR** on the desktop and scan it from the installed mobile app. Do not invent another pairing flow, credential store, socket, or static platform-specific wizard.
