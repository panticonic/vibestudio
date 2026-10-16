import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

/** A newer build of a running client the person has not taken yet. */
export interface PendingClientUpdateRecord {
  clientId: string;
  source: string;
  buildKey: string;
  previousBuildKey: string | null;
  effectiveVersion: string | null;
  previousEffectiveVersion: string | null;
}

interface Persisted {
  pending: PendingClientUpdateRecord[];
  /** Clients in development mode on this device (adopt rebuilds immediately). */
  development: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPending(value: unknown): value is PendingClientUpdateRecord {
  return (
    isRecord(value) &&
    typeof value["clientId"] === "string" &&
    typeof value["source"] === "string" &&
    typeof value["buildKey"] === "string" &&
    (value["previousBuildKey"] === null || typeof value["previousBuildKey"] === "string") &&
    (value["effectiveVersion"] === null || typeof value["effectiveVersion"] === "string") &&
    (value["previousEffectiveVersion"] === null ||
      typeof value["previousEffectiveVersion"] === "string")
  );
}

/**
 * Host-side, per-device client state that outlives a restart: updates offered
 * but not yet taken, and which clients are in development mode. Development
 * mode is deliberately not a manifest field: a published client cannot opt
 * itself into unprompted reloads.
 */
export class ClientHostState {
  private state: Persisted = { pending: [], development: [] };

  constructor(private readonly file: string) {
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) throw new Error(`Client host state is malformed: ${file}`);
    this.state = {
      pending: Array.isArray(parsed["pending"]) ? parsed["pending"].filter(isPending) : [],
      development: Array.isArray(parsed["development"])
        ? parsed["development"].filter((id): id is string => typeof id === "string")
        : [],
    };
  }

  pending(): PendingClientUpdateRecord[] {
    return [...this.state.pending];
  }

  setPending(record: PendingClientUpdateRecord): void {
    this.state.pending = [
      ...this.state.pending.filter((existing) => existing.clientId !== record.clientId),
      record,
    ];
    this.save();
  }

  clearPending(clientId: string): void {
    if (!this.state.pending.some((record) => record.clientId === clientId)) return;
    this.state.pending = this.state.pending.filter((record) => record.clientId !== clientId);
    this.save();
  }

  isDevelopment(clientId: string): boolean {
    return this.state.development.includes(clientId);
  }

  setDevelopment(clientId: string, enabled: boolean): void {
    const without = this.state.development.filter((id) => id !== clientId);
    this.state.development = enabled ? [...without, clientId] : without;
    this.save();
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const scratch = `${this.file}.${randomUUID()}.tmp`;
    fs.writeFileSync(scratch, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(scratch, this.file);
  }
}
