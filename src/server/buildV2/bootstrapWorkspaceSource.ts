import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { buildWorktreeManifest } from "@vibestudio/content-addressing";
import type { ProtectedPublicationEvent } from "@vibestudio/shared/protectedPublicationEvents";

import type { BuildSourceProvider } from "./buildSource.js";
import { discoverPackageGraph } from "./packageGraph.js";
import type { BuildRecord, WorkspaceStateSource } from "./stateTrigger.js";

/**
 * The immutable identity captured before semantic workspace initialization.
 *
 * The source directory may subsequently be used as the live semantic
 * workspace projection (notably by source-coupled development instances), so
 * callers must retain this value instead of asking the source to rediscover
 * its current state.
 */
export interface BootstrapWorkspaceSnapshot {
  readonly stateHash: string;
  /** Re-check the snapshot only while the bootstrap phase is still active. */
  assertUnchanged(): Promise<void>;
}

/**
 * Read-only source view used only to break the workspace-source-provider
 * bootstrap fixed point. The directory must already be the atomically
 * materialized exact root snapshot; this class neither fetches nor interprets
 * template state.
 */
export class BootstrapWorkspaceSource implements WorkspaceStateSource, BuildSourceProvider {
  private snapshot:
    | {
        stateHash: string;
        subtreeHash(path: string): string | null;
      }
    | undefined;
  private publicSnapshot: BootstrapWorkspaceSnapshot | undefined;
  private sealFlight: Promise<BootstrapWorkspaceSnapshot> | undefined;

  constructor(
    readonly workspaceId: string,
    private readonly sourceRoot: string
  ) {}

  /** Capture the exact source identity once for the bootstrap lifecycle. */
  async seal(): Promise<BootstrapWorkspaceSnapshot> {
    if (this.publicSnapshot) return this.publicSnapshot;
    if (this.sealFlight) return this.sealFlight;

    this.sealFlight = (async () => {
      const snapshot = await this.readSnapshot();
      this.snapshot = snapshot;
      const publicSnapshot: BootstrapWorkspaceSnapshot = Object.freeze({
        stateHash: snapshot.stateHash,
        assertUnchanged: async () => {
          const observed = await this.readSnapshot();
          if (observed.stateHash !== snapshot.stateHash) {
            throw new Error(
              "Bootstrap workspace source changed while its provider was being built"
            );
          }
        },
      });
      this.publicSnapshot = publicSnapshot;
      return publicSnapshot;
    })().finally(() => {
      this.sealFlight = undefined;
    });
    return this.sealFlight;
  }

  async ensureFresh(): Promise<{ stateHash: string }> {
    const snapshot = await this.seal();
    const observed = await this.readSnapshot();
    if (observed.stateHash !== snapshot.stateHash) {
      throw new Error(
        "Bootstrap workspace source changed after it was sealed; restart from the exact root snapshot"
      );
    }
    return { stateHash: snapshot.stateHash };
  }

  async unitHashes(stateHash: string, relPaths: string[]): Promise<Record<string, string | null>> {
    const snapshot = await this.requireSnapshot(stateHash);
    return Object.fromEntries(
      relPaths.map((relativePath) => [
        relativePath,
        snapshot.subtreeHash(normalizeRelativePath(relativePath)),
      ])
    );
  }

  async resolveContextState(_contextId: string): Promise<string> {
    throw new Error("Bootstrap workspace source has no semantic contexts");
  }

  executionStateForContent(stateHash: string) {
    if (!this.snapshot || this.snapshot.stateHash !== stateHash) return null;
    return {
      kind: "bootstrap-snapshot" as const,
      snapshotHash: stateHash,
    };
  }

  async discoverGraph(stateHash: string) {
    await this.requireSnapshot(stateHash);
    return discoverPackageGraph(this.sourceRoot);
  }

  onProtectedPublication(_cb: (event: ProtectedPublicationEvent) => void): () => void {
    return () => {};
  }

  async recordBuild(_record: BuildRecord): Promise<void> {
    // Bootstrap provenance is joined to the semantic initialization receipt;
    // it is never written into a second build-history channel.
  }

  async materializeForBuild(
    _units: Parameters<BuildSourceProvider["materializeForBuild"]>[0],
    stateRef: string
  ): Promise<{ sourceRoot: string }> {
    await this.requireSnapshot(stateRef);
    return { sourceRoot: this.sourceRoot };
  }

  private async requireSnapshot(stateHash: string) {
    if (!this.snapshot) await this.seal();
    if (!this.snapshot || this.snapshot.stateHash !== stateHash) {
      throw new Error(`Unknown bootstrap workspace state ${stateHash}`);
    }
    return this.snapshot;
  }

  private async readSnapshot() {
    const files: Array<{ path: string; contentHash: string; mode: number }> = [];
    const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const relativePath = normalizeRelativePath(
          relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
        );
        const absolutePath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(absolutePath, relativePath);
          continue;
        }
        if (!entry.isFile()) {
          throw new Error(
            `Bootstrap workspace snapshot contains unsupported entry ${relativePath}`
          );
        }
        const [content, stat] = await Promise.all([
          fs.readFile(absolutePath),
          fs.stat(absolutePath),
        ]);
        files.push({
          path: relativePath,
          contentHash: createHash("sha256").update(content).digest("hex"),
          mode: stat.mode & 0o111 ? 0o100755 : 0o100644,
        });
      }
    };
    await visit(this.sourceRoot, "");
    return buildWorktreeManifest(files);
  }
}

function normalizeRelativePath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\/+/u, "");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`Invalid bootstrap workspace path ${JSON.stringify(value)}`);
  }
  return normalized;
}
