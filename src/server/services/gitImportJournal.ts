import * as fs from "node:fs";
import * as path from "node:path";
import type {
  WorkspaceGitRemoteConfig,
  WorkspaceGitUpstreamConfig,
} from "@vibestudio/workspace-contracts/types";
import { writeJsonFileAtomic } from "../hostCore/atomicFile.js";

export type GitImportPhase =
  | "requested"
  | "preparing"
  | "prepared"
  | "configuring"
  | "committing"
  | "commit-outcome-unknown"
  | "committed"
  | "adopting"
  | "complete"
  | "aborted"
  | "committed-incomplete"
  | "requires-repair";

export interface GitImportJournalRecord {
  version: 1;
  operationId: string;
  phase: GitImportPhase;
  callerKey: string;
  repoPath: string;
  remote: WorkspaceGitRemoteConfig & { branch: string };
  credentialId?: string;
  requestedAt: number;
  updatedAt: number;
  prepared?: {
    gitCommitSha: string;
    stateHash: string;
    changed: boolean;
  };
  config?: {
    priorRemote: WorkspaceGitRemoteConfig | null;
    priorUpstream: WorkspaceGitUpstreamConfig | null;
    writtenRemote: WorkspaceGitRemoteConfig & { branch: string };
    writtenUpstream: WorkspaceGitUpstreamConfig & { branch: string };
  };
  adoptedContextId?: string | null;
  finalizationError?: string;
  compensationError?: string;
}

interface GitImportJournalFile {
  version: 1;
  operations: GitImportJournalRecord[];
}

const ACTIVE_PHASES = new Set<GitImportPhase>([
  "requested",
  "preparing",
  "prepared",
  "configuring",
  "committing",
  "commit-outcome-unknown",
  "committed",
  "adopting",
  "committed-incomplete",
  "requires-repair",
]);

/** Durable host-side coordinator state. The provider has its own mechanical
 * journal; this one owns policy/config/adoption and never stores scratch paths. */
export class GitImportJournal {
  private state: GitImportJournalFile = { version: 1, operations: [] };

  constructor(private readonly filePath: string) {
    this.load();
  }

  get(operationId: string): GitImportJournalRecord | null {
    const found = this.state.operations.find((entry) => entry.operationId === operationId);
    return found ? structuredClone(found) : null;
  }

  activeForRepo(repoPath: string): GitImportJournalRecord | null {
    const found = this.state.operations.find(
      (entry) => entry.repoPath === repoPath && ACTIVE_PHASES.has(entry.phase)
    );
    return found ? structuredClone(found) : null;
  }

  listIncomplete(): GitImportJournalRecord[] {
    return this.state.operations
      .filter((entry) => ACTIVE_PHASES.has(entry.phase))
      .map((entry) => structuredClone(entry));
  }

  put(record: GitImportJournalRecord): void {
    assertRecord(record);
    const index = this.state.operations.findIndex(
      (entry) => entry.operationId === record.operationId
    );
    if (index === -1) this.state.operations.push(structuredClone(record));
    else this.state.operations[index] = structuredClone(record);
    this.state.operations.sort((a, b) => a.requestedAt - b.requestedAt);
    this.save();
  }

  private load(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as unknown;
      if (!isJournalFile(parsed)) throw new Error("expected exact Git import journal schema v1");
      this.state = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error(
        `Git import journal is incompatible or corrupt at ${this.filePath}: ${
          error instanceof Error ? error.message : String(error)
        }. Run the scoped runtime-foundations reset before starting the host.`
      );
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    writeJsonFileAtomic(this.filePath, this.state);
    fs.chmodSync(this.filePath, 0o600);
  }
}

function isJournalFile(value: unknown): value is GitImportJournalFile {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 2 &&
    (value as { version?: unknown }).version === 1 &&
    Array.isArray((value as { operations?: unknown }).operations) &&
    (value as { operations: unknown[] }).operations.every((entry) => {
      try {
        assertRecord(entry);
        return true;
      } catch {
        return false;
      }
    })
  );
}

function assertRecord(value: unknown): asserts value is GitImportJournalRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid Git import journal record");
  }
  const record = value as Partial<GitImportJournalRecord>;
  if (
    record.version !== 1 ||
    typeof record.operationId !== "string" ||
    typeof record.repoPath !== "string" ||
    typeof record.callerKey !== "string" ||
    typeof record.requestedAt !== "number" ||
    typeof record.updatedAt !== "number" ||
    !record.remote ||
    typeof record.remote.branch !== "string" ||
    (!ACTIVE_PHASES.has(record.phase as GitImportPhase) &&
      record.phase !== "complete" &&
      record.phase !== "aborted")
  ) {
    throw new Error("invalid Git import journal record");
  }
}
