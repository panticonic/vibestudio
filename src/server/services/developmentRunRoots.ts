import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  ExecutionArtifactRefV1,
  ExecutionPublicationPort,
  ExecutionRoot,
  ExecutionRootProvider,
} from "@vibestudio/shared/execution/retention";
import { verifyExecutionArtifactRef } from "@vibestudio/shared/execution/retention";

export const DEVELOPMENT_RUN_MARKER = ".vibestudio-development-run.json";
const RUN_ID = /^[A-Za-z0-9._-]{1,160}$/u;
type MarkerV1 = { version: 1; runId: string; snapshotDigest: string };
type MarkerV2 = {
  version: 2;
  runId: string;
  snapshotDigest: string;
  artifact: ExecutionArtifactRefV1 | null;
};
type Marker = MarkerV1 | MarkerV2;

/** Durable owner of native development run roots and their exact build references. */
export class DevelopmentRunRoots implements ExecutionRootProvider {
  readonly id = "development-run";
  readonly mandatory = true;
  private operations: Promise<void> = Promise.resolve();

  constructor(
    private readonly deps: {
      root: string;
      workspaceId: string;
      publicationJournal: ExecutionPublicationPort;
      legacyRoots?: (epoch: number) => Promise<readonly ExecutionRoot[]>;
    }
  ) {}

  runRoot(runId: string): string {
    if (runId === "." || runId === ".." || !RUN_ID.test(runId))
      throw Object.assign(new Error("Invalid development run id"), { code: "EINVAL" });
    return path.join(this.deps.root, runId);
  }

  async claim(runId: string, snapshotDigest: string): Promise<void> {
    return this.exclusive(() => this.claimUnlocked(runId, snapshotDigest));
  }

  private async claimUnlocked(runId: string, snapshotDigest: string): Promise<void> {
    await fs.mkdir(this.deps.root, { recursive: true, mode: 0o700 });
    const root = this.runRoot(runId);
    try {
      await this.assertOwnedUnlocked(runId, snapshotDigest);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await fs.mkdir(root, { recursive: false, mode: 0o700 });
    await fs.writeFile(
      path.join(root, DEVELOPMENT_RUN_MARKER),
      `${JSON.stringify({ version: 2, runId, snapshotDigest, artifact: null })}\n`,
      { mode: 0o600, flag: "wx" }
    );
    await this.assertContainedRoot(root);
  }

  async assertOwned(runId: string, snapshotDigest: string): Promise<void> {
    return this.exclusive(() => this.assertOwnedUnlocked(runId, snapshotDigest));
  }

  private async assertOwnedUnlocked(runId: string, snapshotDigest: string): Promise<void> {
    const marker = await this.read(runId);
    if (marker.snapshotDigest !== snapshotDigest) throw this.ownershipError(runId);
    await this.assertContainedRoot(this.runRoot(runId));
  }

  publish(runId: string, snapshotDigest: string, artifact: ExecutionArtifactRefV1): Promise<void> {
    this.verifyArtifact(artifact, snapshotDigest);
    const reservation = this.deps.publicationJournal.reserve({
      owner: "development-run",
      ownerId: runId,
      artifacts: [artifact],
    });
    return this.exclusive(() => this.publishUnlocked(runId, snapshotDigest, artifact, reservation));
  }

  private async publishUnlocked(
    runId: string,
    snapshotDigest: string,
    artifact: ExecutionArtifactRefV1,
    reservation: ReturnType<ExecutionPublicationPort["reserve"]>
  ): Promise<void> {
    await this.assertOwnedUnlocked(runId, snapshotDigest);
    await this.write(runId, { version: 2, runId, snapshotDigest, artifact });
    this.deps.publicationJournal.finalize(reservation);
  }

  async retire(runId: string, snapshotDigest: string): Promise<void> {
    return this.exclusive(() => this.retireUnlocked(runId, snapshotDigest));
  }

  private async retireUnlocked(runId: string, snapshotDigest: string): Promise<void> {
    await this.assertOwnedUnlocked(runId, snapshotDigest);
    await fs.rm(this.runRoot(runId), { recursive: true, force: true });
  }

  async snapshotRoots(epoch: number): Promise<readonly ExecutionRoot[]> {
    return this.exclusive(() => this.snapshotRootsUnlocked(epoch));
  }

  private async snapshotRootsUnlocked(epoch: number): Promise<readonly ExecutionRoot[]> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(this.deps.root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const runIds = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const markers = await Promise.all(
      runIds.map(async (runId) => ({ runId, marker: await this.read(runId) }))
    );
    const legacyMarkers = markers.filter(
      (entry): entry is { runId: string; marker: MarkerV1 } => entry.marker.version === 1
    );
    const migrated = new Map<string, ExecutionArtifactRefV1 | null>();
    if (legacyMarkers.length > 0) {
      if (!this.deps.legacyRoots)
        throw new Error(
          "Legacy development run markers require the development service migration source"
        );
      const legacyRoots = await this.deps.legacyRoots(epoch);
      for (const { runId, marker } of legacyMarkers) {
        const matches = legacyRoots.filter(
          (root) =>
            root.owner === "development-run" &&
            root.ownerId === runId &&
            root.artifact.buildKey === marker.snapshotDigest &&
            root.artifact.sourceState.workspaceId === this.deps.workspaceId
        );
        if (matches.length > 1)
          throw new Error(`Legacy development run ${runId} has ambiguous retained artifacts`);
        const artifact = matches[0]?.artifact ?? null;
        if (artifact) this.verifyArtifact(artifact, marker.snapshotDigest);
        await this.write(runId, {
          version: 2,
          runId,
          snapshotDigest: marker.snapshotDigest,
          artifact,
        });
        migrated.set(runId, artifact);
      }
    }
    return markers.flatMap(({ runId, marker }) => {
      const artifact = marker.version === 2 ? marker.artifact : (migrated.get(runId) ?? null);
      return artifact
        ? [
            {
              owner: "development-run" as const,
              ownerId: runId,
              reason: "active" as const,
              artifact,
            },
          ]
        : [];
    });
  }

  private async read(runId: string): Promise<Marker> {
    const file = path.join(this.runRoot(runId), DEVELOPMENT_RUN_MARKER);
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.readFile(file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
      throw new Error(`Development run ${runId} has an invalid owner marker`, { cause: error });
    }
    if (!raw || typeof raw !== "object") throw this.ownershipError(runId);
    const marker = raw as Record<string, unknown>;
    if (
      (marker["version"] !== 1 && marker["version"] !== 2) ||
      marker["runId"] !== runId ||
      typeof marker["snapshotDigest"] !== "string" ||
      (marker["version"] === 2 && !("artifact" in marker))
    )
      throw this.ownershipError(runId);
    if (marker["version"] === 2) {
      if (marker["artifact"] !== null && typeof marker["artifact"] !== "object")
        throw this.ownershipError(runId);
      if (marker["artifact"])
        this.verifyArtifact(
          marker["artifact"] as ExecutionArtifactRefV1,
          marker["snapshotDigest"] as string
        );
    }
    return marker as Marker;
  }

  private verifyArtifact(artifact: ExecutionArtifactRefV1, snapshotDigest: string): void {
    const verified = verifyExecutionArtifactRef(artifact);
    if (
      verified.sourceState.workspaceId !== this.deps.workspaceId ||
      verified.buildKey !== snapshotDigest
    )
      throw new Error("Development run artifact does not match its workspace and snapshot");
  }

  private async assertContainedRoot(root: string): Promise<void> {
    const [realParent, realRoot] = await Promise.all([
      fs.realpath(this.deps.root),
      fs.realpath(root),
    ]);
    if (path.dirname(realRoot) !== realParent)
      throw Object.assign(new Error(`Development root ${root} escapes its owner directory`), {
        code: "EOWNERSHIP",
      });
  }

  private ownershipError(runId: string): Error {
    return Object.assign(
      new Error(`Development root ${this.runRoot(runId)} has a foreign owner marker`),
      { code: "EOWNERSHIP" }
    );
  }

  private async write(runId: string, marker: MarkerV2): Promise<void> {
    const file = path.join(this.runRoot(runId), DEVELOPMENT_RUN_MARKER);
    const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, `${JSON.stringify(marker)}\n`, { mode: 0o600, flag: "wx" });
      await fs.rename(temp, file);
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operations;
    let release!: () => void;
    this.operations = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
