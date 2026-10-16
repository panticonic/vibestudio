/** One newer build of a running client, as `app.listPendingUpdates` reports it. */
export interface PendingClientUpdateInfo {
  /** The client id (the supervised unit's entity id). */
  appId: string;
  source: string;
  url: string;
  buildKey: string;
  effectiveVersion: string | null;
  previousBuildKey: string | null;
  previousEffectiveVersion: string | null;
}

/** What the desktop app service needs from the client host to offer and take updates. */
export interface PendingClientUpdates {
  list(): PendingClientUpdateInfo[];
  /** Move the client's windows to the pending build. False when nothing is pending for it. */
  apply(clientId: string): Promise<boolean>;
}
