export interface RemoteStartupFailurePresentation {
  message: string;
  detail: string;
}

/**
 * Translate transport/storage failures into the recovery decision a person
 * actually has to make. In particular, never leave them guessing whether a
 * one-time pairing capability is still safe to retry.
 */
export function remoteStartupFailurePresentation(
  error: unknown,
  freshPairing: boolean
): RemoteStartupFailurePresentation {
  const cause = error instanceof Error ? error.message : String(error);
  const message = "Could not connect to the paired server";
  if (/pairing link was not used/i.test(cause)) {
    return {
      message,
      detail:
        "Fix the local credential-storage problem, then retry the same pairing link. The server has not consumed it.",
    };
  }
  if (/pairing link has already been used or has expired/i.test(cause)) {
    return {
      message,
      detail:
        "This link cannot be retried. Pairing links are single-use to prevent replay; generate a fresh link on the server or from a paired administrator.",
    };
  }
  if (/unable to reach .* configured relays|iroh dial .* timed out/i.test(cause)) {
    return {
      message: "Could not reach the server",
      detail: freshPairing
        ? "No connection was made, so this pairing link was not used. Check that the server is running and reachable, then retry the same link."
        : "The saved pairing was kept. Check that the server is running and reachable, then retry the connection.",
    };
  }
  if (freshPairing) {
    return {
      message,
      detail:
        "Pairing did not finish. If the error says the link was not used, retry it after fixing the problem; otherwise generate a fresh link before trying again.",
    };
  }
  return {
    message,
    detail:
      "The saved pairing was kept unless the server rejected it. Check the server or choose another workspace.",
  };
}
