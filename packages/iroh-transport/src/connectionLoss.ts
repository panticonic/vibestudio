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

/** True when an error is Iroh reporting that the connection itself is gone. */
export function isIrohConnectionLost(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : null;
  // `ConnectionLost(..)` is the wrapper Iroh puts around every stream error
  // whose cause is the connection itself, whichever side ended it. A stream
  // that merely finished, or a peer that reset one request, does not carry it —
  // those remain failures worth reporting as failures.
  return message !== null && message.includes("ConnectionLost(");
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
    if (error instanceof Error && isIrohConnectionLost(error) && !("code" in error)) {
      throw Object.assign(error, {
        code: IROH_CONNECTION_LOST_CODE,
        errorKind: "transport" as const,
      });
    }
    throw error;
  }
}
