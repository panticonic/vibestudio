export interface ScopeEntry {
  id: string;
  channelId: string;
  panelId: string;
  data: string;
  serializedKeys: string[];
  droppedPaths: Array<{ path: string; reason: string }>;
  partialKeys: string[];
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
}
