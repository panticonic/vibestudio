# natstack-client

`natstack-client` is a small pairing helper for headless laptops and SSH sessions.

```sh
natstack-client discover
natstack-client pair "natstack://connect?url=...&code=..."
natstack-client status
natstack-client logout
```

It stores a device refresh credential in `~/.config/natstack/cli-credentials.json` with file mode `0600`. It does not use a system keyring.

`pnpm start:remote` can launch the desktop app with the same CLI device
credential:

```sh
pnpm start:remote --pair "natstack://connect?url=...&code=..."
pnpm start:remote
```
