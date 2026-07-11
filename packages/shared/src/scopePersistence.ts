export interface ScopeEntry {
  id: string;
  channelId: string;
  panelId: string;
  data: string;
  serializedKeys: string[];
  droppedPaths: Array<{ path: string; reason: string }>;
  partialKeys: string[];
  /** Content digests of values spilled to the blob store, used to validate placeholder hydration. */
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
  /** Content-addressed storage for values too large to inline in a scope row. */
  putBlob(valueJson: string): Promise<string>;
  getBlob(digest: string): Promise<string | null>;
  /** Optional lifecycle cleanup for stores that own their blobs. */
  sweepBlobs?(): Promise<void>;
}
