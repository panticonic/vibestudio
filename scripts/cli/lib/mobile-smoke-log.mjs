import { setTimeout as sleep } from "node:timers/promises";

const smokePrefix = "[VibestudioMobileSmoke]";

/** Observe the owned Android log stream; terminal failures outrank old success phases. */
export function observeMobileSmokeLog(child, { expectedPhases, deadlineMs, packageName }) {
  const phases = new Map();
  const recentLines = [];
  let buffer = "";
  let stderr = "";
  let appCrashed = false;
  let readerError = null;

  const recordLine = (line) => {
    if (!line) return;
    if (line.includes("AndroidRuntime") && line.includes(`Process: ${packageName}, PID:`)) {
      appCrashed = true;
    }
    if (line.includes(smokePrefix) || line.includes("VibestudioMobileSmokeProbe")) {
      console.log(`[smoke-log] ${line}`);
      recentLines.push(line);
      if (recentLines.length > 200) recentLines.shift();
      const match = line.match(/\bphase=([A-Za-z0-9._-]+)/);
      if (match) phases.set(match[1], (phases.get(match[1]) ?? 0) + 1);
    } else if (
      line.includes("ReactNativeJS") ||
      line.includes("VibestudioMobileHost") ||
      line.includes("VibestudioIroh") ||
      line.includes("[InlineUiMessage]") ||
      line.includes("AndroidRuntime")
    ) {
      if (line.includes("[InlineUiMessage]")) {
        console.error(`[smoke-log] ${line}`);
      }
      recentLines.push(line);
      if (recentLines.length > 200) recentLines.shift();
    }
  };

  child.stdout?.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) recordLine(line);
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  child.once("error", (error) => {
    readerError = error;
    stderr += `${error.message}\n`;
  });

  child.stdout?.once("end", () => {
    recordLine(buffer);
    buffer = "";
  });

  const throwIfTerminalFailure = () => {
    if (readerError) throw new Error(`adb logcat failed: ${readerError.message}`);
    if (child.exitCode != null || child.signalCode != null) {
      throw new Error(
        `adb logcat exited (${child.signalCode ?? child.exitCode})\n${stderr}`.trim()
      );
    }
    if (!appCrashed && !phases.has("embedded-pairing-failed")) return;
    const recent = recentLines.length
      ? `\n\nRecent relevant log lines:\n${recentLines.join("\n")}`
      : "";
    throw new Error(
      `${appCrashed ? "The Android app crashed" : "The mobile app reported a terminal pairing failure"}${recent}`
    );
  };

  const waitForPhase = async (phase, phaseDeadlineMs = deadlineMs) => {
    while (Date.now() < phaseDeadlineMs) {
      throwIfTerminalFailure();
      if (phases.has(phase)) return;
      await sleep(250);
    }
    throwIfTerminalFailure();
    const observed =
      expectedPhases.filter((candidate) => phases.has(candidate)).join(", ") || "(none)";
    const recent = recentLines.length
      ? `\n\nRecent relevant log lines:\n${recentLines.join("\n")}`
      : "";
    throw new Error(`Timed out waiting for smoke phase ${phase}. Observed: ${observed}${recent}`);
  };

  const hasPhase = (phase) => {
    throwIfTerminalFailure();
    return phases.has(phase);
  };
  const phaseCount = (phase) => phases.get(phase) ?? 0;
  const waitForPhaseAfter = async (phase, previousCount, timeoutMs) => {
    const occurrenceDeadlineMs = Date.now() + timeoutMs;
    while (Date.now() < occurrenceDeadlineMs) {
      throwIfTerminalFailure();
      if (phaseCount(phase) > previousCount) return;
      await sleep(250);
    }
    throwIfTerminalFailure();
    const recent = recentLines.length
      ? `\n\nRecent relevant log lines:\n${recentLines.join("\n")}`
      : "";
    throw new Error(`Timed out waiting for a new smoke phase ${phase}${recent}`);
  };

  const waitForAnyPhase = async (candidates, phaseDeadlineMs = deadlineMs) => {
    while (Date.now() < phaseDeadlineMs) {
      throwIfTerminalFailure();
      const observed = candidates.find((candidate) => phases.has(candidate));
      if (observed) return observed;
      await sleep(250);
    }
    throwIfTerminalFailure();
    const recent = recentLines.length
      ? `\n\nRecent relevant log lines:\n${recentLines.join("\n")}`
      : "";
    throw new Error(`Timed out waiting for any of: ${candidates.join(", ")}${recent}`);
  };

  return { child, waitForPhase, waitForPhaseAfter, waitForAnyPhase, hasPhase, phaseCount };
}
