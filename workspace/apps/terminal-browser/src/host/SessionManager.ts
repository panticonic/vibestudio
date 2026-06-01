import {
  SESSION_METHODS,
  decodeFrameData,
  encodeInput,
  type TerminalFrame,
  type TerminalSize,
} from "@workspace/terminal-host-protocol";
import { VtSession } from "./VtSession.js";

/** Minimal RPC surface the manager needs (injectable for tests). */
export interface RpcLike {
  call<T = unknown>(targetId: string, method: string, args: unknown[]): Promise<T>;
}

export type SessionStatus = "starting" | "running" | "errored" | "closed";

export interface SessionRecord {
  sessionId: string;
  title: string;
  targetId: string;
  status: SessionStatus;
  focused: boolean;
  vt: VtSession;
  lastSeq: number;
  error?: string;
}

export interface SessionSourceSpec {
  /** Worker source path, e.g. "workers/terminal-chat". */
  source: string;
  className: string;
  title: string;
}

export interface SessionManagerOptions {
  rpc: RpcLike;
  /** This host app's principal id — workers call `terminal.onFrame` on it. */
  hostPrincipalId: string;
  viewport: TerminalSize;
}

let sessionCounter = 0;

/**
 * Owns worker-backed terminal sessions: spawns the session DO, feeds its output
 * into a per-session VT emulator, routes input/resize, and tracks focus. Only
 * the focused session is composited by the host; others keep their VT buffer.
 */
export class SessionManager {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly byTarget = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  private focusedId: string | null = null;
  private viewport: TerminalSize;

  constructor(private readonly opts: SessionManagerOptions) {
    this.viewport = opts.viewport;
  }

  /** Subscribe to visible-state changes (frame arrived, focus moved, …). */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emitChange(): void {
    for (const l of [...this.listeners]) {
      try {
        l();
      } catch {
        // a listener must not break the manager
      }
    }
  }

  list(): SessionRecord[] {
    return [...this.sessions.values()];
  }

  focused(): SessionRecord | null {
    return this.focusedId ? (this.sessions.get(this.focusedId) ?? null) : null;
  }

  /**
   * The authenticated principal that owns a session — the worker DO's target
   * id (which equals its RPC `selfId`, since the host calls the worker *at*
   * that id). Used by HostService to reject frames/control calls from any other
   * caller. Returns null for unknown sessions or before the worker is spawned.
   */
  ownerOf(sessionId: string): string | null {
    const targetId = this.sessions.get(sessionId)?.targetId;
    return targetId ? targetId : null;
  }

  /** Spawn a worker session and focus it. */
  async open(spec: SessionSourceSpec): Promise<SessionRecord> {
    const sessionId = `term-${++sessionCounter}-${Date.now().toString(36)}`;
    const vt = new VtSession(this.viewport);
    const record: SessionRecord = {
      sessionId,
      title: spec.title,
      targetId: "",
      status: "starting",
      focused: false,
      vt,
      lastSeq: -1,
    };
    this.sessions.set(sessionId, record);
    this.emitChange();

    try {
      const entity = await this.opts.rpc.call<{ targetId: string; contextId?: string }>(
        "main",
        "runtime.createEntity",
        [{ kind: "do", source: spec.source, className: spec.className, key: sessionId }],
      );
      record.targetId = entity.targetId;
      this.byTarget.set(entity.targetId, sessionId);
      await this.opts.rpc.call(entity.targetId, SESSION_METHODS.start, [
        {
          sessionId,
          hostPrincipalId: this.opts.hostPrincipalId,
          viewport: this.viewport,
          contextId: entity.contextId,
        },
      ]);
      record.status = "running";
      this.focus(sessionId);
    } catch (err) {
      record.status = "errored";
      record.error = err instanceof Error ? err.message : String(err);
      this.emitChange();
    }
    return record;
  }

  /** Host-exposed `terminal.onFrame` handler dispatches here. */
  async onFrame(frame: TerminalFrame): Promise<void> {
    const record = this.sessions.get(frame.sessionId);
    if (!record) return;
    // Drop out-of-order / duplicate frames.
    if (frame.seq <= record.lastSeq) return;
    record.lastSeq = frame.seq;
    await record.vt.write(decodeFrameData(frame));
    if (record.focused) this.emitChange();
  }

  /** Route raw input bytes to the focused session. */
  async sendInput(bytes: Uint8Array): Promise<void> {
    const record = this.focused();
    if (!record || record.status !== "running") return;
    await this.opts.rpc
      .call(record.targetId, SESSION_METHODS.onInput, [encodeInput(record.sessionId, bytes)])
      .catch(() => this.markErrored(record.sessionId, "input delivery failed"));
  }

  /** Resize all sessions' viewports (host owns the real terminal size). */
  async resize(size: TerminalSize): Promise<void> {
    this.viewport = size;
    await Promise.all(
      this.list().map(async (record) => {
        record.vt.resize(size);
        if (record.status === "running") {
          await this.opts.rpc
            .call(record.targetId, SESSION_METHODS.onResize, [{ sessionId: record.sessionId, size }])
            .catch(() => {});
        }
      }),
    );
    this.emitChange();
  }

  focus(sessionId: string): void {
    if (this.focusedId === sessionId) return;
    const prev = this.focused();
    if (prev) {
      prev.focused = false;
      if (prev.status === "running") {
        void this.opts.rpc.call(prev.targetId, SESSION_METHODS.onBlur, [{ sessionId: prev.sessionId }]).catch(() => {});
      }
    }
    const next = this.sessions.get(sessionId);
    if (!next) return;
    next.focused = true;
    this.focusedId = sessionId;
    if (next.status === "running") {
      void this.opts.rpc.call(next.targetId, SESSION_METHODS.onFocus, [{ sessionId }]).catch(() => {});
      // Ask the worker to repaint so the freshly-focused viewport is complete.
      void this.opts.rpc.call(next.targetId, SESSION_METHODS.repaint, [{ sessionId }]).catch(() => {});
    }
    this.emitChange();
  }

  /** Focus the next/previous session (for the switcher / cycling). */
  cycle(direction: 1 | -1): void {
    const ids = this.list().map((r) => r.sessionId);
    if (ids.length === 0) return;
    const idx = this.focusedId ? ids.indexOf(this.focusedId) : -1;
    const next = ids[(idx + direction + ids.length) % ids.length]!;
    this.focus(next);
  }

  async close(sessionId: string, reason = "closed by user"): Promise<void> {
    const record = this.sessions.get(sessionId);
    if (!record) return;
    if (record.status === "running") {
      await this.opts.rpc.call(record.targetId, SESSION_METHODS.onClose, [{ sessionId, reason }]).catch(() => {});
    }
    record.vt.dispose();
    this.sessions.delete(sessionId);
    this.byTarget.delete(record.targetId);
    if (this.focusedId === sessionId) {
      this.focusedId = null;
      const first = this.list()[0];
      if (first) this.focus(first.sessionId);
    }
    this.emitChange();
  }

  setTitle(sessionId: string, title: string): void {
    const record = this.sessions.get(sessionId);
    if (record) {
      record.title = title;
      this.emitChange();
    }
  }

  private markErrored(sessionId: string, reason: string): void {
    const record = this.sessions.get(sessionId);
    if (record) {
      record.status = "errored";
      record.error = reason;
      this.emitChange();
    }
  }

  async closeAll(reason = "host shutdown"): Promise<void> {
    await Promise.all(this.list().map((r) => this.close(r.sessionId, reason)));
  }
}
