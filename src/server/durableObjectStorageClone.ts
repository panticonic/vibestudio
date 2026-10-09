import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import * as path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { canonicalJson } from "@vibestudio/shared/canonicalJson";
import {
  canonicalEntityId,
  IdentityCollisionError,
  type EntityRecord,
} from "@vibestudio/shared/runtime/entitySpec";
import type { DORef } from "@vibestudio/shared/doDispatcher";
import { serializeByKey } from "@vibestudio/shared/keyedSerializer";

interface StagedFile {
  name: string;
  digest: string;
  size: number;
}
interface CloneRow {
  identity: string;
  phase: "snapshot" | "staged" | "complete";
  manifest: string | null;
}

async function digestFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function syncFile(file: string): Promise<void> {
  const handle = await fs.open(file, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(dir: string): Promise<void> {
  // Node cannot open directory handles on Windows; individual files are still flushed.
  if (process.platform === "win32") return;
  const handle = await fs.open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** One private storage-copy owner. Receiver admission stays closed until its receipt commits. */
export class DurableObjectStorageClone {
  private readonly owners = new Map<string, Promise<unknown>>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly stagingRoot: string
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS do_storage_clones (
      target_id TEXT PRIMARY KEY, identity TEXT NOT NULL,
      phase TEXT NOT NULL CHECK(phase IN ('snapshot', 'staged', 'complete')),
      manifest TEXT
    )`);
  }

  async copy(input: {
    source: DORef;
    reservation: EntityRecord;
    storageDir: string;
    targetHash: string;
    snapshot(stage: string): Promise<void>;
  }): Promise<void> {
    const { reservation, source } = input;
    const expected = canonicalEntityId({
      kind: "do",
      source: source.source,
      className: source.className,
      key: reservation.key,
    });
    if (
      reservation.id !== expected ||
      reservation.kind !== "do" ||
      reservation.status !== "preparing" ||
      !reservation.authoritySessionId ||
      !reservation.cloneProvenance ||
      reservation.cloneProvenance.storage !== "snapshot" ||
      reservation.source.repoPath !== source.source ||
      reservation.className !== source.className ||
      reservation.cloneProvenance.sourceEntityId !==
        canonicalEntityId({
          kind: "do",
          source: source.source,
          className: source.className,
          key: source.objectKey,
        }) ||
      reservation.key === source.objectKey
    ) {
      throw new Error(`Storage clone has no exact reserved owner for ${expected}`);
    }
    const identity = canonicalJson({
      source,
      targetId: expected,
      authoritySessionId: reservation.authoritySessionId,
      contextId: reservation.contextId,
      cloneProvenance: reservation.cloneProvenance,
    });
    await serializeByKey(this.owners, expected, async () => {
      let row = this.read(expected);
      if (row && row.identity !== identity)
        throw new IdentityCollisionError(expected, {
          field: "storageCloneOwner",
          existing: JSON.parse(row.identity),
          attempted: JSON.parse(identity),
        });
      const stage = this.stage(identity);
      if (!row) {
        const existing = await fs.readdir(input.storageDir);
        if (existing.some((file) => file.startsWith(`${input.targetHash}.`))) {
          throw new Error(
            `Storage clone ${expected} has target files without an owned completion receipt`
          );
        }
        this.db
          .prepare(
            `INSERT INTO do_storage_clones (target_id, identity, phase) VALUES (?, ?, 'snapshot')`
          )
          .run(expected, identity);
        row = this.read(expected)!;
      }
      if (row.phase === "complete") {
        // Initializers and receivers may legitimately change these bytes after copying.
        await fs.rm(stage, { recursive: true, force: true });
        return;
      }
      if (row.phase === "snapshot") {
        await fs.rm(stage, { recursive: true, force: true });
        await fs.mkdir(stage, { recursive: true, mode: 0o700 });
        await input.snapshot(stage);
        const files = await fs.readdir(stage);
        if (!files.some((file) => file.endsWith(".sqlite")) || !files.includes(".facets")) {
          throw new Error(`Storage clone ${expected} produced an incomplete facet snapshot`);
        }
        const manifest: StagedFile[] = [];
        for (const name of files.sort()) {
          if (!name.startsWith(".") || name.includes("/") || name.includes("\\")) {
            throw new Error(`Storage clone ${expected} produced an invalid staged filename`);
          }
          const file = path.join(stage, name);
          await syncFile(file);
          manifest.push({ name, digest: await digestFile(file), size: (await fs.stat(file)).size });
        }
        await syncDirectory(stage);
        await syncDirectory(path.dirname(stage));
        this.db
          .prepare(
            `UPDATE do_storage_clones SET phase = 'staged', manifest = ? WHERE target_id = ?`
          )
          .run(canonicalJson(manifest), expected);
        row = this.read(expected)!;
      }
      const manifest = JSON.parse(row.manifest!) as StagedFile[];
      for (const file of manifest) {
        const staged = path.join(stage, file.name);
        if (
          (await fs.stat(staged)).size !== file.size ||
          (await digestFile(staged)) !== file.digest
        ) {
          throw new Error(`Storage clone ${expected} lost its immutable staged snapshot`);
        }
      }
      // A crash during publication resumes from the same retained snapshot. No
      // receiver can observe the partial files while its incarnation is preparing.
      for (const file of manifest.sort(
        (a, b) => Number(a.name === ".facets") - Number(b.name === ".facets")
      )) {
        const target = path.join(input.storageDir, `${input.targetHash}${file.name}`);
        await fs.copyFile(path.join(stage, file.name), target);
        await syncFile(target);
      }
      await syncDirectory(input.storageDir);
      this.db
        .prepare(`UPDATE do_storage_clones SET phase = 'complete' WHERE target_id = ?`)
        .run(expected);
      await fs.rm(stage, { recursive: true, force: true });
    });
  }

  requireComplete(reservation: EntityRecord): void {
    if (reservation.cloneProvenance?.storage === "fresh") return;
    const row = this.read(reservation.id);
    const identity = row
      ? (JSON.parse(row.identity) as {
          authoritySessionId: string;
          contextId: string;
          cloneProvenance: EntityRecord["cloneProvenance"];
        })
      : null;
    if (
      !row ||
      row.phase !== "complete" ||
      !identity ||
      identity.authoritySessionId !== reservation.authoritySessionId ||
      identity.contextId !== reservation.contextId ||
      canonicalJson(identity.cloneProvenance) !== canonicalJson(reservation.cloneProvenance)
    ) {
      throw new Error(
        `Storage copy completion does not match reserved incarnation ${reservation.id} (${reservation.authoritySessionId})`
      );
    }
  }

  /** Retirement joins the current copy before deleting only its retained stage. */
  async retire(targetId: string): Promise<void> {
    await serializeByKey(this.owners, targetId, async () => {
      const row = this.read(targetId);
      if (!row) return;
      await fs.rm(this.stage(row.identity), { recursive: true, force: true });
      this.db.prepare(`DELETE FROM do_storage_clones WHERE target_id = ?`).run(targetId);
    });
  }

  async join(): Promise<void> {
    await Promise.all([...this.owners.values()]);
  }

  private read(id: string): CloneRow | null {
    return (
      (this.db
        .prepare(`SELECT identity, phase, manifest FROM do_storage_clones WHERE target_id = ?`)
        .get(id) as unknown as CloneRow | null) ?? null
    );
  }

  private stage(identity: string): string {
    return path.join(this.stagingRoot, createHash("sha256").update(identity).digest("hex"));
  }
}
