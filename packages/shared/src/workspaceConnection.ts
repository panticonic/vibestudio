export type WorkspaceConnectionPhase = "starting" | "online" | "reconnecting" | "ended";
export type WorkspaceConnectionMode = "local" | "remote";
export type WorkspaceTransportStatus = "connecting" | "connected" | "disconnected";

/**
 * Host-owned availability of the selected workspace server.
 *
 * This intentionally contains no transport error prose, endpoint identity, or
 * credential detail. Renderers need one stable presentation fact, not the
 * cascade of failures that happened to reveal it.
 */
export interface WorkspaceConnectionState {
  version: 1;
  phase: WorkspaceConnectionPhase;
  mode: WorkspaceConnectionMode;
  since: number;
  attempt?: number;
  nextRetryInMs?: number;
}

export interface WorkspaceReconnectProgress {
  attempt: number;
  nextRetryInMs?: number;
}

export interface WorkspaceConnectionPresentation {
  title: string;
  message: string;
  showSpinner: boolean;
  showSettings: boolean;
  retryDetail?: string;
}

function sameState(left: WorkspaceConnectionState, right: WorkspaceConnectionState): boolean {
  return (
    left.phase === right.phase &&
    left.mode === right.mode &&
    left.attempt === right.attempt &&
    left.nextRetryInMs === right.nextRetryInMs
  );
}

export class WorkspaceConnectionStateController {
  private current: WorkspaceConnectionState;
  private hasBeenOnline = false;

  constructor(
    mode: WorkspaceConnectionMode,
    private readonly publish: (state: WorkspaceConnectionState) => void,
    private readonly now: () => number = Date.now
  ) {
    this.current = { version: 1, phase: "starting", mode, since: this.now() };
  }

  snapshot(): WorkspaceConnectionState {
    return this.current;
  }

  begin(mode: WorkspaceConnectionMode): void {
    this.hasBeenOnline = false;
    this.replace({ version: 1, phase: "starting", mode, since: this.now() });
  }

  transport(status: WorkspaceTransportStatus): void {
    if (this.current.phase === "ended") return;
    if (status === "connected") {
      this.hasBeenOnline = true;
      this.replace({
        version: 1,
        phase: "online",
        mode: this.current.mode,
        since: this.now(),
      });
      return;
    }
    if (!this.hasBeenOnline) return;
    this.replace({
      version: 1,
      phase: "reconnecting",
      mode: this.current.mode,
      since: this.current.phase === "reconnecting" ? this.current.since : this.now(),
    });
  }

  reconnect(progress: WorkspaceReconnectProgress): void {
    if (this.current.phase === "ended" || !this.hasBeenOnline) return;
    this.replace({
      version: 1,
      phase: "reconnecting",
      mode: this.current.mode,
      since: this.current.phase === "reconnecting" ? this.current.since : this.now(),
      attempt: progress.attempt,
      ...(progress.nextRetryInMs === undefined ? {} : { nextRetryInMs: progress.nextRetryInMs }),
    });
  }

  end(): void {
    this.replace({
      version: 1,
      phase: "ended",
      mode: this.current.mode,
      since: this.now(),
    });
  }

  private replace(next: WorkspaceConnectionState): void {
    if (sameState(this.current, next)) return;
    this.current = next;
    this.publish(next);
  }
}

export function workspaceConnectionPresentation(
  state: WorkspaceConnectionState
): WorkspaceConnectionPresentation | null {
  if (state.phase === "starting" || state.phase === "online") return null;
  if (state.phase === "ended") {
    return {
      title: "Connection ended",
      message:
        "This device can no longer resume its workspace session. Open connection settings to reconnect or pair again.",
      showSpinner: false,
      showSettings: true,
    };
  }
  const retryDetail =
    state.attempt && state.attempt > 1
      ? `Reconnect attempt ${state.attempt}${
          state.nextRetryInMs && state.nextRetryInMs > 0
            ? ` in ${Math.max(1, Math.ceil(state.nextRetryInMs / 1_000))}s`
            : ""
        }`
      : undefined;
  return {
    title: "Workspace server unavailable",
    message:
      "Vibestudio is reconnecting automatically. Your workspace is safe and this view will resume when the server is reachable.",
    showSpinner: true,
    showSettings: true,
    ...(retryDetail ? { retryDetail } : {}),
  };
}
