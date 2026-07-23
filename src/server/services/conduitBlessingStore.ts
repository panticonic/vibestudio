import * as fs from "node:fs";
import * as path from "node:path";
import { writeFileAtomicSync } from "../../atomicFile.js";
import { stateLayout } from "../stateLayout.js";

export interface ConduitIdentity {
  repoPath: string;
  effectiveVersion: string;
  executionDigest?: string;
}

interface ConduitBlessing {
  repoPath: string;
  effectiveVersion: string;
}

interface ConduitBlessingFile {
  schemaVersion: 1;
  productSnapshotState: string;
  blessings: ConduitBlessing[];
}

/**
 * Exact first-party conduit roles resolved from a host-shipped product snapshot.
 *
 * This is intentionally separate from capability/unit approval. A user may
 * authorize an edited harness to perform declared actions, but that decision
 * cannot make its self-reported context-integrity attestation trustworthy.
 */
export class ConduitBlessingStore {
  private readonly filePath: string;
  private productSnapshotState: string | null = null;
  private blessings = new Set<string>();

  constructor(opts: { statePath: string }) {
    this.filePath = stateLayout(opts.statePath).authority.conduitBlessingsFile;
    this.load();
  }

  isBlessed(identity: ConduitIdentity | null | undefined): boolean {
    return Boolean(
      identity &&
      /^[0-9a-f]{64}$/u.test(identity.effectiveVersion) &&
      (!identity.executionDigest || /^[0-9a-f]{64}$/u.test(identity.executionDigest)) &&
      this.blessings.has(key(identity))
    );
  }

  hasSeed(): boolean {
    return this.productSnapshotState !== null;
  }

  isSeededFor(productSnapshotState: string): boolean {
    if (!/^state:[0-9a-f]{64}$/u.test(productSnapshotState)) {
      throw new Error("Conduit blessing lookup requires a canonical product snapshot state");
    }
    return this.productSnapshotState === productSnapshotState;
  }

  /**
   * Replace the seed only from the trusted product-snapshot bootstrap path.
   * Callers must never pass identities resolved from mutable protected main.
   */
  seedProductSnapshot(productSnapshotState: string, identities: readonly ConduitIdentity[]): void {
    if (!/^state:[0-9a-f]{64}$/u.test(productSnapshotState)) {
      throw new Error("Conduit blessings require a canonical product snapshot state");
    }
    if (identities.length === 0) {
      throw new Error("Conduit blessing policy resolved no product harnesses");
    }
    const next = new Set<string>();
    for (const identity of identities) {
      if (!identity.repoPath || !/^[0-9a-f]{64}$/u.test(identity.effectiveVersion)) {
        throw new Error(`Invalid product conduit identity for ${identity.repoPath || "<unknown>"}`);
      }
      next.add(key(identity));
    }
    this.productSnapshotState = productSnapshotState;
    this.blessings = next;
    this.save();
  }

  private load(): void {
    let source: string;
    try {
      source = fs.readFileSync(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const parsed = JSON.parse(source) as Partial<ConduitBlessingFile>;
    if (
      parsed.schemaVersion !== 1 ||
      typeof parsed.productSnapshotState !== "string" ||
      !/^state:[0-9a-f]{64}$/u.test(parsed.productSnapshotState) ||
      !Array.isArray(parsed.blessings)
    ) {
      throw new Error(`Unknown conduit-blessing schema in ${this.filePath}`);
    }
    const blessings = new Set<string>();
    for (const blessing of parsed.blessings) {
      if (!isBlessing(blessing)) {
        throw new Error(`Invalid conduit blessing in ${this.filePath}`);
      }
      blessings.add(key(blessing));
    }
    if (blessings.size === 0) {
      throw new Error(`Conduit blessing seed is empty in ${this.filePath}`);
    }
    this.productSnapshotState = parsed.productSnapshotState;
    this.blessings = blessings;
  }

  private save(): void {
    if (!this.productSnapshotState) throw new Error("Cannot persist an unseeded conduit registry");
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const blessings = [...this.blessings]
      .map((value) => {
        const separator = value.indexOf("\0");
        return {
          repoPath: value.slice(0, separator),
          effectiveVersion: value.slice(separator + 1),
        };
      })
      .sort((left, right) => key(left).localeCompare(key(right)));
    writeFileAtomicSync(
      this.filePath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          productSnapshotState: this.productSnapshotState,
          blessings,
        } satisfies ConduitBlessingFile,
        null,
        2
      )}\n`,
      { mode: 0o600 }
    );
  }
}

function key(identity: Pick<ConduitIdentity, "repoPath" | "effectiveVersion">): string {
  return `${identity.repoPath}\0${identity.effectiveVersion}`;
}

function isBlessing(value: unknown): value is ConduitBlessing {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).sort().join(",") === "effectiveVersion,repoPath" &&
    typeof record["repoPath"] === "string" &&
    record["repoPath"].length > 0 &&
    typeof record["effectiveVersion"] === "string" &&
    /^[0-9a-f]{64}$/u.test(record["effectiveVersion"])
  );
}
