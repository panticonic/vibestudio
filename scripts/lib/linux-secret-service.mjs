/**
 * An isolated Linux secret service for unattended desktop launches.
 *
 * Electron's `safeStorage` refuses to save a device credential without an OS
 * keyring. The keyring and D-Bus sockets use a short private runtime path so
 * Unix-domain socket names stay within the kernel limit, while HOME and other
 * durable state remain under the caller-owned temporary root. Every process and
 * the IPC directory belong to the caller's `Ownership`: its reaper retires them
 * even when the caller is killed.
 */
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

const repoRoot = process.cwd();
/** dbus-daemon refuses a listening socket path of 99 bytes or more
 * (_DBUS_MAX_SUN_PATH_LENGTH), well under the kernel's sun_path of 108. */
const UNIX_SOCKET_PATH_LIMIT = 98;

export function prefixAndWrite(prefix, text, stream) {
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    stream.write(`[${prefix}] ${line}\n`);
  }
}

/**
 * Start an isolated session bus and Secret Service. Every process is spawned
 * through `ownership`; the caller must call the returned `dispose` after its
 * Electron clients have exited. Startup failure and cancellation retire partial
 * setup. The IPC directory is reaper scratch, removed when `ownership` is.
 */
export async function startEphemeralLinuxSecretService(ownership, tempRoot, { signal } = {}) {
  if (process.platform !== "linux") return { env: {}, electronArgs: [], dispose: async () => {} };
  signal?.throwIfAborted();

  const home = path.join(tempRoot, "home");
  const configHome = path.join(tempRoot, "xdg");
  const dataHome = path.join(tempRoot, "xdg-data");
  // Short names inside the reaper's disk-backed scratch keep socket paths
  // within the kernel limit.
  const ipcRoot = await ownership.scratch("ipc-");
  const runtimeDir = path.join(ipcRoot, "r");
  const controlDir = path.join(ipcRoot, "k");
  const busConfig = path.join(ipcRoot, "b.conf");
  const busSocket = path.join(runtimeDir, "b");
  // The longest socket the daemons bind below these directories.
  for (const socketPath of [busSocket, path.join(controlDir, "pkcs11")]) {
    if (Buffer.byteLength(socketPath) > UNIX_SOCKET_PATH_LIMIT) {
      throw new Error(
        `The profile's ownership scratch path is too deep for a Unix socket (${socketPath})`
      );
    }
  }
  const children = { bus: null, keyring: null, waiter: null };
  let disposal;

  const dispose = () => {
    disposal ??= (async () => {
      const failures = [];
      for (const child of [children.waiter, children.keyring, children.bus]) {
        if (!child) continue;
        try {
          await child.retire();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length) {
        throw new AggregateError(failures, "Isolated secret-service process retirement failed");
      }
    })();
    return disposal;
  };

  const failStartup = async (error) => {
    try {
      await dispose();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Isolated secret-service startup and cleanup both failed",
        { cause: error }
      );
    }
    throw error;
  };

  try {
    await Promise.all([
      fsp.mkdir(home, { recursive: true }),
      fsp.mkdir(configHome, { recursive: true }),
      fsp.mkdir(dataHome, { recursive: true }),
      fsp.mkdir(runtimeDir, { recursive: true, mode: 0o700 }),
      fsp.mkdir(controlDir, { recursive: true, mode: 0o700 }),
    ]);
    await fsp.chmod(ipcRoot, 0o700);
    await Promise.all([fsp.chmod(runtimeDir, 0o700), fsp.chmod(controlDir, 0o700)]);
    await fsp.writeFile(
      busConfig,
      `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <keep_umask/>
  <listen>unix:path=${busSocket}</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
`,
      { mode: 0o600 }
    );

    signal?.throwIfAborted();
    const serviceEnv = {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: configHome,
      XDG_DATA_HOME: dataHome,
      XDG_RUNTIME_DIR: runtimeDir,
    };
    children.bus = spawnService(
      ownership,
      "dbus-daemon",
      [`--config-file=${busConfig}`, "--nofork", "--nopidfile", "--print-address=1"],
      { env: serviceEnv, stdio: ["ignore", "pipe", "pipe"] }
    );
    children.bus.child.stderr?.on("data", (chunk) =>
      prefixAndWrite("desktop-secret-bus", chunk.toString(), process.stderr)
    );
    const busAddress = await waitForBusAddress(children.bus.child, signal);
    signal?.throwIfAborted();

    const keyringEnv = { ...serviceEnv, DBUS_SESSION_BUS_ADDRESS: busAddress };
    children.waiter = spawnService(
      ownership,
      "gdbus",
      ["wait", `--address=${busAddress}`, "org.freedesktop.secrets"],
      { env: keyringEnv, stdio: ["ignore", "ignore", "pipe"] }
    );
    children.waiter.child.stderr?.on("data", (chunk) =>
      prefixAndWrite("desktop-secret-service-wait", chunk.toString(), process.stderr)
    );

    children.keyring = spawnService(
      ownership,
      "gnome-keyring-daemon",
      ["--foreground", "--unlock", "--components=secrets", `--control-directory=${controlDir}`],
      { env: keyringEnv, stdio: ["pipe", "pipe", "pipe"] }
    );
    const keyring = children.keyring.child;
    for (const [stream, write] of [
      [keyring.stdout, process.stdout],
      [keyring.stderr, process.stderr],
    ]) {
      stream?.on("data", (chunk) =>
        prefixAndWrite("desktop-secret-service", chunk.toString(), write)
      );
    }
    keyring.once("error", (error) =>
      prefixAndWrite(
        "desktop-secret-service",
        `Failed to start gnome-keyring-daemon: ${error.message}`,
        process.stderr
      )
    );
    keyring.stdin?.end(randomUUID());
    await waitForSecretService(children.waiter.child, children.bus.child, keyring, signal);
    signal?.throwIfAborted();
    if (children.bus.child.exitCode !== null || keyring.exitCode !== null) {
      throw new Error("The isolated desktop secret service exited during readiness");
    }
    console.log("[desktop-smoke] Started an isolated Linux secret service for device credentials");
    return {
      env: {
        HOME: home,
        XDG_CONFIG_HOME: configHome,
        XDG_DATA_HOME: dataHome,
        XDG_RUNTIME_DIR: runtimeDir,
        DBUS_SESSION_BUS_ADDRESS: busAddress,
        XDG_CURRENT_DESKTOP: "GNOME",
      },
      electronArgs: ["--password-store=gnome-libsecret"],
      dispose,
    };
  } catch (error) {
    return failStartup(error);
  }
}

/** One service process of the secret service, killed at once when retired. */
function spawnService(ownership, command, args, { env, stdio }) {
  const owned = ownership.spawn(command, args, {
    kill: "immediate",
    label: command,
    cwd: repoRoot,
    env,
    stdio,
  });
  // The startup waits report a failure to start; later errors have no reader.
  owned.child.on("error", () => undefined);
  return owned;
}

function waitForBusAddress(child, signal) {
  return new Promise((resolve, reject) => {
    let buffered = "";
    let settled = false;
    const finish = (error, address) => {
      if (settled) return;
      settled = true;
      child.stdout?.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(address);
    };
    const onData = (chunk) => {
      buffered += chunk.toString();
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      const address = buffered.slice(0, newline).trim();
      finish(
        address
          ? null
          : new Error("The isolated desktop secret-service bus emitted an empty address"),
        address
      );
    };
    const onError = (error) => finish(error);
    const onExit = (code, exitSignal) =>
      finish(
        new Error(
          `The isolated desktop secret-service bus exited before readiness (${code ?? exitSignal})`
        )
      );
    const onAbort = () => finish(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal?.throwIfAborted();
    child.stdout?.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function waitForSecretService(waiter, bus, keyring, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const listeners = [];
    const observe = (child, event, listener) => {
      child.on(event, listener);
      listeners.push(() => child.off(event, listener));
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      for (const remove of listeners) remove();
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onWaiterError = (error) => finish(error);
    const onWaiterExit = (code, exitSignal) =>
      finish(
        code === 0 ? null : new Error(`Secret Service name waiter exited (${code ?? exitSignal})`)
      );
    const onDependencyExit = (label) => (code, exitSignal) =>
      finish(
        new Error(
          `The isolated desktop ${label} exited before Secret Service readiness (${code ?? exitSignal})`
        )
      );
    const onAbort = () => finish(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal?.throwIfAborted();
    observe(waiter, "error", onWaiterError);
    observe(waiter, "exit", onWaiterExit);
    observe(bus, "error", onWaiterError);
    observe(bus, "exit", onDependencyExit("session bus"));
    observe(keyring, "error", onWaiterError);
    observe(keyring, "exit", onDependencyExit("keyring daemon"));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (waiter.exitCode !== null) onWaiterExit(waiter.exitCode, waiter.signalCode);
    if (bus.exitCode !== null) onDependencyExit("session bus")(bus.exitCode, bus.signalCode);
    if (keyring.exitCode !== null)
      onDependencyExit("keyring daemon")(keyring.exitCode, keyring.signalCode);
  });
}
