/** A connection belongs to one workspace for its entire lifetime. */
export interface OwnedWorkspaceSession {
  readonly workspaceId: string;
  close(): Promise<void>;
}

/**
 * Lazily owns the desktop's workspace sessions. Focus is deliberately absent:
 * selecting another workspace cannot retarget a captured operation or tear down
 * the connection carrying its events. The application owns this directory;
 * workspace controllers own the objects returned by get().
 */
export class WorkspaceSessionDirectory<T extends OwnedWorkspaceSession> {
  private readonly sessions = new Map<string, { connection: Promise<T>; ready: Promise<T> }>();
  private readonly retiring = new Map<string, { operation: Promise<void>; failed: boolean }>();
  private admittedWorkspaceIds: ReadonlySet<string> | null = null;
  private closing: Promise<void> | null = null;

  constructor(
    initial: T,
    private readonly connect: (workspaceId: string) => Promise<T>
  ) {
    if (!initial.workspaceId.trim()) throw new Error("Workspace ID is required");
    const connection = Promise.resolve(initial);
    this.sessions.set(initial.workspaceId, { connection, ready: connection });
  }

  get hasAuthoritativeCatalog(): boolean {
    return this.admittedWorkspaceIds !== null;
  }

  /** Establish bootstrap admission unless a newer catalog event already did. */
  initializeCatalog(visibleWorkspaceIds: ReadonlySet<string>): void {
    this.admittedWorkspaceIds ??= new Set(visibleWorkspaceIds);
  }

  get(workspaceId: string): Promise<T> {
    if (!workspaceId.trim()) return Promise.reject(new Error("Workspace ID is required"));
    if (this.closing) return Promise.reject(new Error("Desktop workspace sessions are closing"));
    if (this.retiring.has(workspaceId)) {
      return Promise.reject(new Error("This workspace session is closing"));
    }
    if (this.admittedWorkspaceIds && !this.admittedWorkspaceIds.has(workspaceId)) {
      return Promise.reject(new Error("Workspace access was removed"));
    }
    const existing = this.sessions.get(workspaceId);
    if (existing) return existing.ready;
    // Own the physical connection before validating the exposed identity. A
    // rejected identity must not hide a failed close from directory shutdown.
    const connection = Promise.resolve().then(() => this.connect(workspaceId));
    const ready = connection.then(async (session) => {
      if (session.workspaceId !== workspaceId) {
        await this.release(workspaceId);
        throw new Error("Workspace connection returned a different workspace identity");
      }
      if (this.admittedWorkspaceIds && !this.admittedWorkspaceIds.has(workspaceId)) {
        throw new Error("Workspace access was removed during connection");
      }
      return session;
    });
    const entry = { connection, ready };
    this.sessions.set(workspaceId, entry);
    void connection.catch(() => {
      if (this.sessions.get(workspaceId) === entry && !this.retiring.has(workspaceId)) {
        this.sessions.delete(workspaceId);
      }
    });
    return ready;
  }

  /** Membership removal or explicit close releases this exact workspace. */
  release(workspaceId: string): Promise<void> {
    return this.retire(workspaceId, () => undefined);
  }

  private retire(
    workspaceId: string,
    beforeRelease: (workspaceId: string) => void | Promise<void>
  ): Promise<void> {
    const existing = this.retiring.get(workspaceId);
    if (existing && !existing.failed) return existing.operation;
    const session = this.sessions.get(workspaceId);
    if (!session) return Promise.resolve();
    const retirement = Promise.resolve().then(async () => {
      await beforeRelease(workspaceId);
      let value: T;
      try {
        value = await session.connection;
      } catch {
        return;
      }
      await value.close();
    });
    const owned = { operation: retirement, failed: false };
    this.retiring.set(workspaceId, owned);
    void retirement.then(
      () => {
        if (this.sessions.get(workspaceId) === session) this.sessions.delete(workspaceId);
        if (this.retiring.get(workspaceId) === owned) this.retiring.delete(workspaceId);
      },
      () => {
        // Failed cleanup keeps ownership, but a later authoritative catalog
        // snapshot must be able to retry retirement.
        if (this.retiring.get(workspaceId) === owned) owned.failed = true;
      }
    );
    return retirement;
  }

  /** Reconcile owned sessions against one authoritative visible-workspace snapshot. */
  async reconcile(
    visibleWorkspaceIds: ReadonlySet<string>,
    beforeRelease: (workspaceId: string) => void | Promise<void> = () => undefined
  ): Promise<void> {
    // Publish admission before beginning asynchronous retirement. A request
    // racing this snapshot can no longer recreate a removed connection.
    this.admittedWorkspaceIds = new Set(visibleWorkspaceIds);
    const removed = [...this.sessions.keys()].filter((id) => !visibleWorkspaceIds.has(id));
    const results = await Promise.allSettled(
      removed.map(async (id) => {
        await this.retire(id, beforeRelease);
      })
    );
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    );
    if (failures.length) throw new AggregateError(failures, "Workspace membership cleanup failed");
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    const retirements = [...this.sessions.keys()].map((id) => this.release(id));
    this.closing = Promise.allSettled(retirements).then((results) => {
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : []
      );
      if (failures.length) throw new AggregateError(failures, "Workspace session cleanup failed");
    });
    return this.closing;
  }
}
