import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { cliConfigRoot } from "../configPaths.js";

export const friendlyVcsMutationMethods = ["move", "copy", "commit", "discard", "push"] as const;
export type FriendlyVcsMutationMethod = (typeof friendlyVcsMutationMethods)[number];

export interface VcsCommandJournalEntry {
  schemaVersion: 1;
  serverUrl: string;
  contextId: string;
  commandId: string;
  method: FriendlyVcsMutationMethod;
  intent: unknown;
  input: Record<string, unknown>;
  createdAt: number;
}

const allowedKeys = new Set([
  "schemaVersion",
  "serverUrl",
  "contextId",
  "commandId",
  "method",
  "intent",
  "input",
  "createdAt",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEntry(value: unknown): value is VcsCommandJournalEntry {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== allowedKeys.size ||
    Object.keys(value).some((key) => !allowedKeys.has(key)) ||
    !Object.hasOwn(value, "intent")
  )
    return false;
  return (
    value["schemaVersion"] === 1 &&
    typeof value["serverUrl"] === "string" &&
    value["serverUrl"] !== "" &&
    typeof value["contextId"] === "string" &&
    value["contextId"] !== "" &&
    typeof value["commandId"] === "string" &&
    value["commandId"] !== "" &&
    friendlyVcsMutationMethods.includes(value["method"] as FriendlyVcsMutationMethod) &&
    isRecord(value["input"]) &&
    typeof value["createdAt"] === "number" &&
    Number.isSafeInteger(value["createdAt"])
  );
}

export function vcsCommandJournalDir(): string {
  return path.join(cliConfigRoot(), "vcs-command-journal");
}

export function vcsCommandJournalPath(target: {
  serverUrl: string;
  contextId: string;
  commandId: string;
}): string {
  const digest = createHash("sha256")
    .update(target.serverUrl)
    .update("\0")
    .update(target.contextId)
    .update("\0")
    .update(target.commandId)
    .digest("hex");
  return path.join(vcsCommandJournalDir(), `${digest}.json`);
}

export function loadVcsCommandJournalEntry(target: {
  serverUrl: string;
  contextId: string;
  commandId: string;
}): VcsCommandJournalEntry | null {
  const file = vcsCommandJournalPath(target);
  if (!fs.existsSync(file)) return null;
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(
      `Could not read VCS retry journal ${file}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!isEntry(value)) {
    throw new Error(
      `Invalid VCS retry journal entry ${file}; restore or remove it before retrying`
    );
  }
  if (
    value.serverUrl !== target.serverUrl ||
    value.contextId !== target.contextId ||
    value.commandId !== target.commandId
  ) {
    throw new Error(`VCS retry journal identity mismatch in ${file}`);
  }
  return value;
}

export function saveVcsCommandJournalEntry(entry: VcsCommandJournalEntry): void {
  const existing = loadVcsCommandJournalEntry(entry);
  if (existing) {
    if (!isDeepStrictEqual(existing, entry)) {
      throw new Error(`VCS command ${entry.commandId} already has a different durable request`);
    }
    return;
  }
  const file = vcsCommandJournalPath(entry);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporary = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  let linked = false;
  try {
    const descriptor = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(descriptor, `${JSON.stringify(entry, null, 2)}\n`);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    try {
      // A hard link publishes the fully-synced inode only if the command still
      // has no journal entry. Unlike rename, it cannot replace a racing writer.
      fs.linkSync(temporary, file);
      linked = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (linked && process.platform !== "win32") {
      const directory = fs.openSync(dir, "r");
      try {
        fs.fsyncSync(directory);
      } finally {
        fs.closeSync(directory);
      }
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  if (!linked) {
    const winner = loadVcsCommandJournalEntry(entry);
    if (!winner || !isDeepStrictEqual(winner, entry)) {
      throw new Error(`VCS command ${entry.commandId} already has a different durable request`);
    }
  }
}
