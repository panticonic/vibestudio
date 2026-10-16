export type ClientLaunchErrorCode =
  | "host-abi-mismatch"
  | "integrity-mismatch"
  | "unsupported-integrity"
  | "artifact-fetch-failed"
  | "invalid-host-descriptor"
  | "stale-launch";

/** A launch failed after the server resolved a client: the host cannot (safely) run what it was given. */
export class ClientLaunchError extends Error {
  constructor(
    readonly code: ClientLaunchErrorCode,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "ClientLaunchError";
  }
}
