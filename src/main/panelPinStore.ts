import { readFileSync } from "fs";
import { rename, writeFile } from "node:fs/promises";
import { createDevLogger } from "@vibestudio/dev-log";

const log = createDevLogger("PanelPinStore");

interface PanelPinStoreFile {
  version: 1;
  pinnedPanelIds: string[];
}

/** Structural surface the orchestrator depends on (so tests can substitute). */
export interface PanelPinStoreApi {
  has(slotId: string): boolean;
  /** Toggle the pin; returns the new pinned state and persists. */
  toggle(slotId: string): boolean;
  list(): string[];
  /** Drop ids not in the tree; persist if changed. */
  prune(existingSlotIds: Iterable<string>): void;
}

/**
 * Client-local, workspace-scoped pin store for the desktop shell.
 *
 * Pins are keyed by **slot id** (`panel:tree/…`) — never an entity id — and
 * persist across sessions in a tiny JSON file under the workspace-scoped
 * `userData` directory. This is the desktop source of truth the orchestrator's
 * GC consults; the renderer mirrors it into a jotai atom for the 📌 indicator.
 *
 * Loaded synchronously in the constructor so pins exist before the first sweep
 * tick or lease assignment.
 */
export class PanelPinStore implements PanelPinStoreApi {
  private readonly pinned = new Set<string>();
  private pendingPayload: string | null = null;
  private writeDrain: Promise<void> | null = null;

  constructor(private readonly filePath: string) {
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PanelPinStoreFile>;
      if (Array.isArray(parsed.pinnedPanelIds)) {
        for (const id of parsed.pinnedPanelIds) {
          if (typeof id === "string") this.pinned.add(id);
        }
      }
    } catch (error) {
      // ENOENT on first run is expected; anything else is logged but tolerated
      // (a corrupt pin file must never block startup).
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") {
        log.warn(
          `Failed to read pin store at ${this.filePath}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
  }

  has(slotId: string): boolean {
    return this.pinned.has(slotId);
  }

  /** Toggle the pin for a slot id; persists and returns the new pinned state. */
  toggle(slotId: string): boolean {
    let nowPinned: boolean;
    if (this.pinned.has(slotId)) {
      this.pinned.delete(slotId);
      nowPinned = false;
    } else {
      this.pinned.add(slotId);
      nowPinned = true;
    }
    this.persist();
    return nowPinned;
  }

  list(): string[] {
    return [...this.pinned];
  }

  /** Drop pinned ids no longer present in the tree; persist only if changed. */
  prune(existingSlotIds: Iterable<string>): void {
    const existing = new Set(existingSlotIds);
    let changed = false;
    for (const id of this.pinned) {
      if (!existing.has(id)) {
        this.pinned.delete(id);
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  private persist(): void {
    const payload: PanelPinStoreFile = { version: 1, pinnedPanelIds: [...this.pinned] };
    this.pendingPayload = JSON.stringify(payload);
    if (this.writeDrain) return;
    this.writeDrain = this.drainWrites().finally(() => {
      this.writeDrain = null;
      if (this.pendingPayload !== null) this.persist();
    });
  }

  /** Resolve after every pin mutation accepted so far is durably written. */
  async flush(): Promise<void> {
    await this.writeDrain;
  }

  private async drainWrites(): Promise<void> {
    while (this.pendingPayload !== null) {
      const payload = this.pendingPayload;
      this.pendingPayload = null;
      const temporaryPath = `${this.filePath}.tmp`;
      try {
        await writeFile(temporaryPath, payload, "utf8");
        await rename(temporaryPath, this.filePath);
      } catch (error) {
        log.warn(
          `Failed to write pin store at ${this.filePath}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
  }
}
