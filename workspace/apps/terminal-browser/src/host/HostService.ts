import type { RpcBridge } from "@natstack/rpc";
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
 *     (`exposeMethodWithCaller`). A call is accepted only if EITHER:
 *       (a) the caller is exactly the worker that owns the session
 *           (`ownerOf(sessionId) === ctx.callerId`) — strict ownership; or
 *       (b) the caller is the trusted server gateway relay
 *           (`ctx.callerKind === "server"` / id `"main"`).
 *     Any other principal (e.g. a panel, or a worker impersonating the host
 *     boundary directly) is rejected.
 *
 *     NOTE on (b): session workers are Durable Objects, which reach the host
 *     over HTTP→gateway relay. That relay currently collapses the caller to the
 *     server principal ("main") before delivering to the app — so today DO
 *     frames match (b), not (a), and strict per-DO ownership is bounded by the
 *     unguessable session id + the authenticated gateway. Once the relay
 *     preserves caller identity for app targets (see docs/terminal-apps.md),
 *     these calls will match (a) and tighten automatically with no change here.
 *   - frame-size bounds (output flood guard);
 *   - raw mode only for the focused session while no overlay is open.
 */
export function registerHostService(bridge: RpcBridge, deps: HostServiceDeps): void {
  const maxFrameBytes = deps.maxFrameBytes ?? 256 * 1024;

  const authorized = (
    ctx: { callerId: string; callerKind: string },
    sessionId: string,
    method: string,
  ): boolean => {
    if (deps.sessions.ownerOf(sessionId) === ctx.callerId) return true; // strict owner
    if (ctx.callerKind === "server" || ctx.callerId === "main") return true; // trusted gateway relay
    deps.onRejected?.(method, ctx.callerId, sessionId);
    return false;
  };

  bridge.exposeMethodWithCaller(HOST_METHODS.onFrame, (ctx, frame: TerminalFrame) => {
    if (!frame || typeof frame.data !== "string") return;
    if (!authorized(ctx, frame.sessionId, HOST_METHODS.onFrame)) return; // drop
    if (frame.data.length > maxFrameBytes) return; // drop oversized frames
    void deps.sessions.onFrame(frame);
  });

  bridge.exposeMethodWithCaller(HOST_METHODS.setTitle, (ctx, sessionId: string, title: string) => {
    if (!authorized(ctx, sessionId, HOST_METHODS.setTitle)) return;
    deps.sessions.setTitle(sessionId, String(title ?? "").slice(0, 80));
  });

  bridge.exposeMethodWithCaller(
    HOST_METHODS.requestClose,
    (ctx, sessionId: string, reason?: string) => {
      if (!authorized(ctx, sessionId, HOST_METHODS.requestClose)) return;
      void deps.sessions.close(sessionId, reason ?? "closed by worker");
    },
  );

  bridge.exposeMethodWithCaller(
    HOST_METHODS.setRawMode,
    (ctx, sessionId: string, enabled: boolean) => {
      if (!authorized(ctx, sessionId, HOST_METHODS.setRawMode)) {
        return { ok: false, reason: "not-authorized" };
      }
      const focused = deps.sessions.focused();
      if (!focused || focused.sessionId !== sessionId) return { ok: false, reason: "not-focused" };
      if (deps.isOverlayOpen()) return { ok: false, reason: "overlay-open" };
      deps.setRealRawMode(Boolean(enabled));
      return { ok: true };
    },
  );
}
