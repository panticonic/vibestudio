/** A workspace member projected from live human connections. */
export interface WorkspacePresenceEntry {
  userId: string;
  handle: string;
  displayName: string;
  color?: string;
  online: boolean;
  lastSeen: number;
  endpoints?: number;
}
