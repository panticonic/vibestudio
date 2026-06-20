export interface ScopeEntry {
  id: string;
  channelId: string;
  panelId: string;
  data: string;
  serializedKeys: string[];
  droppedPaths: Array<{ path: string; reason: string }>;
  partialKeys: string[];
  /** Content digests of values spilled to the blob store (for GC of orphaned blobs). */
  blobRefs?: string[];
  createdAt: number;
}

export interface ScopeListEntry {
  id: string;
  createdAt: number;
  keys: string[];
  partial: string[];
}

export interface ScopePersistence {
  upsert(entry: ScopeEntry): Promise<void>;
  loadCurrent(channelId: string, panelId: string): Promise<ScopeEntry | null>;
  get(id: string): Promise<ScopeEntry | null>;
  list(channelId: string): Promise<ScopeListEntry[]>;
  /**
   * Content-addressed blob store for spilled (too-large-to-inline) scope values. Optional: a
   * persistence without these falls back to dropping oversized values.
   *  - `putBlob(json)` → content digest (chunk-stored so no single value exceeds the SQLite limit).
   *  - `getBlob(digest)` → the stored JSON, or null if absent.
   *  - `sweepBlobs()` → drop blobs not referenced by any live scope row (GC).
   */
  putBlob?(valueJson: string): Promise<string>;
  getBlob?(digest: string): Promise<string | null>;
  sweepBlobs?(): Promise<void>;
}
