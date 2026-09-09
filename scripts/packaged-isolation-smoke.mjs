#!/usr/bin/env node
// Acceptance against an installed artifact: chooser rendering, the packaged
// hub's real MXC workspace bootstrap, desktop resource builds and ordered quit.
// Filesystem denial canaries and terminal approvals have separate native and
// desktop pairing suites. No checkout build artifacts or provider credentials
// are used here; the package's pinned public Base release must be reachable.
import fs from "node:fs/promises";
import { closeSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { _electron as electron } from "@playwright/test";
import { parseHubReadyPayload } from "./cli/lib/hub-ready.mjs";

const execute = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function resolvePackagedExecutable(appPath, platform = process.platform) {
  const resolved = path.resolve(appPath);
  if ((await fs.stat(resolved)).isFile()) return resolved;
  if (platform === "darwin" && resolved.endsWith(".app")) {
    const binaries = await fs.readdir(path.join(resolved, "Contents", "MacOS"));
    if (binaries.length !== 1) throw new Error("Packaged app must have one main MacOS executable");
    return path.join(resolved, "Contents", "MacOS", binaries[0]);
  }
  throw new Error("Pass the installed executable, or a macOS .app bundle");
}
export function parseOptions(argv) {
  const options = { timeoutMs: 600000 };
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    const value = argv[++index];
    if (!value) throw new Error(`Missing value for ${key}`);
    if (key === "--app") options.app = value;
    else if (key === "--out-dir") options.outDir = path.resolve(value);
    else if (key === "--timeout-ms" && Number.isSafeInteger(Number(value)) && Number(value) > 0)
      options.timeoutMs = Number(value);
    else throw new Error(`Unknown option: ${key}`);
  }
  if (!options.app)
    throw new Error(
      "Usage: node scripts/packaged-isolation-smoke.mjs --app APP [--out-dir DIR] [--timeout-ms MS]"
    );
  return options;
}
function childExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}
async function awaitExit(child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!childExited(child) && Date.now() < deadline) await delay(50);
  return childExited(child);
}
async function forceStop(child, grouped = true) {
  if (childExited(child)) return;
  if (process.platform === "win32")
    await execute("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
  else {
    try {
      if (grouped) process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  if (!(await awaitExit(child, 10000)))
    throw new Error("Owned packaged process did not exit; fixture quarantined");
}
async function closeGui(gui) {
  let timer;
  try {
    await Promise.race([
      gui.close(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Packaged GUI shutdown timed out")), 20000);
      }),
    ]);
  } catch (error) {
    await forceStop(gui.process(), false);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
const CAPTURED_LINE_LIMIT = 400;
const CAPTURED_LINE_BYTES = 262_144;

/**
 * Reduce a crashed child's captured output to the part a reader can act on.
 *
 * Node prints an uncaught error as the offending source line, a caret, and only
 * then the message and stack. When the throw comes from a bundled dependency
 * that source line is minified — thousands of characters of one expression — and
 * it is what a naive tail reports as the failure, burying the message entirely.
 *
 * Start from the first line that looks like a thrown error when there is one,
 * and truncate any single line long enough to be minified source rather than a
 * log line. The complete output still reaches the failure report.
 */
export function readableTail(captured, { maxLines = 60, maxLineLength = 400 } = {}) {
  const lines = String(captured)
    .split("\n")
    // Bound the line first. Secrets travel in log lines, not in minified source,
    // and masking a 64,000-character bundle because one keyword appears
    // somewhere in it rewrites ordinary identifiers — getOwnPropertyDescriptor
    // became "[redacted]" — corrupting the little of it worth reading.
    .map((line) =>
      line.length > maxLineLength ? `${line.slice(0, maxLineLength)}… [${line.length} chars]` : line
    )
    // Mask the material rather than dropping the line. Discarding every line
    // that mentions a secret also discards "Invalid base64url string at
    // reach.endpointSecret" — the one line that says what went wrong.
    .map((line) =>
      /(invite|pairurl|deeplink|token|secret|credential)/iu.test(line)
        ? line.replace(/[A-Za-z0-9_-]{20,}/gu, "[redacted]")
        : line
    );
  const thrown = lines.findIndex((line) => /^\s*(?:[A-Za-z_$][\w$]*Error|Fatal)\b/.test(line));
  const selected = thrown >= 0 ? lines.slice(thrown) : lines.slice(-maxLines);
  return selected.join("\n").replace(/vibestudio:\/\/\S+/gu, "[redacted app link]").trim();
}

/**
 * Capture a child's output for diagnosis, retaining lines rather than a rolling
 * window of characters. A minified bundle prints as one enormous line; a
 * character window is consumed entirely by it and evicts the message and stack
 * that follow — the only part worth reading.
 */
export function spawnCaptured(child, logPath) {
  const recent = [];
  let partial = "";
  const retain = (line) => {
    recent.push(line);
    if (recent.length > CAPTURED_LINE_LIMIT) recent.shift();
  };
  const absorb = (text) => {
    partial += text;
    for (let cut = partial.indexOf("\n"); cut >= 0; cut = partial.indexOf("\n")) {
      retain(partial.slice(0, cut));
      partial = partial.slice(cut + 1);
    }
    // One unterminated line must not grow without bound either.
    if (partial.length > CAPTURED_LINE_BYTES) {
      retain(partial);
      partial = "";
    }
  };
  for (const stream of [child.stdout, child.stderr])
    stream?.on("data", (chunk) => absorb(String(chunk)));
  child.on("error", (error) => absorb(`${String(error)}\n`));
  let closed = false;
  child.on("close", () => {
    closed = true;
  });
  // A log file holds everything the child wrote; the streamed buffer is the
  // fallback for a child spawned onto pipes.
  const captured = () => {
    if (logPath) {
      try {
        return readFileSync(logPath, "utf8");
      } catch {
        /* not yet created */
      }
    }
    return [...recent, partial].filter(Boolean).join("\n");
  };
  return {
    child,
    tail: () => readableTail(captured()),
    /** Everything retained, redacted but neither reordered nor abridged. */
    transcript: () =>
      captured()
        .split("\n")
        .map((line) =>
          /(invite|pairurl|deeplink|token|secret|credential)/iu.test(line)
            ? line.replace(/[A-Za-z0-9_-]{20,}/gu, "[redacted]")
            : line
        )
        .join("\n")
        .replace(/vibestudio:\/\/\S+/gu, "[redacted app link]"),
    /**
     * Wait for the child's output to finish arriving.
     *
     * `exit` fires while stdout and stderr may still hold buffered data; only
     * `close` means everything has been delivered. A crash report composed on
     * exit routinely loses the very message the process printed as it died,
     * leaving the source line before it as the whole explanation.
     */
    drained: async (timeoutMs = 2_000) => {
      const deadline = Date.now() + timeoutMs;
      while (!closed && Date.now() < deadline) await delay(25);
      return closed;
    },
  };
}

/**
 * Launch the packaged server, capturing its output where nothing can lose it.
 *
 * Node writes to a pipe asynchronously and drops whatever has not drained when
 * the process exits. A crash that prints a minified bundle — tens of kilobytes
 * — therefore loses the message printed after it, every time, which is why this
 * failure reported a source fragment and nothing else however the report was
 * composed. Writes to a regular file are synchronous, so the same crash arrives
 * whole.
 */
function launch(command, args, environment, cwd, logPath) {
  const log = logPath ? openSync(logPath, "a", 0o600) : "pipe";
  const child = spawn(command, args, {
    env: environment,
    cwd,
    stdio: ["ignore", log, log, "ipc"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  if (typeof log === "number") closeSync(log);
  return spawnCaptured(child, logPath);
}

export async function runPackagedIsolationSmoke(options) {
  const executable = await resolvePackagedExecutable(options.app);
  const fixture = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "vibestudio-packaged-isolation-"))
  );
  const outDir = options.outDir ?? path.join(process.cwd(), "test-results", "packaged-isolation");
  await fs.mkdir(outDir, { recursive: true, mode: 0o700 });
  await Promise.all(
    ["report.json", "failure.json"].map((name) => fs.rm(path.join(outDir, name), { force: true }))
  );
  const environment = {};
  for (const key of [
    "PATH",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XAUTHORITY",
    "LANG",
    "LC_ALL",
    "TMP",
    "TEMP",
  ])
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  Object.assign(environment, {
    HOME: path.join(fixture, "home"),
    USERPROFILE: path.join(fixture, "home"),
    APPDATA: path.join(fixture, "appdata"),
    LOCALAPPDATA: path.join(fixture, "localappdata"),
    XDG_CONFIG_HOME: path.join(fixture, "config"),
    XDG_CACHE_HOME: path.join(fixture, "cache"),
    VIBESTUDIO_INSTANCE_ROOT: path.join(fixture, "instance"),
    VIBESTUDIO_SHARED_DERIVED_CACHE_DIR: path.join(fixture, "derived"),
    NODE_ENV: "production",
  });
  for (const key of [
    "HOME",
    "APPDATA",
    "LOCALAPPDATA",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "VIBESTUDIO_INSTANCE_ROOT",
    "VIBESTUDIO_SHARED_DERIVED_CACHE_DIR",
  ])
    await fs.mkdir(environment[key], { recursive: true, mode: 0o700 });
  const result = { platform: process.platform, arch: process.arch, executable };
  let gui;
  let server;
  let safeCleanup = true;
  try {
    gui = await electron.launch({
      executablePath: executable,
      args: ["--choose-connection", `--user-data-dir=${path.join(fixture, "chromium")}`],
      env: environment,
      timeout: 60000,
    });
    const identity = await gui.evaluate(({ app }) => ({
      packaged: app.isPackaged,
      appRoot: app.getAppPath(),
      resources: process.resourcesPath,
      version: app.getVersion(),
    }));
    if (!identity.packaged || !identity.appRoot.includes("app.asar"))
      throw new Error("Smoke requires an actual packaged ASAR application");
    const page = await gui.firstWindow({ timeout: 60000 });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page
      .getByRole("heading", { name: "Choose a server or workspace", exact: true })
      .waitFor({ state: "visible", timeout: 60000 });
    pageErrors.push(...(await page.pageErrors()).map((error) => error.message));
    if (pageErrors.length)
      throw new Error(`Packaged chooser renderer errors: ${pageErrors.join("; ")}`);
    await page.screenshot({ path: path.join(outDir, "chooser.png") });
    result.gui = { ...identity, windowLoaded: true };
    await closeGui(gui);
    gui = undefined;
    const appRoot = identity.appRoot;
    const readyFile = path.join(fixture, "hub-ready.json");
    const unpackedDist = path.join(appRoot.replace(/\.asar$/u, ".asar.unpacked"), "dist");
    const serverEntry = path.join(unpackedDist, "server-electron.cjs");
    const electronEnv = {
      ...environment,
      ELECTRON_RUN_AS_NODE: "1",
      VIBESTUDIO_APP_ROOT: appRoot,
      // A host refuses to start without being told which build generation it is
      // running from, and it reads its build identity from that directory. The
      // installed app sets this to its own __dirname, which is dist inside the
      // archive — not the unpacked tree, which holds only the files packaging
      // was told to keep outside it.
      VIBESTUDIO_HOST_ARTIFACT_ROOT: path.join(appRoot, "dist"),
    };
    server = launch(
      executable,
      [
        path.join(here, "lib", "packaged-server-bootstrap.cjs"),
        serverEntry,
        "--app-root",
        appRoot,
        "--bootstrap-workspace",
        "dev",
        "--ephemeral",
        "--require-electron-ready",
        "--ready-file",
        readyFile,
      ],
      electronEnv,
      fixture,
      path.join(outDir, "server-output.log")
    );
    const deadline = Date.now() + options.timeoutMs;
    let ready;
    while (Date.now() < deadline) {
      if (childExited(server.child)) {
        await server.drained();
        // The child writes straight into server-output.log beside this report,
        // so the transcript needs no separate copy.
        // How it died distinguishes an uncaught error from a signal. Without
        // this the report is whatever the process managed to print, which for a
        // process killed mid-print is the source line and nothing after it.
        const { exitCode, signalCode } = server.child;
        throw new Error(
          `Packaged workspace startup failed (exit ${String(exitCode)}` +
            `${signalCode ? `, signal ${signalCode}` : ""}): ${server.tail()}`
        );
      }
      try {
        ready = parseHubReadyPayload(JSON.parse(await fs.readFile(readyFile, "utf8")));
        break;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await delay(200);
    }
    if (!ready) throw new Error(`Packaged workspace readiness timed out: ${server.tail()}`);
    if (!ready.workspaces.some((workspace) => workspace.running && workspace.ephemeral))
      throw new Error("Packaged ready file has no running ephemeral workspace");
    result.workspace = {
      ready: true,
      running: ready.workspaces.filter((workspace) => workspace.running).length,
    };
    const workspaces = path.join(environment.VIBESTUDIO_INSTANCE_ROOT, "workspaces");
    const liveStorage = await fs.readdir(workspaces);
    const advertisedNames = ready.workspaces.map((workspace) => workspace.name);
    const ephemeralStorage = liveStorage.filter((name) => !advertisedNames.includes(name));
    if (ephemeralStorage.length !== result.workspace.running)
      throw new Error("Ready packaged workspace has no distinct ephemeral storage directory");
    for (const name of ephemeralStorage) {
      if (
        !(await fs.stat(path.join(workspaces, name, "source", "meta", "vibestudio.yml"))).isFile()
      )
        throw new Error("Ready packaged workspace has no materialized configuration");
    }
    server.child.send("packaged-smoke-stop");
    if (!(await awaitExit(server.child, 30000)))
      throw new Error(`Packaged ordered shutdown timed out: ${server.tail()}`);
    if (server.child.exitCode !== 0)
      throw new Error(
        `Packaged server shutdown failed (${server.child.exitCode}): ${server.tail()}`
      );
    result.workspace.shutdown = true;
    server = undefined;
    const remaining = await fs.readdir(workspaces).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    // Advertised workspace reaches deliberately survive ephemeral disk removal:
    // the hub's stable Iroh identity belongs to "dev", not "dev-<disk nonce>".
    // Validate that only that exact host-owned identity remains, never guest
    // storage or pending .delete receipts.
    for (const name of remaining) {
      if (!advertisedNames.includes(name) || ephemeralStorage.includes(name))
        throw new Error(`Packaged shutdown left workspace storage: ${name}`);
      for (const [relative, expected] of [
        ["", "reach"],
        ["reach", "iroh"],
      ]) {
        const entries = await fs.readdir(path.join(workspaces, name, relative));
        if (entries.length !== 1 || entries[0] !== expected)
          throw new Error(
            `Packaged shutdown left unexpected advertised workspace data: ${name}/${relative}`
          );
      }
      const identities = await fs.readdir(path.join(workspaces, name, "reach", "iroh"));
      // server/index.ts creates the callback identity at boot; endpoint.key is
      // created lazily when the advertised Iroh transport is first needed.
      if (
        !identities.includes("callback-relay-identity.pem") ||
        identities.some((entry) => !["endpoint.key", "callback-relay-identity.pem"].includes(entry))
      )
        throw new Error(`Unexpected host reach identity files: ${identities.join(", ")}`);
    }
    result.workspace.ephemeralStorageRemoved = true;
    result.workspace.retainedHostReachIdentities = remaining.length;
    await fs.writeFile(path.join(outDir, "report.json"), JSON.stringify(result, null, 2), {
      mode: 0o600,
    });
    return result;
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error)
      .split("\n")
      .filter((line) => !/(invite|pairurl|deeplink|token|secret|credential)/iu.test(line))
      .join("\n")
      .replace(/vibestudio:\/\/\S+/gu, "[redacted app link]");
    await fs.writeFile(
      path.join(outDir, "failure.json"),
      JSON.stringify({ ...result, error: message }, null, 2),
      { mode: 0o600 }
    );
    throw new Error(message);
  } finally {
    const failures = [];
    if (gui)
      try {
        await closeGui(gui);
      } catch (error) {
        failures.push(error);
        safeCleanup = false;
      }
    for (const item of [server])
      if (item) {
        try {
          await forceStop(item.child);
        } catch (error) {
          failures.push(error);
        }
        safeCleanup = false;
      }
    // Runtime failures can leave sandbox descendants under stock best-effort
    // cancellation. Never recursively delete a fixture whose retirement is unknown.
    if (safeCleanup) await fs.rm(fixture, { recursive: true, force: true });
    else console.error(`Packaged smoke fixture quarantined: ${fixture}`);
    if (failures.length) throw new AggregateError(failures, "Packaged smoke cleanup failed");
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runPackagedIsolationSmoke(parseOptions(process.argv.slice(2)))
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
