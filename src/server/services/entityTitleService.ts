/**
 * Server-controlled display titles for runtime entities (panels, workers, DOs).
 *
 * Titles are product facts owned by Base's workspace-presentation service.
 * This module keeps only the synchronous in-process projection required while
 * rendering host approval facts, and writes through the single product owner.
 *
 * Population:
 * - Panels: `workspace-state.panel.index` and `panel.updateTitle` route
 *   through the WorkspaceDO, which writes both `entities.display_title`
 *   (canonical) and `panel_search_metadata.searchable_title` (FTS
 *   denormalization) in one transaction. The service is notified via
 *   `mirrorCachedTitle` so the cache stays consistent with the DO.
 * - Workers / DOs: the runtime service exposes `runtime.setTitle(title)`
 *   which calls `setTitle` here. We dispatch the write to the DO and
 *   update the cache eagerly.
 */

import { normalizePanelTitle } from "@vibestudio/shared/panel/title";

export type EntityTitleChangeOrigin = "set" | "set-explicit" | "mirror" | "clear";

export interface EntityTitleService {
  /** Authoritative write: dispatches to WorkspaceDO and refreshes the cache. */
  setTitle(
    entityId: string,
    title: string | undefined | null,
    options?: { explicit?: boolean }
  ): Promise<void>;
  /** Synchronous read against the in-memory cache. */
  getTitle(entityId: string): string | undefined;
  /** Whether the current title was set explicitly by the owning runtime. */
  isExplicit(entityId: string): boolean;
  /**
   * Local cache refresh for writes that already landed in the DO via another
   * path (e.g. `workspace-state.panel.updateTitle`). Does NOT re-dispatch.
   */
  mirrorCachedTitle(
    entityId: string,
    title: string | undefined | null,
    options?: { explicit?: boolean }
  ): void;
  /** Subscribe to cache changes (used to refresh in-flight approvals). */
  onChanged(
    listener: (entityId: string, title: string | undefined, origin: EntityTitleChangeOrigin) => void
  ): () => void;
  /** Subscribe to title changes after their durable WorkspaceDO write lands. */
  onPersisted(
    listener: (entityId: string, title: string | undefined, origin: EntityTitleChangeOrigin) => void
  ): () => void;
  /** Drop a title — called when an entity retires. Writes through to the DO. */
  clear(entityId: string): Promise<void>;
  /**
   * Hydrate the cache from the WorkspaceDO. Idempotent; safe to call at
   * boot and after a workspace switch.
   */
  hydrate(): Promise<void>;
}

export interface EntityTitleServiceOptions {
  getPresentationDispatch: () =>
    | ((method: string, args: unknown[]) => Promise<unknown>)
    | null
    | undefined;
}

export function createEntityTitleService(options: EntityTitleServiceOptions): EntityTitleService {
  const { getPresentationDispatch } = options;
  const titles = new Map<string, string>();
  const listeners = new Set<
    (entityId: string, title: string | undefined, origin: EntityTitleChangeOrigin) => void
  >();
  const persistedListeners = new Set<
    (entityId: string, title: string | undefined, origin: EntityTitleChangeOrigin) => void
  >();
  const explicitTitles = new Set<string>();

  function notify(
    entityId: string,
    title: string | undefined,
    origin: EntityTitleChangeOrigin
  ): void {
    for (const listener of listeners) {
      try {
        listener(entityId, title, origin);
      } catch (error) {
        console.warn("[entityTitleService] listener failed:", error);
      }
    }
  }

  function notifyPersisted(
    entityId: string,
    title: string | undefined,
    origin: EntityTitleChangeOrigin
  ): void {
    for (const listener of persistedListeners) {
      try {
        listener(entityId, title, origin);
      } catch (error) {
        console.warn("[entityTitleService] persisted listener failed:", error);
      }
    }
  }

  function applyToCache(
    entityId: string,
    title: string | undefined,
    origin: EntityTitleChangeOrigin
  ): boolean {
    const prev = titles.get(entityId);
    if (title === prev) return false;
    if (title === undefined) {
      titles.delete(entityId);
    } else {
      titles.set(entityId, title);
    }
    notify(entityId, title, origin);
    return true;
  }

  async function writeThrough(entityId: string, title: string | null): Promise<boolean> {
    const dispatch = getPresentationDispatch();
    if (!dispatch) {
      // Bootstrap hasn't wired the workspace dispatcher yet. The cache is
      // still updated by the caller, so an early-boot setter just delays
      // persistence — a subsequent setter for the same entity will land in
      // the DO once dispatch is online.
      return false;
    }
    try {
      await dispatch("setEntityTitle", [entityId, title]);
      return true;
    } catch (error) {
      console.warn("[entityTitleService] DO write failed:", error);
      return false;
    }
  }

  return {
    async setTitle(entityId, title, options) {
      const next = normalizePanelTitle(title);
      const origin = options?.explicit ? "set-explicit" : "set";
      if (options?.explicit) {
        if (next === undefined) explicitTitles.delete(entityId);
        else explicitTitles.add(entityId);
      } else if (explicitTitles.has(entityId)) {
        return;
      }
      applyToCache(entityId, next, origin);
      if (await writeThrough(entityId, next ?? null)) {
        notifyPersisted(entityId, next, origin);
      }
    },

    getTitle(entityId) {
      return titles.get(entityId);
    },

    isExplicit(entityId) {
      return explicitTitles.has(entityId);
    },

    mirrorCachedTitle(entityId, title, options) {
      const next = normalizePanelTitle(title);
      const origin = options?.explicit ? "set-explicit" : "mirror";
      if (options?.explicit) {
        if (next === undefined) explicitTitles.delete(entityId);
        else explicitTitles.add(entityId);
      } else if (explicitTitles.has(entityId)) {
        return;
      }
      const changed = applyToCache(entityId, next, origin);
      // This path is called only after another caller has already committed
      // the same value to the WorkspaceDO.
      if (changed) notifyPersisted(entityId, next, origin);
    },

    onChanged(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    onPersisted(listener) {
      persistedListeners.add(listener);
      return () => persistedListeners.delete(listener);
    },

    async clear(entityId) {
      explicitTitles.delete(entityId);
      if (titles.delete(entityId)) {
        notify(entityId, undefined, "clear");
      }
      if (await writeThrough(entityId, null)) {
        notifyPersisted(entityId, undefined, "clear");
      }
    },

    async hydrate() {
      const dispatch = getPresentationDispatch();
      if (!dispatch) return;
      try {
        const rows = (await dispatch("listEntityTitles", [])) as
          | Array<{ id: string; title: string }>
          | undefined;
        if (!Array.isArray(rows)) return;
        for (const row of rows) {
          if (
            row &&
            typeof row.id === "string" &&
            typeof row.title === "string" &&
            row.title.length > 0
          ) {
            // Don't notify on hydrate — listeners haven't been wired yet
            // when this runs at boot, and even if they were, this isn't a
            // semantic change. Just seed the cache.
            titles.set(row.id, row.title);
          }
        }
      } catch (error) {
        console.warn("[entityTitleService] hydrate failed:", error);
      }
    },
  };
}
