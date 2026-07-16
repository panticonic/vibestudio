export interface DurableObjectCleanupRef {
  source: string;
  className: string;
  key: string;
}

/** Durable proof that teardown of one workspace context is still incomplete. */
export interface ContextCleanupRecord {
  contextId: string;
  /** `destroy` also retires entities and reclaims DO storage; `detach` keeps it. */
  kind: "detach" | "destroy";
  createdAt: number;
  updatedAt: number;
  lastError: string | null;
  /** Extra storage armed before activation (not yet discoverable from entities). */
  durableObjects: DurableObjectCleanupRef[];
}
