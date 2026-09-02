import { normalizePanelTitle } from "@vibestudio/shared/panel/title";

export interface EntityTitleProjection {
  get(entityId: string): string | undefined;
  observe(entityId: string, title: string | null | undefined): void;
  remove(entityId: string): void;
  hydrate(load: () => Promise<readonly { id: string; title: string }[]>): Promise<void>;
}

/**
 * Synchronous, read-only projection of Base-owned entity presentation.
 *
 * Approval construction is synchronous because it snapshots the requester at
 * the instant a protected operation is queued. Base remains the only durable
 * owner and writer; this projection merely keeps that security snapshot
 * human-identifiable without moving presentation ownership back into the host.
 */
export function createEntityTitleProjection(): EntityTitleProjection {
  const titles = new Map<string, string>();
  const observe = (entityId: string, title: string | null | undefined): void => {
    const normalized = normalizePanelTitle(title);
    if (normalized === undefined) titles.delete(entityId);
    else titles.set(entityId, normalized);
  };

  return {
    get: (entityId) => titles.get(entityId),
    observe,
    remove: (entityId) => {
      titles.delete(entityId);
    },
    async hydrate(load) {
      const rows = await load();
      for (const row of rows) observe(row.id, row.title);
    },
  };
}
