import type { LinuxPackageOwner } from "./linuxPackageOwner.js";
import { clipboard } from "electron";
import semver from "semver";
import type { EventService } from "@vibestudio/shared/eventsService";
import type { NotificationAction } from "@vibestudio/shared/events";
import { RELEASES_FEED, macReleaseDownload } from "@vibestudio/shared/releaseDownloads";

/**
 * Tell the user a new release exists, and install it where the platform lets us.
 *
 * Availability was never the slow part: the release workflow publishes the apt
 * and dnf repositories in the same run that creates the GitHub release. What is
 * slow is a person remembering to run `apt upgrade`. So detection is one
 * uniform path — the GitHub releases feed, which every platform can read — and
 * only installation differs:
 *
 *   Windows  NSIS has no package manager behind it, so electron-updater
 *            downloads the release and installs it on quit.
 *   macOS    The same, for a signed build whose Homebrew cask declares
 *            `auto_updates true` and therefore defers to this updater.
 *   Linux    deb/rpm/pacman belong to the system package manager, which is the
 *            right owner and the wrong thing to drive silently from a GUI. We
 *            run the upgrade with explicit authorization, or offer the command.
 */
const STARTUP_DELAY_MS = 30_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60_000;
const RECOVERY_TRIGGER_AGE_MS = 15 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const NOTIFICATION_ID = "desktop-release-update";
const INSTALL_NOTIFICATION_ID = "desktop-release-update-install-status";

export type ReleaseUpdateCheckReason = "startup" | "interval" | "resume" | "network";

/** The root command that upgrades a Linux installation. */
export interface LinuxUpgrade {
  /** What a person would type, including the privilege they need. */
  display: string;
  /** argv run as root, without a shell-level privilege prefix. */
  argv: readonly string[];
}

/**
 * How this installation can be moved to a newer release.
 *
 * `command` is whatever package manager owns this copy — apt/dnf/pacman as
 * root through polkit, or Homebrew as the user. `announce-only` is a packaged
 * build whose upgrade we cannot drive: saying a release exists is still worth
 * more than silence, which is what the retired npm updater left every
 * non-npm install with.
 */
export type UpdateDelivery =
  | { kind: "in-app" }
  | { kind: "download" }
  | { kind: "command"; upgrade: LinuxUpgrade; elevate: boolean; canRun: boolean }
  | { kind: "announce-only" };

export interface AvailableRelease {
  currentVersion: string;
  targetVersion: string;
  checkedAt: number;
  delivery: UpdateDelivery;
  downloadUrl?: string;
}

export interface ReleaseUpdateController {
  start(): void;
  stop(): void;
  checkNow(reason: ReleaseUpdateCheckReason): Promise<void>;
  triggerIfStale(reason: "resume" | "network"): void;
  requestInstall(): Promise<void>;
  copyUpgradeCommand(): void;
  handleNotificationAction(id: string, actionId: string): Promise<void>;
}

export interface ReleaseUpdateInstaller {
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void | Promise<void>;
}

export interface ReleaseUpdateControllerDeps {
  eventService: EventService;
  currentVersion: string;
  /** Only a packaged install has a release to move to. */
  packaged: boolean;
  platform?: NodeJS.Platform;
  /** Which Linux package manager owns this installation, when one does. */
  linuxUpgrade?: () => LinuxUpgrade | null;
  /** Whether this host can raise one command to root interactively. */
  canElevate?: () => boolean;
  /** macOS: whether this build carries a Developer ID signature. */
  developerIdSigned?: () => boolean;
  /** macOS: the reachable Homebrew upgrade for the installed cask. */
  brewUpgrade?: () => LinuxUpgrade | null;
  /** Run one argv, elevating through polkit when asked. */
  runCommand?: (
    argv: readonly string[],
    options: { elevate: boolean }
  ) => Promise<{ code: number | null; stderr: string }>;
  installer?: () => ReleaseUpdateInstaller;
  openExternal?: (url: string) => Promise<void>;
  restart?: () => Promise<void>;
  installedVersion?: () => Promise<string | null>;
  /** Preserve the outgoing workspace host before any installer can replace it. */
  prepareInstall: () => Promise<void>;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
  writeClipboard?: (value: string) => void;
}

/**
 * The command that upgrades this Linux installation.
 *
 * Read from the package database rather than the distribution's identity: a
 * host can carry more than one of these managers, and the one that owns our
 * files is the one that can upgrade them.
 *
 * The argv runs as root through pkexec, so it carries no `sudo` and asks the
 * package manager not to prompt — polkit already collected the one consent
 * there is to collect, and a hidden apt question would hang a GUI action with
 * nothing to answer it. `display` keeps the `sudo` form a person would type.
 */
export function linuxUpgradeCommandFor(owner: LinuxPackageOwner | null): LinuxUpgrade | null {
  if (!owner) return null;
  const name = `'${owner.name.replaceAll("'", "'\\''")}'`;
  switch (owner.manager) {
    case "deb":
      return {
        display: `sudo apt update && sudo apt install --only-upgrade ${name}`,
        argv: ["sh", "-lc", `apt-get update && apt-get install --only-upgrade -y ${name}`],
      };
    case "rpm":
      return {
        display: `sudo dnf upgrade --refresh ${name}`,
        argv: ["dnf", "upgrade", "--refresh", "-y", owner.name],
      };
    case "pacman":
      return {
        display: `sudo pacman -Syu ${name}`,
        argv: ["pacman", "-Syu", "--noconfirm", owner.name],
      };
    default:
      return null;
  }
}

/** How a newer release reaches this installation, or null when none can. */
export function updateDeliveryFor(input: {
  platform: NodeJS.Platform;
  packaged: boolean;
  linuxUpgrade: LinuxUpgrade | null;
  canElevate: boolean;
  /** macOS only: Squirrel refuses to replace a build without a Developer ID. */
  developerIdSigned: boolean;
  /** macOS only: the Homebrew that installed the cask, when it is reachable. */
  brewUpgrade: LinuxUpgrade | null;
}): UpdateDelivery | null {
  if (!input.packaged) return null;
  if (input.platform === "win32") return { kind: "in-app" };
  if (input.platform === "darwin") {
    if (input.developerIdSigned) return { kind: "in-app" };
    // An ad-hoc signed build cannot replace itself, so the cask that installed
    // it is the update path — the reason that tap exists.
    if (input.brewUpgrade)
      return { kind: "command", upgrade: input.brewUpgrade, elevate: false, canRun: true };
    return { kind: "download" };
  }
  if (input.platform === "linux") {
    if (input.linuxUpgrade && input.canElevate) {
      return { kind: "command", upgrade: input.linuxUpgrade, elevate: true, canRun: true };
    }
    if (input.linuxUpgrade)
      return { kind: "command", upgrade: input.linuxUpgrade, elevate: false, canRun: false };
    return { kind: "announce-only" };
  }
  return null;
}

/** The newer release in a bounded releases-feed payload, or null. */
export function newerReleaseVersion(
  payload: unknown,
  currentVersion: string
): { version: string } | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as { tag_name?: unknown; draft?: unknown; prerelease?: unknown };
  if (record.draft === true || record.prerelease === true) return null;
  const tag = typeof record.tag_name === "string" ? record.tag_name.replace(/^v/u, "") : null;
  if (!tag) return null;
  const target = semver.valid(tag);
  if (!target || !semver.valid(currentVersion)) return null;
  return semver.gt(target, currentVersion) ? { version: target } : null;
}

export function createReleaseUpdateController(
  deps: ReleaseUpdateControllerDeps
): ReleaseUpdateController | null {
  const platform = deps.platform ?? process.platform;
  const delivery = updateDeliveryFor({
    platform,
    packaged: deps.packaged,
    linuxUpgrade: deps.linuxUpgrade?.() ?? null,
    canElevate: deps.canElevate?.() ?? false,
    developerIdSigned: deps.developerIdSigned?.() ?? false,
    brewUpgrade: deps.brewUpgrade?.() ?? null,
  });
  // A development, linked or unpackaged launch has no release to install, and a
  // Linux install we cannot attribute to a package manager has no command to
  // offer. Saying nothing beats naming a command that would not work.
  if (!delivery) return null;

  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimeout ?? globalThis.setTimeout;
  const clearTimer = deps.clearTimeout ?? globalThis.clearTimeout;
  const writeClipboard = deps.writeClipboard ?? ((value: string) => clipboard.writeText(value));
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  let installInFlight: Promise<void> | null = null;
  let lastCompletedAt = 0;
  let candidate: AvailableRelease | null = null;
  let dismissedVersion: string | null = null;

  const schedule = (delay: number, reason: ReleaseUpdateCheckReason) => {
    if (stopped) return;
    if (timer) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      void checkNow(reason);
    }, delay);
    timer.unref?.();
  };

  const showCandidate = (available: AvailableRelease) => {
    deps.eventService.emit("notification:show", {
      id: NOTIFICATION_ID,
      type: "info",
      title: `Vibestudio ${available.targetVersion} is available`,
      message: updateMessage(available.delivery),
      ttl: 0,
      actions: updateActions(available.delivery),
    });
  };

  const performCheck = async (): Promise<void> => {
    const payload = await fetchLatestRelease(fetchImpl);
    if (stopped) return;
    const newer = newerReleaseVersion(payload, deps.currentVersion);
    if (!newer) {
      candidate = null;
      deps.eventService.emit("notification:dismiss", { id: NOTIFICATION_ID });
      return;
    }
    // Release creation precedes artifact publication. Wait for the installer
    // for this exact release rather than offering a download that isn't ready.
    const downloadUrl = delivery.kind === "download" ? macReleaseDownload(payload) : undefined;
    if (delivery.kind === "download" && !downloadUrl) return;
    candidate = Object.freeze({
      currentVersion: deps.currentVersion,
      targetVersion: newer.version,
      checkedAt: now(),
      delivery,
      ...(downloadUrl ? { downloadUrl } : {}),
    });
    if (dismissedVersion !== candidate.targetVersion) showCandidate(candidate);
  };

  const checkNow = async (reason: ReleaseUpdateCheckReason): Promise<void> => {
    if (stopped) return;
    if (inFlight) return inFlight;
    inFlight = performCheck()
      .catch((error: unknown) => {
        // An update check is background work: a offline host or a rate-limited
        // feed must never interrupt the session.
        console.warn(
          `[release-update] ${reason} check failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      })
      .finally(() => {
        inFlight = null;
        lastCompletedAt = now();
        schedule(CHECK_INTERVAL_MS, "interval");
      });
    return inFlight;
  };

  const installInApp = async (): Promise<void> => {
    const installer = deps.installer?.();
    if (!installer) throw new Error("This build cannot install updates by itself.");
    await installer.downloadUpdate();
    await installer.quitAndInstall();
  };

  /**
   * Hand one upgrade command to the system package manager as root.
   *
   * polkit owns the consent, so a refused or unanswered prompt is an ordinary
   * outcome rather than a failure to report as broken. The running app is still
   * the old build afterwards, so a successful upgrade ends in an offer to
   * restart rather than a silent swap.
   */
  const installThroughPackageManager = async (
    upgrade: LinuxUpgrade,
    elevate: boolean,
    targetVersion: string
  ): Promise<void> => {
    const run = deps.runCommand;
    if (!run) throw new Error("This host cannot run the upgrade command.");
    const result = await run(upgrade.argv, { elevate });
    if (result.code === 0) {
      const installed = await deps.installedVersion?.();
      const version = installed ? semver.coerce(installed) : null;
      if (!version)
        throw new Error("The upgrade finished, but the installed version could not be verified.");
      if (semver.lt(version, targetVersion)) {
        throw new Error(
          `The package repository still provides Vibestudio ${installed}. Version ${targetVersion} is not available there yet. Your current app is still usable; try the upgrade again once the repository publishes it.`
        );
      }
      deps.eventService.emit("notification:show", {
        id: INSTALL_NOTIFICATION_ID,
        type: "success",
        title: "Vibestudio updated",
        message: "Restart to use the new release.",
        ttl: 0,
        actions: [
          {
            id: "desktop-release-update-restart",
            label: "Restart now",
            variant: "solid",
            command: { type: "desktop.restartForUpdate" as const },
          },
        ],
      });
      return;
    }
    // 126/127 are polkit's own refusals: dismissed, unauthorized, or no agent
    // to ask. None of those mean the upgrade itself would fail.
    if (elevate && (result.code === 126 || result.code === 127)) {
      throw new Error(
        `The system did not authorize the upgrade. ${result.stderr.trim().slice(0, 400)} Run it yourself with: ${upgrade.display}`
      );
    }
    throw new Error(
      `The package manager exited with ${String(result.code ?? "no status")}. ` +
        `${result.stderr.trim().slice(0, 400) || `Run it yourself with: ${upgrade.display}`}`
    );
  };

  const controller: ReleaseUpdateController = {
    start() {
      if (stopped) return;
      schedule(STARTUP_DELAY_MS, "startup");
    },
    stop() {
      stopped = true;
      if (timer) clearTimer(timer);
      timer = null;
    },
    checkNow,
    triggerIfStale(reason) {
      if (stopped || inFlight) return;
      if (now() - lastCompletedAt < RECOVERY_TRIGGER_AGE_MS) return;
      schedule(0, reason);
    },
    async requestInstall() {
      if (!candidate) throw new Error("No update is currently available.");
      if (delivery.kind === "announce-only") {
        throw new Error("This installation updates from the releases page.");
      }
      if (delivery.kind === "command" && !delivery.canRun) {
        throw new Error(`Run this command in a terminal: ${delivery.upgrade.display}`);
      }
      if (installInFlight) return installInFlight;
      const available = candidate;
      if (delivery.kind !== "download") {
        deps.eventService.emit("notification:show", {
          id: INSTALL_NOTIFICATION_ID,
          type: "info",
          title: "Updating Vibestudio",
          message:
            delivery.kind === "in-app"
              ? "Downloading the update. Vibestudio will restart when it is ready."
              : "Installing through your package manager. Complete the system permission prompt if asked; you can keep working while the upgrade runs.",
          ttl: 0,
        });
      }
      installInFlight = (async () => {
        await deps.prepareInstall();
        if (delivery.kind === "download") {
          if (!available.downloadUrl || !deps.openExternal) {
            throw new Error("The Mac installer download is unavailable.");
          }
          await deps.openExternal(available.downloadUrl);
          deps.eventService.emit("notification:show", {
            id: "desktop-release-update-download-instructions",
            type: "info",
            title: "Install the downloaded update",
            message:
              "Open the downloaded DMG, quit Vibestudio, drag Vibestudio into Applications and choose Replace, then reopen it. If macOS blocks it, choose Open Anyway in Privacy & Security.",
            ttl: 0,
          });
          return;
        }
        return delivery.kind === "in-app"
          ? installInApp()
          : installThroughPackageManager(
              delivery.upgrade,
              delivery.elevate,
              available.targetVersion
            );
      })().finally(() => {
        installInFlight = null;
      });
      return installInFlight;
    },
    copyUpgradeCommand() {
      if (delivery.kind !== "command") return;
      writeClipboard(delivery.upgrade.display);
      deps.eventService.emit("notification:show", {
        id: "desktop-release-update-command-copied",
        type: "success",
        title: "Upgrade command copied",
        message: "Paste it into a terminal to install the new release.",
        ttl: 6000,
      });
    },
    async handleNotificationAction(id, actionId) {
      if (
        stopped ||
        (id !== NOTIFICATION_ID &&
          id !== INSTALL_NOTIFICATION_ID &&
          id !== "desktop-release-update-error")
      )
        return;
      if (actionId === "dismiss") {
        dismissedVersion = candidate?.targetVersion ?? null;
        return;
      }
      try {
        if (actionId === "desktop-release-update-install") await controller.requestInstall();
        else if (actionId === "desktop-release-update-restart") await deps.restart?.();
        else if (actionId === "desktop-release-update-copy-command")
          controller.copyUpgradeCommand();
      } catch (error) {
        deps.eventService.emit("notification:dismiss", { id: INSTALL_NOTIFICATION_ID });
        deps.eventService.emit("notification:show", {
          id: "desktop-release-update-error",
          type: "error",
          title: "Update could not continue",
          message: error instanceof Error ? error.message : String(error),
          ttl: 0,
          actions: updateActions(delivery),
        });
        throw error;
      }
    },
  };
  return controller;
}

function updateMessage(delivery: UpdateDelivery): string {
  switch (delivery.kind) {
    case "in-app":
      return "Install it and restart when you are ready.";
    case "download":
      return "Download the DMG, quit Vibestudio, replace it in Applications, then reopen it.";
    case "command":
      return delivery.elevate
        ? "Your package manager installs it; the system will ask for permission."
        : `Your package manager installs it: ${delivery.upgrade.display}`;
    default:
      return "Install it from the releases page when you are ready.";
  }
}

function updateActions(delivery: UpdateDelivery) {
  if (delivery.kind === "announce-only") return [];
  const actions: NotificationAction[] = [];
  if (delivery.kind !== "command" || delivery.canRun) {
    actions.push({
      id: "desktop-release-update-install",
      label:
        delivery.kind === "download"
          ? "Download update"
          : delivery.kind === "command"
            ? "Install update"
            : "Update and restart",
      variant: "solid" as const,
      command: { type: "desktop.installUpdate" as const },
    });
  }
  if (delivery.kind === "command") {
    actions.push({
      id: "desktop-release-update-copy-command",
      label: "Copy upgrade command",
      variant: "soft" as const,
      command: { type: "desktop.copyUpgradeCommand" as const },
    });
  }
  return actions;
}

async function fetchLatestRelease(fetchImpl: typeof globalThis.fetch): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(RELEASES_FEED, {
      signal: controller.signal,
      headers: { accept: "application/vnd.github+json" },
    });
    if (!response.ok) throw new Error(`releases feed returned HTTP ${response.status}`);
    const text = await readBounded(response);
    return JSON.parse(text) as unknown;
  } finally {
    clearTimeout(timeout);
  }
}

/** Read a bounded body: an update check must not be a memory decision. */
async function readBounded(response: Response): Promise<string> {
  const body = response.body;
  if (!body) return await response.text();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("releases feed response exceeded the accepted size");
      }
      chunks.push(value);
    }
  }
  return new TextDecoder().decode(concat(chunks, total));
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
