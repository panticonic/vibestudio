# Android Phone over VPN

Use the unified CLI for the mobile workflow. This page only covers the VPN and
Tailscale details that are specific to real-phone testing.

## Happy Path

Build and install the trusted internal app:

```bash
natstack mobile build
natstack mobile install --launch
```

Expose the gateway over Tailscale HTTPS, then start the QR/deep-link pairing
server:

```bash
sudo tailscale serve --bg 3030
natstack mobile pair --host tailscale --port 3030
```

Scan the QR code with the Android camera and accept the connection prompt in
NatStack. The app saves a durable device credential and reconnects later as long
as the server comes back on the same host and port.

For a disposable local dev workspace with Metro, app install, launch, ADB
reverse ports, and server startup in one command:

```bash
natstack mobile dev
```

## Tailscale Requirements

- Tailscale must be running on the server and phone.
- Tailscale Serve must be enabled for the tailnet.
- HTTPS Certificates must be enabled in the Tailscale admin console.
- `sudo tailscale serve --bg <gateway-port>` must be run once on the server.

With `--host tailscale`, NatStack detects the MagicDNS hostname, verifies
`https://<host>.<tailnet>.ts.net/healthz`, and uses that URL for pairing, panel
chrome, OAuth callbacks, and webhook delivery.

Register this OAuth callback with providers:

```text
https://<host>.<tailnet>.ts.net/_r/s/credentials/oauth/callback
```

## If Serve Is Not Enabled

When Tailscale Serve is disabled, `natstack mobile pair --host tailscale` prints
an `ACTION NEEDED` block with an activation URL. Treat that as a hard stop for
the HTTPS path:

1. Open the printed Tailscale activation URL.
2. Enable Serve for the tailnet.
3. Run `sudo tailscale serve --bg 3030`.
4. Restart `natstack mobile pair --host tailscale --port 3030`.

## Useful Flags

```bash
natstack mobile install --device <adb-serial> --launch
natstack mobile pair --host lan --port 3030
natstack mobile pair --host 100.x.y.z --workspace my-workspace
natstack mobile pair --workspace-dir /path/to/workspace
natstack mobile pair --dev
natstack mobile logs --device <adb-serial>
```

The internal APK is `com.natstack.mobile.internal`, is debug-signed, and allows
HTTP to trusted VPN/LAN hosts. Release builds keep the stricter Android network
policy.

## Native Auth Note

The native mobile host refreshes short-lived app grants through
`/_r/s/auth/refresh-principal-grant` for the `react-native-app` principal. The
durable device credential stays in the native keychain; React Native JS receives
only one-time connection grants.
