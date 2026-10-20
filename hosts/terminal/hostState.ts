import * as fs from "node:fs";
import * as path from "node:path";
import { writeFileAtomicSync } from "../../src/atomicFile.js";
import { cliConfigRoot } from "../../src/cli/configPaths.js";
import type { ClientListing } from "@vibestudio/workspace-contracts/clients";

/** A `~/.local/bin` shim this host wrote, recorded so it can be removed. */
export interface RecordedShim {
  clientId: string;
  /** The command the shim runs: the client's terminal command or `open <id>`. */
  command: string;
}

/** What the host remembers about the clients on this device. */
export interface TerminalHostStateData {
  schemaVersion: 1;
  /** Shim file name -> what it launches. */
  shims: Record<string, RecordedShim>;
  /** Clients in development mode (per client, per device; §7.4). */
  develop: Record<string, true>;
  /** `vibestudio <command>` -> client, from the last `clients.list`. */
  commands: Record<string, { clientId: string }>;
  /** Terminal clients from the last `clients.list`, for shell completion (no network at Tab). */
  clients: Record<string, { intents: string[] }>;
}

const EMPTY: TerminalHostStateData = {
  schemaVersion: 1,
  shims: {},
  develop: {},
  commands: {},
  clients: {},
};

export function terminalHostStatePath(root = cliConfigRoot()): string {
  return path.join(root, "terminal-host.json");
}

export function shimDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const home = env["HOME"];
  if (!home) throw new Error("HOME is not set; cannot locate ~/.local/bin");
  return path.join(home, ".local", "bin");
}

export interface CommandTable {
  /** command -> client id for every client command that may be registered. */
  commands: Record<string, { clientId: string }>;
  /** Client commands that were not registered, and why. */
  rejected: Array<{ command: string; clientId: string; reason: string }>;
}

/**
 * The commands clients may register. A client never shadows a built-in command
 * (the server rejects reserved names at manifest validation; this is the
 * host-side guarantee against any name the CLI itself defines), and a name two
 * clients claim belongs to neither.
 */
export function buildCommandTable(
  listings: readonly Pick<ClientListing, "id" | "terminalCommand" | "runtime">[],
  isBuiltIn: (command: string) => boolean
): CommandTable {
  const commands: CommandTable["commands"] = {};
  const rejected: CommandTable["rejected"] = [];
  const claims = new Map<string, string[]>();
  for (const listing of listings) {
    if (listing.runtime !== "terminal" || !listing.terminalCommand) continue;
    claims.set(listing.terminalCommand, [
      ...(claims.get(listing.terminalCommand) ?? []),
      listing.id,
    ]);
  }
  for (const [command, ids] of claims) {
    if (isBuiltIn(command)) {
      for (const clientId of ids) {
        rejected.push({ command, clientId, reason: "it is a built-in vibestudio command" });
      }
    } else if (ids.length > 1) {
      for (const clientId of ids) {
        rejected.push({ command, clientId, reason: `clients ${ids.join(", ")} all claim it` });
      }
    } else {
      commands[command] = { clientId: ids[0]! };
    }
  }
  return { commands, rejected };
}

/** Host-owned, per-device state of the terminal host: 0600, replaced atomically. */
export class TerminalHostState {
  constructor(private readonly file = terminalHostStatePath()) {}

  read(): TerminalHostStateData {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(EMPTY);
      throw error;
    }
    let parsed: Partial<TerminalHostStateData>;
    try {
      parsed = JSON.parse(raw) as Partial<TerminalHostStateData>;
    } catch (error) {
      throw new Error(`${this.file} is not valid JSON; remove it to reset.`, { cause: error });
    }
    if (parsed.schemaVersion !== 1) {
      throw new Error(`${this.file} has an unsupported schema version; remove it to reset.`);
    }
    return {
      schemaVersion: 1,
      shims: parsed.shims ?? {},
      develop: parsed.develop ?? {},
      commands: parsed.commands ?? {},
      clients: parsed.clients ?? {},
    };
  }

  private update(change: (data: TerminalHostStateData) => void): TerminalHostStateData {
    const data = this.read();
    change(data);
    writeFileAtomicSync(this.file, JSON.stringify(data, null, 2), { mode: 0o600 });
    return data;
  }

  isDevelopment(clientId: string): boolean {
    return this.read().develop[clientId] === true;
  }

  setDevelopment(clientId: string, on: boolean): void {
    this.update((data) => {
      if (on) data.develop[clientId] = true;
      else delete data.develop[clientId];
    });
  }

  commandClient(command: string): string | null {
    return this.read().commands[command]?.clientId ?? null;
  }

  /** Replace what the last `clients.list` taught this host, in one write. */
  setClientIndex(index: Pick<TerminalHostStateData, "commands" | "clients">): void {
    this.update((data) => {
      data.commands = index.commands;
      data.clients = index.clients;
    });
  }

  recordShim(name: string, shim: RecordedShim): void {
    this.update((data) => {
      data.shims[name] = shim;
    });
  }

  forgetShim(name: string): void {
    this.update((data) => {
      delete data.shims[name];
    });
  }
}
