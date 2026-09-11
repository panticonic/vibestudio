/**
 * Tagging a native Iroh failure whose cause is the connection being gone.
 *
 * The binding surfaces these as plain Errors whose message is the Rust error's
 * Debug form — `ConnectionLost(LocallyClosed)` for an operation on a
 * connection this side has closed, `ConnectionLost(ApplicationClosed(..))` for
 * one the peer closed. There is no code and no class on them: the vocabulary
 * is textual because it comes from a formatter rather than from our own throw
 * sites.
 *
 * So this is the one place allowed to read it, and it reads it once, at the
 * edge where the native call returns. Everything above — the RPC relay that
 * serializes a handler's failure, and every caller that asks whether a failure
 * was just a reconnect — then works from the code, never the message. Without
 * this, a handler that failed on a dropped connection reached its caller as an
 * ordinary application fault, and the guards written to forgive a reconnect
 * could not recognize one.
 */

/**
 * Kept in step with `SESSION_CONNECTION_LOST_CODE` in `@vibestudio/rpc`.
 *
 * The literal is restated rather than imported because this package is the
 * lower one: the RPC layer depends on the transport, and parts of it are
 * type-checked inside workerd programs where this package's Node surface does
 * not belong. `connectionLossCodeAgreesWithRpc` in the RPC tests fails if the
 * two ever diverge.
 */
export const IROH_CONNECTION_LOST_CODE = "CONNECTION_LOST" as const;

/**
 * Messages that mean the transport this call needed is gone.
 *
 * `ConnectionLost(..)` is the wrapper Iroh puts around every stream error
 * whose cause is the connection itself, whichever side ended it. `ClosedStream`
 * is what a read or write gets once its own stream has been closed, which in
 * this transport happens when the connection carrying it went away: the call
 * cannot be completed and a new connection is the remedy, which is exactly
 * what the transport code tells a caller. A peer that resets one request while
 * the connection stays up reports that differently, and stays a failure worth
 * reporting as a failure.
 */
const CONNECTION_LOST_MESSAGES = ["ConnectionLost(", "ClosedStream"];

/**
 * The connection-error vocabulary itself, when it arrives unwrapped.
 *
 * Some call sites surface quinn's `ConnectionError` directly rather than
 * through the `ConnectionLost(..)` wrapper a stream operation puts around it,
 * so the same lost connection reads as a bare `TimedOut` — which is how a
 * renderer came to warn `heartbeat failed: RemoteRpcError: TimedOut` while the
 * link was being re-established. Every variant here ends the connection, and
 * the match is anchored so that a stream-level `ReadError(Reset(513))`, which
 * reports one request the peer refused and stays a reportable failure, is not
 * mistaken for the connection-level `Reset` that shares its name.
 */
const CONNECTION_ERROR_MESSAGE =
  /^(?:TimedOut|LocallyClosed|Reset|VersionMismatch|CidsExhausted|ApplicationClosed\(|ConnectionClosed\(|TransportError)/u;

/** True when an error is Iroh reporting that the connection itself is gone. */
export function isIrohConnectionLost(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : null;
  if (message === null) return false;
  return (
    CONNECTION_LOST_MESSAGES.some((text) => message.includes(text)) ||
    CONNECTION_ERROR_MESSAGE.test(message)
  );
}

/**
 * Run a native Iroh operation, tagging a lost connection as a transport loss.
 *
 * The tag is what survives: `code` is copied onto the RPC wire and `errorKind`
 * decides how the far side classifies it, so a caller's typed check answers
 * correctly even when the failure happened several hops away.
 */
export async function withIrohConnectionLossTag<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    // The napi binding stamps its own `code` on every error it throws — the
    // status name, `GenericFailure`. Declining to tag an error that already
    // carried a code therefore declined to tag all of them, and this whole
    // edge was inert: a connection lost mid-call still reached renderers as an
    // unexplained application fault, and the desktop smoke failed on the
    // warning. A napi status is not a domain code, so ours replaces it.
    if (error instanceof Error && isIrohConnectionLost(error)) {
      throw Object.assign(error, {
        code: IROH_CONNECTION_LOST_CODE,
        errorKind: "transport" as const,
      });
    }
    throw error;
  }
}
