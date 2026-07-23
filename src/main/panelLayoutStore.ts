import { readFileSync, writeFileSync, mkdirSync } from "fs";
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
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(filePath, JSON.stringify(payload), "utf8");
    } catch (error) {
      log.warn(
        `Failed to write layout store at ${filePath}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
}
