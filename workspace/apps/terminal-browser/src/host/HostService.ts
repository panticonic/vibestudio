import type { AuthenticatedCaller, RpcClient } from "@vibestudio/rpc";
import { HOST_METHODS, type TerminalFrame } from "@workspace/terminal-host-protocol";
import type { SessionManager } from "./SessionManager.js";

export interface HostServiceDeps {
  sessions: SessionManager;
  /** Put the real TTY into / out of raw mode (focused session only). */
  setRealRawMode: (enabled: boolean) => void;
  /** True while a host overlay owns the screen — raw mode stays host-controlled. */
  isOverlayOpen: () => boolean;
  /** Max base64 frame length accepted from a worker (output flood guard). */
  maxFrameBytes?: number;
  /** Optional hook for observability when a call is rejected for ownership. */
  onRejected?: (method: string, callerId: string, sessionId: string) => void;
}

/**
 * Registers the methods workers call on the host. The host is the trusted side
 * and enforces, for every call:
 *   - **caller authorization** via the gateway-authenticated `ctx`
 *     from the context-object RPC handler. A call is accepted only when the
 *     immediate authenticated caller is exactly the worker/DO that owns the
 *     session (`ownerOf(sessionId) === req.caller.callerId`).
 *   - frame-size bounds (output flood guard);
 *   - raw mode only for the focused session while no overlay is open.
 */
export function registerHostService(rpc: RpcClient, deps: HostServiceDeps): void {
  const maxFrameBytes = deps.maxFrameBytes ?? 256 * 1024;

  const authorized = (
    caller: AuthenticatedCaller,
    sessionId: string,
    method: string,
  ): boolean => {
    if (deps.sessions.ownerOf(sessionId) === caller.callerId) return true;
    deps.onRejected?.(method, caller.callerId, sessionId);
    return false;
  };

  rpc.expose(HOST_METHODS.onFrame, (req) => {
    const [frame] = req.args as [TerminalFrame];
    if (!frame || typeof frame.data !== "string") return;
    if (!authorized(req.caller, frame.sessionId, HOST_METHODS.onFrame)) return; // drop
    if (frame.data.length > maxFrameBytes) return; // drop oversized frames
    void deps.sessions.onFrame(frame);
  });

  rpc.expose(HOST_METHODS.setTitle, (req) => {
    const [sessionId, title] = req.args as [string, string];
    if (!authorized(req.caller, sessionId, HOST_METHODS.setTitle)) return;
    deps.sessions.setTitle(sessionId, String(title ?? "").slice(0, 80));
  });

  rpc.expose(HOST_METHODS.requestClose, (req) => {
    const [sessionId, reason] = req.args as [string, string | undefined];
    if (!authorized(req.caller, sessionId, HOST_METHODS.requestClose)) return;
    void deps.sessions.close(sessionId, reason ?? "closed by worker");
  });

  rpc.expose(HOST_METHODS.setRawMode, (req) => {
    const [sessionId, enabled] = req.args as [string, boolean];
    if (!authorized(req.caller, sessionId, HOST_METHODS.setRawMode)) {
      return { ok: false, reason: "not-authorized" };
    }
    const focused = deps.sessions.focused();
    if (!focused || focused.sessionId !== sessionId) return { ok: false, reason: "not-focused" };
    if (deps.isOverlayOpen()) return { ok: false, reason: "overlay-open" };
    deps.setRealRawMode(Boolean(enabled));
    return { ok: true };
  });
}
