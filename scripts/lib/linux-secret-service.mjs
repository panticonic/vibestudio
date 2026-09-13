/**
 * An isolated Linux secret service for unattended desktop launches.
 *
 * Electron's `safeStorage` refuses to save a device credential without an OS
 * keyring, so a desktop client cannot pair on a machine with no desktop
 * session — it fails with "OS secure storage is unavailable" and the pairing
 * link goes unused. Starting a private D-Bus session and a gnome-keyring
 * daemon against a throwaway HOME gives it one, without touching the
 * developer's own keyring.
 *
 * Extracted from the desktop pairing smoke so any unattended desktop launch
 * can reuse it.
 */
import { spawn } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

const repoRoot = process.cwd();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

export async function startEphemeralLinuxSecretService(tempRoot, children) {
  if (process.platform !== "linux") return { env: {}, electronArgs: [] };

  const home = path.join(tempRoot, "home");
  const configHome = path.join(tempRoot, "xdg");
  const dataHome = path.join(tempRoot, "xdg-data");
  const runtimeDir = path.join(tempRoot, "runtime");
  const controlDir = path.join(tempRoot, "keyring-control");
  const busConfig = path.join(tempRoot, "session-bus.conf");
  const busSocket = path.join(runtimeDir, "session-bus");
  await Promise.all([
    fsp.mkdir(home, { recursive: true }),
    fsp.mkdir(configHome, { recursive: true }),
    fsp.mkdir(dataHome, { recursive: true }),
    fsp.mkdir(runtimeDir, { recursive: true, mode: 0o700 }),
    fsp.mkdir(controlDir, { recursive: true, mode: 0o700 }),
  ]);
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

  const serviceEnv = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: dataHome,
    XDG_RUNTIME_DIR: runtimeDir,
  };
  const bus = spawn(
    "dbus-daemon",
    [`--config-file=${busConfig}`, "--nofork", "--nopidfile", "--print-address=1"],
    {
      cwd: repoRoot,
      env: serviceEnv,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  children.push(bus);
  bus.stderr?.on("data", (chunk) =>
    prefixAndWrite("desktop-secret-bus", chunk.toString(), process.stderr)
  );
  const busAddress = await new Promise((resolve, reject) => {
    let buffered = "";
    const timer = setTimeout(
      () => reject(new Error("Timed out starting the isolated desktop secret-service bus")),
      5_000
    );
    const finish = (error, address) => {
      clearTimeout(timer);
      bus.stdout?.off("data", onData);
      bus.off("error", onError);
      bus.off("exit", onExit);
      if (error) reject(error);
      else resolve(address);
    };
    const onData = (chunk) => {
      buffered += chunk.toString();
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      const address = buffered.slice(0, newline).trim();
      if (!address) {
        finish(new Error("The isolated desktop secret-service bus emitted an empty address"));
        return;
      }
      finish(null, address);
    };
    const onError = (error) => finish(error);
    const onExit = (code) =>
      finish(new Error(`The isolated desktop secret-service bus exited early (code ${code})`));
    bus.stdout?.on("data", onData);
    bus.once("error", onError);
    bus.once("exit", onExit);
  });

  const keyringEnv = { ...serviceEnv, DBUS_SESSION_BUS_ADDRESS: busAddress };
  const keyring = spawnManaged(
    "gnome-keyring-daemon",
    ["--foreground", "--unlock", "--components=secrets", `--control-directory=${controlDir}`],
    {
      cwd: repoRoot,
      env: keyringEnv,
      label: "desktop-secret-service",
      pipeStdin: true,
    }
  );
  children.push(keyring);
  keyring.stdin?.end(randomUUID());
  await waitForSpawn(keyring, "gnome-keyring-daemon", ["--foreground", "--unlock"]);
  await sleep(250);
  if (keyring.exitCode != null) {
    throw new Error(`The isolated desktop secret service exited early (code ${keyring.exitCode})`);
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
  };
}

function waitForSpawn(child, command, args, timeoutMs = 1_000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("spawn", onSpawn);
      child.off("error", onError);
      if (error) reject(error);
      else resolve();
    };
    const onSpawn = () => finish();
    const onError = (error) => finish(error);
    const timer = setTimeout(() => finish(), timeoutMs);
    child.once("spawn", onSpawn);
    child.once("error", onError);
    if (child.pid) finish();
    if (child.exitCode != null)
      finish(new Error(`${command} ${args.join(" ")} exited before startup`));
  });
}
