import { spawn } from "node:child_process";

const POLL_MS = 100;

export function processTreeAlive(pid, platform = process.platform) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (platform === "win32") {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if (error?.code === "ESRCH") return false;
      throw error;
    }
  }
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

export async function terminateOwnedProcessTree(
  pid,
  { termTimeoutMs = 12_000, killTimeoutMs = 5_000, platform = process.platform } = {}
) {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Invalid owned process-tree PID: ${pid}`);
  }
  if (!processTreeAlive(pid, platform)) {
    return { gone: true, escalated: false };
  }

  if (platform === "win32") {
    const result = await runTaskkill(pid);
    if (!result.ok && processTreeAlive(pid, platform)) {
      return { gone: false, escalated: true, detail: result.detail };
    }
    const gone = await waitUntilGone(pid, killTimeoutMs, platform);
    return { gone, escalated: true, ...(gone ? {} : { detail: result.detail }) };
  }

  signalGroup(pid, "SIGTERM");
  if (await waitUntilGone(pid, termTimeoutMs, platform)) {
    return { gone: true, escalated: false };
  }
  signalGroup(pid, "SIGKILL");
  const gone = await waitUntilGone(pid, killTimeoutMs, platform);
  return {
    gone,
    escalated: true,
    ...(gone ? {} : { detail: `Process group ${pid} survived SIGKILL` }),
  };
}

function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function waitUntilGone(pid, timeoutMs, platform) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (!processTreeAlive(pid, platform)) return true;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  } while (Date.now() < deadline);
  return !processTreeAlive(pid, platform);
}

function runTaskkill(pid) {
  return new Promise((resolve) => {
    const child = spawn("taskkill", ["/T", "/F", "/PID", String(pid)], {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output = `${output}${String(chunk)}`.slice(-4_096);
    });
    child.stderr?.on("data", (chunk) => {
      output = `${output}${String(chunk)}`.slice(-4_096);
    });
    child.once("error", (error) => resolve({ ok: false, detail: error.message }));
    child.once("exit", (code) => {
      const missing = /not found|no running instance|cannot find/i.test(output);
      resolve({ ok: code === 0 || missing, detail: output.trim() });
    });
  });
}
