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
  private readonly retiring = new Map<string, Promise<void>>();
  private closing: Promise<void> | null = null;

  constructor(
    initial: T,
    private readonly connect: (workspaceId: string) => Promise<T>
  ) {
    if (!initial.workspaceId.trim()) throw new Error("Workspace ID is required");
    const connection = Promise.resolve(initial);
    this.sessions.set(initial.workspaceId, { connection, ready: connection });
  }

  get(workspaceId: string): Promise<T> {
    if (!workspaceId.trim()) return Promise.reject(new Error("Workspace ID is required"));
    if (this.closing) return Promise.reject(new Error("Desktop workspace sessions are closing"));
    if (this.retiring.has(workspaceId)) {
      return Promise.reject(new Error("This workspace session is closing"));
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
      return session;
    });
    const entry = { connection, ready };
    this.sessions.set(workspaceId, entry);
    void ready.catch(() => {
      if (this.sessions.get(workspaceId) === entry && !this.retiring.has(workspaceId)) {
        this.sessions.delete(workspaceId);
      }
    });
    return ready;
  }

  /** Membership removal or explicit close releases this exact workspace. */
  release(workspaceId: string): Promise<void> {
    const existing = this.retiring.get(workspaceId);
    if (existing) return existing;
    const session = this.sessions.get(workspaceId);
    if (!session) return Promise.resolve();
    const retirement = session.connection.then(
      (value) => value.close(),
      () => undefined
    );
    this.retiring.set(workspaceId, retirement);
    void retirement.then(
      () => {
        if (this.sessions.get(workspaceId) === session) this.sessions.delete(workspaceId);
        this.retiring.delete(workspaceId);
      },
      () => {
        // Failed cleanup keeps ownership and blocks reopening the same workspace.
        // close() will report this failure rather than forget a live resource.
      }
    );
    return retirement;
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
