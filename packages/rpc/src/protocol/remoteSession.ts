import type { AuthenticatedCaller } from "../types.js";

/** Transport failure code for calls owned by a lost remote logical session. */
export const SESSION_CONNECTION_LOST_CODE = "CONNECTION_LOST" as const;

/** Non-terminal close code for a request targeting a session unknown to the peer. */
export const SESSION_NOT_OPEN_CLOSE_CODE = 4008 as const;

export const SESSION_SERVER_RESPONDER: AuthenticatedCaller = {
  callerId: "main",
  callerKind: "server",
};

export function isAuthenticatedServerCaller(caller: {
  callerId: string;
  callerKind: string;
}): boolean {
  return (
    caller.callerKind === "server" &&
    (caller.callerId === SESSION_SERVER_RESPONDER.callerId || caller.callerId === "server")
  );
}
