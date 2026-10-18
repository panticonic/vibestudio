import { spawn as spawnProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import * as nodePty from "node-pty";
import type {
  ApprovalFeed,
  DeviceOperations,
  IntegrationArtifact,
} from "@vibestudio/shared/deviceDriver";
import type { ClientLaunchResult, ClientListing } from "@vibestudio/workspace-contracts/clients";
import { describeEnd, PtyScreen, type PtyEnd } from "./ptyScreen.js";
import type { ChangeSignal } from "../../../hosts/terminal/clientLaunchGate.js";
import type { TerminalHostState } from "../../../hosts/terminal/hostState.js";

/**
 * The terminal device: the real `vibestudio` CLI, run in PTYs under its own
 * HOME and XDG directories with a test-owned bin directory on PATH, paired as
 * a device of the account before any scenario client exists.
 *
 * Everything observable about it is answered from events: a PTY's output
 * (screen revisions) and exit, the server's `clients:changed`, and the bin
 * directory's own file events. No operation polls or sleeps.
 */

export interface TerminalDevicePorts {
  clients: {
    list(): Promise<ClientListing[]>;
    launch(id: string): Promise<ClientLaunchResult>;
    invokeIntent(input: {
      id: string;
      intent: string;
      params?: Record<string, string>;
    }): Promise<Record<string, unknown>>;
  };
  bootId(): Promise<string>;
  /** Bumped by every `clients:changed` and `supervision:changed`. */
  changes: ChangeSignal;
  approvals: {
    feed: ApprovalFeed;
    resolve(approvalId: string, decision: "once" | "deny" | "accept-review"): Promise<void>;
  };
  hostState: Pick<TerminalHostState, "read">;
}

export interface TerminalDeviceOptions {
  /** Test-owned HOME; the bin directory is `<home>/.local/bin`. */
  home: string;
  /** The environment every child runs with (own HOME and XDG directories; PATH includes the bin directory). */
  env: Record<string, string>;
  cols?: number;
  rows?: number;
  spawnPty?: typeof nodePty.spawn;
}

interface Surface {
  id: string;
  clientId: string;
  pty: nodePty.IPty;
  screen: PtyScreen;
  buildKey: string;
  granted: string[];
  denied: string[];
  developing: boolean;
}

const SIZE = { cols: 120, rows: 40 };

export function binDirectoryOf(home: string): string {
  return path.join(home, ".local", "bin");
}

export function createTerminalDevice(
  ports: TerminalDevicePorts,
  options: TerminalDeviceOptions
): { ops: DeviceOperations; close(): Promise<void> } {
  const size = { cols: options.cols ?? SIZE.cols, rows: options.rows ?? SIZE.rows };
  const spawnPty = options.spawnPty ?? nodePty.spawn;
  const bin = binDirectoryOf(options.home);
  const surfaces = new Map<string, Surface>();
  const shells = new Set<AbortController>();
  const vibestudio = path.join(bin, "vibestudio");

  const surfaceOf = (id: string): Surface => {
    const surface = surfaces.get(id);
    if (!surface) throw Object.assign(new Error(`No surface ${id}`), { code: "ENOENT" });
    return surface;
  };
  const identityOf = (surface: Surface) => ({
    clientId: surface.clientId,
    instanceId: String(surface.pty.pid),
    buildKey: surface.buildKey,
  });
  // A client id can exist once per runtime (`chat` is a web, a React Native and
  // a terminal client); this host runs, and shows, the terminal ones.
  const terminalOnly = (listings: ClientListing[]) =>
    listings.filter((l) => l.runtime === "terminal");
  const listingOf = (id: string, listings: ClientListing[]) =>
    terminalOnly(listings).find((l) => l.id === id);

  /** Re-evaluate `check` after every client or supervision change until it yields a value. */
  async function untilChanged<T>(
    check: () => Promise<T | undefined>,
    signal: AbortSignal
  ): Promise<T> {
    for (;;) {
      signal.throwIfAborted();
      const seen = ports.changes.revision();
      const value = await check();
      if (value !== undefined) return value;
      await ports.changes.wait(seen, signal);
    }
  }

  const shimArtifacts = (): IntegrationArtifact[] => {
    const shims = ports.hostState.read().shims;
    return Object.entries(shims)
      .map(([name, shim]) => ({
        clientId: shim.clientId,
        kind: "shim",
        path: path.join(bin, name),
      }))
      .filter((artifact) => fs.existsSync(artifact.path));
  };

  const ops: DeviceOperations = {
    async identities() {
      return {
        serverBootId: await ports.bootId(),
        hostPid: process.pid,
        instances: [...surfaces.values()].filter((s) => !s.screen.exit).map(identityOf),
      };
    },

    async list() {
      return terminalOnly(await ports.clients.list()).map(liteListing);
    },

    async waitForListing({ id, present }, signal) {
      const found = await untilChanged(async () => {
        const listing = listingOf(id, await ports.clients.list());
        return present === Boolean(listing) ? { listing } : undefined;
      }, signal);
      return found.listing ? liteListing(found.listing) : null;
    },

    async launch({ id, develop }, signal) {
      // The answer the CLI is about to receive: ready, or unavailable on this
      // host. A build still preparing, and an install review still waiting for
      // the person, are not answers: this driver is the person's device, its
      // approval surface answers the review, and the registry announces the
      // outcome with `clients:changed` and `supervision:changed`.
      const plan = await untilChanged(async () => {
        const result = await ports.clients.launch(id);
        return result.state === "preparing" || result.state === "approval-required"
          ? undefined
          : result;
      }, signal);
      if (plan.state === "unavailable") {
        return {
          state: "unavailable",
          reason: plan.reason,
          ...(plan.missing ? { missing: plan.missing } : {}),
        };
      }
      const screen = new PtyScreen(size);
      const pty = spawnPty(vibestudio, ["open", id, ...(develop ? ["--develop"] : [])], {
        name: "xterm-256color",
        cols: size.cols,
        rows: size.rows,
        cwd: options.home,
        env: { ...options.env, TERM: "xterm-256color" },
      });
      const surface: Surface = {
        id: `surface-${randomBytes(6).toString("hex")}`,
        clientId: id,
        pty,
        screen,
        buildKey: plan.client.buildKey,
        granted: [...plan.client.grantedCapabilities],
        denied: [...plan.client.deniedOptional],
        developing: develop === true,
      };
      pty.onData((data) => screen.write(data));
      pty.onExit(({ exitCode, signal: exitSignal }) =>
        screen.end({ exitCode, signal: exitSignal ?? null })
      );
      surfaces.set(surface.id, surface);
      return { state: "ready", surfaceId: surface.id, instance: identityOf(surface) };
    },

    async surfaceInfo({ surfaceId }) {
      const surface = surfaceOf(surfaceId);
      const active =
        listingOf(surface.clientId, await ports.clients.list())?.activeBuildKey ?? null;
      return {
        instance: identityOf(surface),
        grantedCapabilities: surface.granted,
        deniedOptional: surface.denied,
        pendingBuildKey: active && active !== surface.buildKey ? active : null,
        developing: surface.developing,
        closed: surface.screen.exit ? { reason: closeReason(surface) } : null,
      };
    },

    async surfaceText({ surfaceId }) {
      return surfaceOf(surfaceId).screen.text();
    },

    async waitForText({ surfaceId, text }, signal) {
      return surfaceOf(surfaceId).screen.waitForText(text, signal);
    },

    async sendKeys({ surfaceId, keys }) {
      const surface = surfaceOf(surfaceId);
      if (surface.screen.exit) throw new Error(`Surface ${surfaceId} has closed`);
      surface.pty.write(keys);
      return null;
    },

    async waitForClosed({ surfaceId }, signal) {
      const surface = surfaceOf(surfaceId);
      await surface.screen.waitForEnd(signal);
      return { reason: closeReason(surface) };
    },

    async waitForBuildChange({ surfaceId, fromBuildKey }, signal) {
      const surface = surfaceOf(surfaceId);
      const next = await untilChanged(async () => {
        const listing = listingOf(surface.clientId, await ports.clients.list());
        const active = listing?.activeBuildKey;
        if (active && active !== fromBuildKey) return active;
        // A rebuild that failed is the outcome: no build will be adopted for it.
        if (listing?.lastError) {
          throw Object.assign(
            new Error(`The rebuild of ${surface.clientId} was not adopted: ${listing.lastError}`),
            { code: "EBUILDREJECTED" }
          );
        }
        return undefined;
      }, signal);
      surface.buildKey = next;
      return identityOf(surface);
    },

    async closeSurface({ surfaceId }) {
      const surface = surfaceOf(surfaceId);
      // Closing the terminal window: a hang-up, which the CLI restores and exits on.
      if (!surface.screen.exit) surface.pty.kill("SIGHUP");
      return null;
    },

    async invokeIntent({ id, intent, params }) {
      try {
        const result = await ports.clients.invokeIntent({
          id,
          intent,
          ...(params ? { params } : {}),
        });
        return { ok: true, text: String(result["text"] ?? ""), fields: Object.keys(result) };
      } catch (error) {
        const failure = error as { code?: unknown; message?: unknown };
        return {
          ok: false,
          code: typeof failure.code === "string" ? failure.code : "UNKNOWN",
          message: typeof failure.message === "string" ? failure.message : String(error),
        };
      }
    },

    async installLauncher({ id }) {
      const artifact = shimArtifacts().find((candidate) => candidate.clientId === id);
      if (!artifact) {
        throw new Error(
          `The terminal host has no launcher for ${id}; \`vibestudio clients link ${id}\` writes it`
        );
      }
      return artifact;
    },

    async integrationArtifacts() {
      return shimArtifacts();
    },

    async waitForArtifactsRemoved({ clientId }, signal) {
      const gone = () => !shimArtifacts().some((artifact) => artifact.clientId === clientId);
      if (gone()) return null;
      // The running host reconciles its shims when the server reports the
      // client gone; the removal is a file event in the bin directory.
      await new Promise<void>((resolve, reject) => {
        const watcher = fs.watch(bin, () => {
          if (gone()) settle(resolve);
        });
        const abort = () => settle(() => reject(signal.reason));
        const settle = (finish: () => void) => {
          watcher.close();
          signal.removeEventListener("abort", abort);
          finish();
        };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        else if (gone()) settle(resolve);
      });
      return null;
    },

    async nextApproval(_args, signal) {
      return ports.approvals.feed.next(signal);
    },

    async releaseApprovals() {
      ports.approvals.feed.release();
      return null;
    },

    async resolveApproval({ approvalId, decision }) {
      await ports.approvals.resolve(approvalId, decision);
      return null;
    },

    async shell({ commandLine, stdin }, signal) {
      const owner = new AbortController();
      shells.add(owner);
      const stop = AbortSignal.any([signal, owner.signal]);
      try {
        return await new Promise<{ exitCode: number; output: string; stderr: string }>(
          (resolve, reject) => {
            // Not a TTY, like a script: a command's piped output is what it prints for a pipe.
            const child = spawnProcess("/bin/sh", ["-c", commandLine], {
              cwd: options.home,
              env: options.env,
              stdio: ["pipe", "pipe", "pipe"],
              signal: stop,
            });
            let output = "";
            let stderr = "";
            child.stdout.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
            child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
            child.once("error", reject);
            child.once("close", (code, exitSignal) =>
              resolve({ exitCode: code ?? (exitSignal ? 128 : 1), output, stderr })
            );
            if (stdin !== undefined) child.stdin.end(stdin);
            else child.stdin.end();
          }
        );
      } finally {
        shells.delete(owner);
      }
    },

    async binDirectory() {
      return bin;
    },
  };

  return {
    ops,
    async close() {
      for (const owner of shells) owner.abort(new Error("The terminal device is closing"));
      const ended: Promise<PtyEnd>[] = [];
      for (const surface of surfaces.values()) {
        if (!surface.screen.exit) {
          ended.push(surface.screen.waitForEnd());
          surface.pty.kill("SIGHUP");
        }
      }
      await Promise.all(ended);
    },
  };
}

/** The stated reason an instance closed: how it ended and what its terminal last said. */
function closeReason(surface: Surface): string {
  const end = surface.screen.exit!;
  const tail = surface.screen
    .text()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-3)
    .join(" | ");
  return tail ? `${describeEnd(end)}: ${tail}` : describeEnd(end);
}

function liteListing(listing: ClientListing) {
  return {
    id: listing.id,
    source: listing.source,
    runtime: listing.runtime,
    status: listing.status,
    trusted: listing.trusted,
    isDefault: listing.isDefault,
    ...(listing.unavailableReason ? { unavailableReason: listing.unavailableReason } : {}),
    ...(listing.lastError ? { lastError: listing.lastError } : {}),
    intents: listing.intents.map((intent) => ({
      name: intent.name,
      kind: intent.kind,
      ...(intent.handler ? { handler: intent.handler } : {}),
      ...(intent.params ? { params: { ...intent.params } } : {}),
    })),
    activeBuildKey: listing.activeBuildKey,
  };
}
