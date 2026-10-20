import * as fs from "node:fs";
import * as path from "node:path";
import type { ClientListing } from "@vibestudio/workspace-contracts/clients";
import { RESERVED_TERMINAL_COMMANDS, clientIntents } from "@vibestudio/workspace-contracts/clients";
import { writeFileAtomicSync } from "../../src/atomicFile.js";
import { UsageError } from "../../src/cli/output.js";
import {
  buildCommandTable,
  shimDirectory,
  type CommandTable,
  type TerminalHostState,
} from "./hostState.js";

const MARKER = "# vibestudio-client-shim";
const SHIM_NAME = /^[a-z][a-z0-9-]{0,62}$/u;

type Listing = Pick<ClientListing, "id" | "runtime" | "terminalCommand"> &
  Partial<Pick<ClientListing, "intents" | "unavailableReason">>;

/** What a client's shim runs: its registered command, else `open <id>`. */
export function clientInvocation(listing: Listing, table: CommandTable): string {
  return listing.terminalCommand && table.commands[listing.terminalCommand]?.clientId === listing.id
    ? listing.terminalCommand
    : `open ${listing.id}`;
}

function shimScript(invocation: string): string {
  return `#!/bin/sh\n${MARKER}\nexec vibestudio ${invocation} "$@"\n`;
}

function isOurShim(file: string): boolean {
  try {
    return fs.readFileSync(file, "utf8").split("\n")[1] === MARKER;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export interface ShimContext {
  state: TerminalHostState;
  /** Built-in `vibestudio` command names, which no shim may take (a shim named `open` would shadow the system's). */
  isBuiltIn(name: string): boolean;
  directory?: string;
}

export function isBuiltInCommand(registryGroups: Iterable<string>): (name: string) => boolean {
  const builtIn = new Set<string>([...RESERVED_TERMINAL_COMMANDS, ...registryGroups, "vibestudio"]);
  return (name) => builtIn.has(name);
}

/** Write `<name>` into `~/.local/bin`, recording it; never replaces a file this host did not write. */
export function linkClientShim(
  context: ShimContext,
  input: { name: string; listing: Listing; table: CommandTable }
): string {
  const { name } = input;
  if (!SHIM_NAME.test(name)) {
    throw new UsageError(
      `${name} is not a usable command name (lowercase letters, digits, dashes).`
    );
  }
  if (context.isBuiltIn(name)) {
    throw new UsageError(`${name} is a built-in vibestudio command; choose another --name.`);
  }
  const file = path.join(context.directory ?? shimDirectory(), name);
  if (fs.existsSync(file) && !isOurShim(file)) {
    throw new UsageError(
      `${file} already exists and was not written by vibestudio; choose another --name.`
    );
  }
  const invocation = clientInvocation(input.listing, input.table);
  writeFileAtomicSync(file, shimScript(invocation), { mode: 0o755 });
  context.state.recordShim(name, { clientId: input.listing.id, command: invocation });
  return file;
}

/** Remove a shim this host wrote. Returns whether a file was removed. */
export function unlinkClientShim(context: ShimContext, name: string): boolean {
  const recorded = context.state.read().shims[name];
  if (!recorded) throw new UsageError(`${name} is not a shim this host created.`);
  const file = path.join(context.directory ?? shimDirectory(), name);
  let removed = false;
  if (isOurShim(file)) {
    fs.rmSync(file);
    removed = true;
  }
  context.state.forgetShim(name);
  return removed;
}

export interface IndexSync {
  table: CommandTable;
  removedShims: string[];
}

/**
 * Bring host state in line with the clients the server lists: the command
 * table, and every recorded shim (removed only when its client is no longer
 * declared at all, rewritten when the command it launches changed). A declared
 * client that is unavailable here (`unavailableReason`) is still listed, so
 * its shim stays. Called with each `clients.list`,
 * including on `clients:changed`.
 */
export function syncClientIndex(context: ShimContext, listings: readonly Listing[]): IndexSync {
  const table = buildCommandTable(listings, context.isBuiltIn);
  context.state.setClientIndex({
    commands: table.commands,
    clients: Object.fromEntries(
      listings
        .filter((listing) => listing.runtime === "terminal")
        .map((listing) => [
          listing.id,
          { intents: clientIntents({ intents: listing.intents }).map((intent) => intent.name) },
        ])
    ),
  });
  const removedShims: string[] = [];
  const directory = context.directory ?? shimDirectory();
  for (const [name, shim] of Object.entries(context.state.read().shims)) {
    const listing = listings.find((candidate) => candidate.id === shim.clientId);
    if (!listing) {
      unlinkClientShim(context, name);
      removedShims.push(name);
      continue;
    }
    const invocation = clientInvocation(listing, table);
    if (invocation !== shim.command) {
      writeFileAtomicSync(path.join(directory, name), shimScript(invocation), { mode: 0o755 });
      context.state.recordShim(name, { clientId: listing.id, command: invocation });
    }
  }
  return { table, removedShims };
}
