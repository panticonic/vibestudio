import { readFileSync } from "fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import * as path from "path";
import { createDevLogger } from "@vibestudio/dev-log";

const log = createDevLogger("PanelLayoutStore");

interface PanelLayoutStoreFile {
  version: 1;
  layout: unknown;
}

/** Structural surface the panel service depends on (so tests can substitute). */
export interface PanelLayoutStoreApi {
  /** The persisted layout blob for a workspace+account, or null if absent/corrupt. */
  get(workspaceId: string, accountUserId: string): unknown | null;
  /** Persist the layout blob opaquely; validation happens shell-side. */
  set(workspaceId: string, accountUserId: string, layout: unknown): void;
}

/**
 * Client-local, per-device panel layout store for the desktop shell (§3.3 of
 * the multi-column layout plan).
 *
 * Layouts are stored as one JSON file per (workspace, signed-in account) under
 * the same `userData`-derived directory the pin store uses:
 * `panel-layout.<workspaceId>.<accountUserId>.json`. The blob is **opaque** to
 * the main process — the shell owns the schema and validates on restore — so a
 * corrupt or stale file simply reads back as null and must never block startup.
 * Never synced; never written to the workspace DO (design decision D6).
 */
export class PanelLayoutStore implements PanelLayoutStoreApi {
  private readonly pendingWrites = new Map<string, string>();
  private readonly writeDrains = new Map<string, Promise<void>>();

  constructor(private readonly dir: string) {}

  private filePath(workspaceId: string, accountUserId: string): string {
    // Ids come from trusted server state but may contain path-hostile
    // characters; encode so the key can never escape the store directory.
    const key = `${encodeURIComponent(workspaceId)}.${encodeURIComponent(accountUserId)}`;
    return path.join(this.dir, `panel-layout.${key}.json`);
  }

  get(workspaceId: string, accountUserId: string): unknown | null {
    const filePath = this.filePath(workspaceId, accountUserId);
    try {
      const raw = readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PanelLayoutStoreFile>;
      if (parsed && typeof parsed === "object" && "layout" in parsed) {
        return parsed.layout ?? null;
      }
      return null;
    } catch (error) {
      // ENOENT on first run is expected; anything else is logged but tolerated
      // (a corrupt layout file must never block startup).
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") {
        log.warn(
          `Failed to read layout store at ${filePath}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
      return null;
    }
  }

  set(workspaceId: string, accountUserId: string, layout: unknown): void {
    const filePath = this.filePath(workspaceId, accountUserId);
    const payload: PanelLayoutStoreFile = { version: 1, layout };
    this.pendingWrites.set(filePath, JSON.stringify(payload));
    this.ensureWriteDrain(filePath);
  }

  /** Resolve after every layout accepted so far is durably written. */
  async flush(): Promise<void> {
    await Promise.all(this.writeDrains.values());
  }

  private ensureWriteDrain(filePath: string): void {
    if (this.writeDrains.has(filePath)) return;
    const drain = this.drainWrites(filePath).finally(() => {
      this.writeDrains.delete(filePath);
      if (this.pendingWrites.has(filePath)) this.ensureWriteDrain(filePath);
    });
    this.writeDrains.set(filePath, drain);
  }

  private async drainWrites(filePath: string): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true });
    } catch (error) {
      log.warn(
        `Failed to create layout store directory ${this.dir}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      this.pendingWrites.delete(filePath);
      return;
    }
    while (this.pendingWrites.has(filePath)) {
      const payload = this.pendingWrites.get(filePath)!;
      this.pendingWrites.delete(filePath);
      const temporaryPath = `${filePath}.tmp`;
      try {
        await writeFile(temporaryPath, payload, "utf8");
        await rename(temporaryPath, filePath);
      } catch (error) {
        log.warn(
          `Failed to write layout store at ${filePath}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
  }
}
