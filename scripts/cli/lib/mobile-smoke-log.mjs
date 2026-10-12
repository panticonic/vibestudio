import { setTimeout as sleep } from "node:timers/promises";

const smokePrefix = "[VibestudioMobileSmoke]";
const irohDiagnosticPrefix = "[mobile-iroh-diagnostic]";
const maxIrohDiagnosticLines = 2_000;
const irohDiagnosticEvents = new Set([
  "write-start",
  "write-complete",
  "finish-start",
  "finish-complete",
  "connection-created",
  "open-bi-start",
  "open-bi-complete",
  "connection-close-requested",
  "connection-closed-wait-start",
  "connection-closed",
]);

function diagnosticHandleAlias(aliases, counts, role, raw) {
  if (!raw) return undefined;
  const key = `${role}:${raw}`;
  let alias = aliases.get(key);
  if (!alias) {
    counts[role] = (counts[role] ?? 0) + 1;
    alias = `${role}-${counts[role]}`;
    aliases.set(key, alias);
  }
  return alias;
}

function safeDiagnosticRecord(line, aliases, counts) {
  const jsMarker = line.indexOf(irohDiagnosticPrefix);
  if (jsMarker >= 0) {
    const json = line.slice(jsMarker + irohDiagnosticPrefix.length).trim();
    try {
      const record = JSON.parse(json);
      if (!irohDiagnosticEvents.has(record.event) || typeof record.at !== "number") return null;
      const safe = { layer: "js", event: record.event, at: record.at };
      if (typeof record.elapsedMs === "number") safe.elapsedMs = record.elapsedMs;
      if (typeof record.byteLength === "number") safe.byteLength = record.byteLength;
      if (record.connectionHandle) {
        safe.connection = diagnosticHandleAlias(
          aliases,
          counts,
          "connection",
          record.connectionHandle
        );
      }
      if (record.sendHandle) {
        safe.send = diagnosticHandleAlias(aliases, counts, "send", record.sendHandle);
      }
      return safe;
    } catch {
      return null;
    }
  }

  if (!line.includes("VibestudioIroh") || !line.includes("diagnostic ")) return null;
  const native =
    line.match(/diagnostic (openBi|write) (start|complete)\b(.*)/) ??
    line.match(/diagnostic connectionClosed (wait|settled)\b(.*)/);
  const created = line.match(/diagnostic connection created\b(.*)/);
  if (!native && !created) return null;
  const operation = created
    ? "connection"
    : native[1] === "connectionClosed"
      ? "connection-closed"
      : native[1];
  const stage = created ? "created" : native[2];
  const tail = created ? created[1] : (native[3] ?? "");
  const safe = { layer: "native", event: `${operation}-${stage}` };
  const connection = tail.match(/\bconnection=([^\s]+)/)?.[1];
  const send = tail.match(/\bsend=([^\s]+)/)?.[1];
  const alias = connection
    ? diagnosticHandleAlias(aliases, counts, "connection", connection)
    : send
      ? diagnosticHandleAlias(aliases, counts, "send", send)
      : undefined;
  if (alias) safe[connection ? "connection" : "send"] = alias;
  for (const [key, pattern] of [
    ["atNs", /\batNs=(\d+)/],
    ["elapsedNs", /\belapsedNs=(\d+)/],
    ["byteLength", /\bbyteLength=(\d+)/],
  ]) {
    const value = tail.match(pattern)?.[1];
    if (value !== undefined) safe[key] = Number(value);
  }
  return safe;
}

/** Observe the owned Android log stream; terminal failures outrank old success phases. */
export function observeMobileSmokeLog(child, { expectedPhases, deadlineMs, packageName }) {
  const phases = new Map();
  const recentLines = [];
  const diagnosticAliases = new Map();
  const diagnosticAliasCounts = {};
  let diagnosticLineCount = 0;
  let diagnosticsTruncated = false;
  let buffer = "";
  let stderr = "";
  let appCrashed = false;
  let readerError = null;
  let appProcessId = null;
  let appProcessFailure = null;

  const recordLine = (line) => {
    if (!line) return;
    if (
      line.includes(irohDiagnosticPrefix) ||
      (line.includes("VibestudioIroh") && line.includes("diagnostic "))
    ) {
      const diagnostic = safeDiagnosticRecord(line, diagnosticAliases, diagnosticAliasCounts);
      if (diagnostic) {
        if (diagnosticLineCount < maxIrohDiagnosticLines) {
          console.log(`${irohDiagnosticPrefix} ${JSON.stringify(diagnostic)}`);
          diagnosticLineCount += 1;
        } else if (!diagnosticsTruncated) {
          console.log(
            `${irohDiagnosticPrefix} {"event":"truncated","maxLines":${maxIrohDiagnosticLines}}`
          );
          diagnosticsTruncated = true;
        }
      }
      return;
    }
    if (line.includes("AndroidRuntime") && line.includes(`Process: ${packageName}, PID:`)) {
      appCrashed = true;
    }
    const killed = line.includes("ActivityManager")
      ? line.match(/\bKilling (\d+):([^/\s]+)\/[^:]+:\s*(.*)/)
      : null;
    if (killed && killed[1] === appProcessId && killed[2] === packageName) {
      appProcessFailure ??= `Android destroyed the active app process: ${killed[3]}`;
      recentLines.push(line);
      if (recentLines.length > 200) recentLines.shift();
    }
    if (line.includes(smokePrefix) || line.includes("VibestudioMobileSmokeProbe")) {
      if (line.includes(smokePrefix)) {
        const process = line.match(/ReactNativeJS\(\s*(\d+)\)/);
        if (process) appProcessId = process[1];
      }
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
    if (!appCrashed && !appProcessFailure && !phases.has("embedded-pairing-failed")) return;
    const recent = recentLines.length
      ? `\n\nRecent relevant log lines:\n${recentLines.join("\n")}`
      : "";
    throw new Error(
      `${appProcessFailure ?? (appCrashed ? "The Android app crashed" : "The mobile app reported a terminal pairing failure")}${recent}`
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
  const observedPhase = (phase) => phases.has(phase);
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

  // Relinquish the old process before the runner explicitly stops it. The next
  // app phase binds observation to the newly launched process.
  const releaseAppProcess = () => {
    throwIfTerminalFailure();
    appProcessId = null;
  };
  return {
    child,
    waitForPhase,
    waitForPhaseAfter,
    waitForAnyPhase,
    hasPhase,
    observedPhase,
    phaseCount,
    releaseAppProcess,
  };
}
