import { app, clipboard, Notification } from "electron";

const REGISTRY = "https://registry.npmjs.org";
const CHANNEL_ENV = "VIBESTUDIO_NPM_CHANNEL";

/**
 * npm-channel update notice. The launcher (`scripts/vibestudio-launcher.mjs`) sets
 * `VIBESTUDIO_NPM_CHANNEL` to the installed package name (e.g. "@panticonic/vibestudio")
 * when it launches the GUI from a global npm install. We then check the registry
 * for a newer version and surface a notification with the exact upgrade command.
 *
 * Notification-first by design: it never mutates the running install (that can
 * fail on permissions and corrupts a directory Electron is executing from — and
 * may have been launched via npx/pnpm rather than `npm i -g`). The packaged
 * electron-builder channel uses electron-updater instead; dev source checkouts
 * have no `VIBESTUDIO_NPM_CHANNEL` and skip this entirely.
 */
export async function maybeNotifyNpmUpdate(): Promise<void> {
  const pkg = process.env[CHANNEL_ENV];
  if (!pkg) return;

  const current = app.getVersion();
  try {
    const res = await fetch(`${REGISTRY}/${pkg}/latest`, {
      headers: { accept: "application/vnd.npm.install-v1+json" },
    });
    if (!res.ok) return;
    const { version: latest } = (await res.json()) as { version?: string };
    if (!latest || !isNewer(latest, current)) return;

    const command = `npm install -g ${pkg}@latest`;
    console.log(`[npm-update] ${pkg} ${current} → ${latest} available: ${command}`);
    if (Notification.isSupported()) {
      const notification = new Notification({
        title: `Vibestudio ${latest} is available`,
        body: `You're on ${current}. Click to copy the update command:\n${command}`,
      });
      notification.on("click", () => {
        clipboard.writeText(command);
        new Notification({
          title: "Update command copied",
          body: "Paste it into a terminal, then relaunch Vibestudio when installation finishes.",
        }).show();
      });
      notification.show();
    }
  } catch (err) {
    console.warn(`[npm-update] check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** True if `a` has a higher major.minor.patch than `b` (prerelease ignored). */
function isNewer(a: string, b: string): boolean {
  const [a0, a1, a2] = core(a);
  const [b0, b1, b2] = core(b);
  if (a0 !== b0) return a0 > b0;
  if (a1 !== b1) return a1 > b1;
  return a2 > b2;
}

function core(v: string): [number, number, number] {
  const head = v.replace(/^v/, "").split("-")[0] ?? "";
  const parts = head.split(".");
  return [num(parts[0]), num(parts[1]), num(parts[2])];
}

function num(value: string | undefined): number {
  return Number.parseInt(value ?? "0", 10) || 0;
}
