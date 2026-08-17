import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { E2E_ARTIFACT_ROOT_ENV } from "./e2eRun.js";

export const E2E_OWNED_X11_ENV = "VIBESTUDIO_E2E_OWNED_X11";
export const E2E_USE_HOST_DISPLAY_ENV = "VIBESTUDIO_E2E_USE_HOST_DISPLAY";

export interface OwnedXvfbSession {
  display: string;
  pid: number;
  stop: () => Promise<void>;
}

/** Whether this test worker owns an isolated X11 desktop and its device state. */
export function hasOwnedX11Display(): boolean {
  return (
    process.platform === "linux" &&
    process.env[E2E_OWNED_X11_ENV] === "1" &&
    Boolean(process.env.DISPLAY)
  );
}

function requireExecutable(name: string): void {
  try {
    execFileSync(name, [name === "xauth" ? "-V" : "-help"], { stdio: "ignore" });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EACCES") {
      throw new Error(
        `Linux Electron E2E isolation requires ${name}. Install: sudo apt-get install xvfb xauth x11-utils xdotool`
      );
    }
    // Several X11 tools use a non-zero status for their help/version output.
  }
}

function writeManifest(value: unknown): void {
  const artifactRoot = process.env[E2E_ARTIFACT_ROOT_ENV];
  if (!artifactRoot) return;
  fs.writeFileSync(path.join(artifactRoot, "native-display.json"), JSON.stringify(value, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}

function waitForDisplayNumber(child: ChildProcess, timeoutMs: number): Promise<string> {
  const displayPipe = child.stdio[3];
  if (!displayPipe || typeof displayPipe === "number") {
    throw new Error("Xvfb display allocation pipe was not created");
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | null, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve(value!);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      finish(new Error(`Xvfb exited before allocating a display (code=${code}, signal=${signal})`));
    const timer = setTimeout(
      () => finish(new Error(`Xvfb did not allocate a display within ${timeoutMs}ms`)),
      timeoutMs
    );
    child.once("exit", onExit);
    displayPipe.once("data", (chunk: Buffer) => {
      const displayNumber = chunk.toString("utf8").trim();
      if (!/^\d+$/.test(displayNumber)) {
        finish(
          new Error(`Xvfb returned an invalid display number: ${JSON.stringify(displayNumber)}`)
        );
        return;
      }
      finish(null, displayNumber);
    });
    displayPipe.once("error", (error) => finish(error));
  });
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

export async function startOwnedXvfb(runTempRoot: string): Promise<OwnedXvfbSession | null> {
  if (process.platform !== "linux") return null;
  if (process.env[E2E_USE_HOST_DISPLAY_ENV] === "1") {
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
      throw new Error(
        `${E2E_USE_HOST_DISPLAY_ENV}=1 requires an existing X11 or Wayland desktop session`
      );
    }
    return null;
  }
  for (const executable of ["Xvfb", "xauth", "xdpyinfo", "xdotool"]) {
    requireExecutable(executable);
  }

  const xauthorityPath = path.join(runTempRoot, "Xauthority");
  const cookie = crypto.randomBytes(16).toString("hex");
  // A FamilyWild entry lets Xvfb authenticate this cookie before -displayfd
  // has selected a free number. The authority file is private to this run and
  // Xvfb never listens on TCP.
  const protocol = Buffer.from("MIT-MAGIC-COOKIE-1", "ascii").toString("hex");
  const numericAuthority = `ffff 0000 0000 0012 ${protocol} 0010 ${cookie}\n`;
  execFileSync("xauth", ["-f", xauthorityPath, "nmerge", "-"], {
    input: numericAuthority,
    stdio: ["pipe", "ignore", "ignore"],
  });

  const stderr: Buffer[] = [];
  const child = spawn(
    "Xvfb",
    [
      "-displayfd",
      "3",
      "-screen",
      "0",
      "1920x1080x24",
      "-dpi",
      "96",
      "-nolisten",
      "tcp",
      "-noreset",
      "-auth",
      xauthorityPath,
    ],
    { stdio: ["ignore", "ignore", "pipe", "pipe"] }
  );
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

  try {
    const displayNumber = await waitForDisplayNumber(child, 10_000);
    if (!child.pid) throw new Error("Xvfb did not expose an owned process id");
    const display = `:${displayNumber}`;
    const ownedEnvironment = {
      ...process.env,
      DISPLAY: display,
      XAUTHORITY: xauthorityPath,
      XDG_SESSION_TYPE: "x11",
    };
    delete ownedEnvironment.WAYLAND_DISPLAY;
    execFileSync("xdpyinfo", ["-display", display], {
      env: ownedEnvironment,
      stdio: "ignore",
      timeout: 5_000,
    });

    process.env.DISPLAY = display;
    process.env.XAUTHORITY = xauthorityPath;
    process.env.XDG_SESSION_TYPE = "x11";
    delete process.env.WAYLAND_DISPLAY;
    process.env[E2E_OWNED_X11_ENV] = "1";
    const startedAt = new Date().toISOString();
    writeManifest({
      display,
      pid: child.pid,
      xauthorityPath,
      geometry: "1920x1080x24",
      dpi: 96,
      startedAt,
      ready: true,
    });

    let stopped = false;
    return {
      display,
      pid: child.pid!,
      stop: async () => {
        if (stopped) return;
        stopped = true;
        child.kill("SIGTERM");
        if (!(await waitForExit(child, 5_000))) {
          child.kill("SIGKILL");
          if (!(await waitForExit(child, 3_000))) {
            throw new Error(`Owned Xvfb process ${child.pid} did not exit`);
          }
        }
        writeManifest({
          display,
          pid: child.pid,
          xauthorityPath,
          geometry: "1920x1080x24",
          dpi: 96,
          startedAt,
          ready: true,
          stoppedAt: new Date().toISOString(),
          stopped: true,
        });
      },
    };
  } catch (error) {
    child.kill("SIGKILL");
    await waitForExit(child, 3_000);
    const details = Buffer.concat(stderr).toString("utf8").trim();
    throw new Error(
      `Failed to start the owned Xvfb display: ${error instanceof Error ? error.message : String(error)}${details ? `\n${details}` : ""}`
    );
  }
}
