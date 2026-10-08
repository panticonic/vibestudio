/**
 * An isolated Linux secret service for unattended desktop launches.
 *
 * Electron's `safeStorage` refuses to save a device credential without an OS
 * keyring. The keyring and D-Bus sockets use a short private runtime path so
 * Unix-domain socket names stay within the kernel limit, while HOME and other
 * durable state remain under the caller-owned temporary root.
 */
import { spawn } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

const repoRoot = process.cwd();

export function prefixAndWrite(prefix, text, stream) {
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    stream.write(`[${prefix}] ${line}\n`);
  }
}

export function spawnManaged(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    stdio: [options.pipeStdin ? "pipe" : "ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  child.stdout?.on("data", (chunk) =>
    prefixAndWrite(options.label ?? command, chunk.toString(), process.stdout)
  );
  child.stderr?.on("data", (chunk) =>
    prefixAndWrite(options.label ?? command, chunk.toString(), process.stderr)
  );
  child.once("error", (error) => {
    prefixAndWrite(
      options.label ?? command,
      `Failed to start ${command}: ${error.message}`,
      process.stderr
    );
  });
  return child;
}

/**
 * Start an isolated session bus and Secret Service. The caller owns every
 * acquired process and must call the returned `dispose` after its Electron
 * clients have exited. Startup failure and cancellation retire partial setup.
 */
export async function startEphemeralLinuxSecretService(tempRoot, acquire, retire, { signal } = {}) {
  if (process.platform !== "linux") return { env: {}, electronArgs: [], dispose: async () => {} };
  if (typeof retire !== "function") {
    throw new TypeError("An exact process retirement callback is required for the secret service");
  }
  signal?.throwIfAborted();

  const home = path.join(tempRoot, "home");
  const configHome = path.join(tempRoot, "xdg");
  const dataHome = path.join(tempRoot, "xdg-data");
  // Keep IPC names short even when the caller's disk-backed state path is deep.
  const ipcRoot = await fsp.mkdtemp(path.join("/tmp", "vs-ipc-"));
  const runtimeDir = path.join(ipcRoot, "r");
  const controlDir = path.join(ipcRoot, "k");
  const busConfig = path.join(ipcRoot, "b.conf");
  const busSocket = path.join(runtimeDir, "b");
  const children = { bus: null, keyring: null, waiter: null };
  let disposal;

  const dispose = () => {
    disposal ??= (async () => {
      const failures = [];
      for (const child of [children.waiter, children.keyring, children.bus]) {
        if (!child) continue;
        try {
          await retire(child);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length) {
        throw new AggregateError(failures, "Isolated secret-service process retirement failed");
      }
      await fsp.rm(ipcRoot, { recursive: true, force: true });
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
    children.bus = acquire(() =>
      spawn(
        "dbus-daemon",
        [`--config-file=${busConfig}`, "--nofork", "--nopidfile", "--print-address=1"],
        {
          cwd: repoRoot,
          env: serviceEnv,
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
        }
      )
    );
    children.bus.stderr?.on("data", (chunk) =>
      prefixAndWrite("desktop-secret-bus", chunk.toString(), process.stderr)
    );
    const busAddress = await waitForBusAddress(children.bus, signal);
    signal?.throwIfAborted();

    const keyringEnv = { ...serviceEnv, DBUS_SESSION_BUS_ADDRESS: busAddress };
    children.waiter = acquire(() =>
      spawn("gdbus", ["wait", `--address=${busAddress}`, "org.freedesktop.secrets"], {
        cwd: repoRoot,
        env: keyringEnv,
        stdio: ["ignore", "ignore", "pipe"],
        detached: true,
      })
    );
    children.waiter.stderr?.on("data", (chunk) =>
      prefixAndWrite("desktop-secret-service-wait", chunk.toString(), process.stderr)
    );

    children.keyring = acquire(() =>
      spawnManaged(
        "gnome-keyring-daemon",
        ["--foreground", "--unlock", "--components=secrets", `--control-directory=${controlDir}`],
        {
          cwd: repoRoot,
          env: keyringEnv,
          label: "desktop-secret-service",
          pipeStdin: true,
        }
      )
    );
    children.keyring.stdin?.end(randomUUID());
    await waitForSecretService(children.waiter, children.bus, children.keyring, signal);
    signal?.throwIfAborted();
    if (children.bus.exitCode !== null || children.keyring.exitCode !== null) {
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
