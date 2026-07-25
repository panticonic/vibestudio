import { clipboard, dialog } from "electron";
import type { EventService } from "@vibestudio/shared/eventsService";
import semver from "semver";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  NPM_DESKTOP_PACKAGE_NAME,
  NPM_UPDATE_CONTRACT_VERSION,
  NPM_UPDATE_ENV,
  NPM_UPDATE_FILES,
  isPrivateUpdateFile,
  parseUpdateLaunchEnvironment,
  readPrivateJson,
  validateUpdateResult,
  writePrivateJsonAtomic,
  type UpdateLaunch,
} from "../../scripts/npm-update-contract.mjs";

const REGISTRY = "https://registry.npmjs.org";
const STARTUP_DELAY_MS = 30_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60_000;
const RECOVERY_TRIGGER_AGE_MS = 15 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 128 * 1024;
const NOTIFICATION_ID = "desktop-npm-update";
let pendingManualUpdateVersion: string | null = null;

export type NpmUpdateCheckReason = "startup" | "interval" | "resume" | "network";

export interface AvailableNpmUpdate {
  currentVersion: string;
  targetVersion: string;
  checkedAt: number;
  installable: boolean;
}

export interface NpmUpdateController {
  start(): void;
  checkNow(reason: NpmUpdateCheckReason): Promise<void>;
  triggerIfStale(reason: "resume" | "network"): void;
  requestInstall(): Promise<void>;
  copyUpdateCommand(): void;
  stop(): void;
}

export function copyPendingNpmUpdateCommand(targetVersion = pendingManualUpdateVersion): void {
  if (!targetVersion) throw new Error("No npm update is currently available.");
  clipboard.writeText(`npm install -g ${NPM_DESKTOP_PACKAGE_NAME}@${targetVersion}`);
}

interface NpmUpdateControllerDeps {
  eventService: EventService;
  launch?: UpdateLaunch | null;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
  ownsLocalHub: () => boolean;
  requestUpdateQuit: (targetVersion: string) => void;
}

export function createNpmUpdateController(
  deps: NpmUpdateControllerDeps
): NpmUpdateController | null {
  const launch = deps.launch ?? parseUpdateLaunchEnvironment();
  if (!launch || launch.packageName !== NPM_DESKTOP_PACKAGE_NAME) return null;
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimeout ?? globalThis.setTimeout;
  const clearTimer = deps.clearTimeout ?? globalThis.clearTimeout;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  let installRequestInFlight: Promise<void> | null = null;
  let lastCompletedAt = 0;
  let candidate: AvailableNpmUpdate | null = null;

  const schedule = (delay: number, reason: NpmUpdateCheckReason) => {
    if (stopped) return;
    if (timer) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      void checkNow(reason);
    }, delay);
    timer.unref?.();
  };

  const showCandidate = (available: AvailableNpmUpdate) => {
    deps.eventService.emit("notification:show", {
      id: NOTIFICATION_ID,
      type: "info",
      title: `Vibestudio ${available.targetVersion} is available`,
      message: available.installable
        ? "Restart Vibestudio to install the update."
        : "This npm installation is not writable by the current user. Copy the exact update command and run it in the environment that owns this npm prefix.",
      ttl: 0,
      actions: [
        available.installable
          ? {
              id: "desktop-npm-update-install",
              label: "Update and restart",
              variant: "solid",
              command: { type: "desktop.installNpmUpdate" as const },
            }
          : {
              id: "desktop-npm-update-copy",
              label: "Copy update command",
              variant: "solid",
              command: { type: "desktop.copyNpmUpdateCommand" as const },
            },
      ],
    });
  };

  const performCheck = async (reason: NpmUpdateCheckReason) => {
    try {
      const latest = await fetchRegistryVersion(
        `${REGISTRY}/${encodeURIComponent(NPM_DESKTOP_PACKAGE_NAME)}/latest`,
        fetchImpl
      );
      if (!latest || !semver.valid(latest)) return;
      if (!semver.gt(latest, launch.currentVersion)) {
        candidate = null;
        deps.eventService.emit("notification:dismiss", { id: NOTIFICATION_ID });
        return;
      }
      candidate = Object.freeze({
        currentVersion: launch.currentVersion,
        targetVersion: latest,
        checkedAt: now(),
        installable: launch.canInstall,
      });
      showCandidate(candidate);
    } catch (error) {
      console.warn(
        `[npm-update] ${reason} check failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    } finally {
      lastCompletedAt = now();
      schedule(CHECK_INTERVAL_MS, "interval");
    }
  };

  const checkNow = (reason: NpmUpdateCheckReason): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (inFlight) return inFlight;
    inFlight = performCheck(reason).finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  return {
    start() {
      if (!stopped && !timer && !inFlight) schedule(STARTUP_DELAY_MS, "startup");
    },
    checkNow,
    triggerIfStale(reason) {
      if (!stopped && now() - lastCompletedAt >= RECOVERY_TRIGGER_AGE_MS) {
        void checkNow(reason);
      }
    },
    requestInstall() {
      if (installRequestInFlight) return installRequestInFlight;
      installRequestInFlight = (async () => {
        const selected = candidate;
        if (!selected?.installable || !launch.requestDirectory || !launch.nonce) {
          throw new Error("This installation cannot update itself.");
        }
        const confirmedVersion = await fetchRegistryVersion(
          `${REGISTRY}/${encodeURIComponent(NPM_DESKTOP_PACKAGE_NAME)}/${encodeURIComponent(
            selected.targetVersion
          )}`,
          fetchImpl
        );
        if (confirmedVersion !== selected.targetVersion) {
          throw new Error(`Vibestudio ${selected.targetVersion} is no longer available from npm.`);
        }
        if (deps.ownsLocalHub()) {
          const { response } = await dialog.showMessageBox({
            type: "warning",
            buttons: ["Cancel", "Update and restart"],
            defaultId: 1,
            cancelId: 0,
            title: "Update Vibestudio",
            message: "Updating restarts the local Vibestudio hub.",
            detail: "Running background work will be interrupted.",
          });
          if (response !== 1) return;
        }
        const requestPath = path.join(launch.requestDirectory, NPM_UPDATE_FILES.request);
        writePrivateJsonAtomic(requestPath, {
          contractVersion: NPM_UPDATE_CONTRACT_VERSION,
          action: "install-update",
          packageName: NPM_DESKTOP_PACKAGE_NAME,
          nonce: launch.nonce,
          fromVersion: launch.currentVersion,
          toVersion: selected.targetVersion,
          requestedAt: new Date(now()).toISOString(),
        });
        stopped = true;
        if (timer) clearTimer(timer);
        timer = null;
        deps.requestUpdateQuit(selected.targetVersion);
      })().finally(() => {
        installRequestInFlight = null;
      });
      return installRequestInFlight;
    },
    copyUpdateCommand() {
      const targetVersion = candidate?.targetVersion ?? pendingManualUpdateVersion;
      if (!targetVersion) throw new Error("No npm update is currently available.");
      copyPendingNpmUpdateCommand(targetVersion);
      deps.eventService.emit("notification:show", {
        id: "desktop-npm-update-command-copied",
        type: "success",
        title: "Update command copied",
        message: "Paste it into a terminal owned by the npm installation.",
      });
    },
    stop() {
      stopped = true;
      if (timer) clearTimer(timer);
      timer = null;
    },
  };
}

export function consumeNpmUpdateResult(eventService: EventService): void {
  const resultPath = process.env[NPM_UPDATE_ENV.resultPath];
  Reflect.deleteProperty(process.env, NPM_UPDATE_ENV.resultPath);
  if (!isPrivateUpdateFile(resultPath, NPM_UPDATE_FILES.result)) return;
  const result = readPrivateJson(resultPath, validateUpdateResult);
  if (
    !result ||
    !isPrivateUpdateFile(result.logPath, NPM_UPDATE_FILES.log) ||
    path.dirname(result.logPath) !== path.dirname(resultPath) ||
    Date.now() - Date.parse(result.completedAt) > 7 * 24 * 60 * 60_000
  ) {
    try {
      fs.rmSync(resultPath, { force: true });
    } catch {
      // Ignore an untrusted or already-consumed marker.
    }
    return;
  }
  const command = `npm install -g ${NPM_DESKTOP_PACKAGE_NAME}@${result.toVersion}`;
  if (result.outcome === "succeeded") {
    pendingManualUpdateVersion = null;
    eventService.emit("notification:show", {
      id: "desktop-npm-update-result",
      type: "success",
      title: `Updated to Vibestudio ${result.toVersion}`,
      message: "The npm update completed successfully.",
    });
    fs.rmSync(path.dirname(resultPath), { recursive: true, force: true });
    return;
  }
  pendingManualUpdateVersion = result.toVersion;
  eventService.emit("notification:show", {
    id: "desktop-npm-update-result",
    type: "error",
    title:
      result.outcome === "restored"
        ? "Vibestudio update was rolled back"
        : "Vibestudio update failed",
    message: `${result.summary}\n\nLog: ${result.logPath}\nManual command: ${command}`,
    ttl: 0,
    details: [
      { label: "Attempted version", value: result.toVersion },
      { label: "Installed version", value: result.installedVersion ?? "unknown" },
      { label: "Update log", value: result.logPath, mono: true },
    ],
    actions: [
      {
        id: "desktop-npm-update-copy-result",
        label: "Copy update command",
        command: { type: "desktop.copyNpmUpdateCommand" },
      },
    ],
  });
  fs.rmSync(resultPath, { force: true });
}

async function fetchRegistryVersion(
  url: string,
  fetchImpl: typeof globalThis.fetch
): Promise<string> {
  const response = await fetchImpl(url, {
    headers: { accept: "application/vnd.npm.install-v1+json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}`);
  const declaredSize = Number(response.headers.get("content-length") ?? "0");
  if (declaredSize > MAX_RESPONSE_BYTES) throw new Error("npm registry response was too large");
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
    throw new Error("npm registry response was too large");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("npm registry returned malformed JSON");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    typeof value.version !== "string" ||
    !semver.valid(value.version)
  ) {
    throw new Error("npm registry response did not contain a valid version");
  }
  return value.version;
}
