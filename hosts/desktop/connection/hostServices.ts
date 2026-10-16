/**
 * The host-owned services of one workspace runtime, as the connection process
 * sees them.
 *
 * A renderer sends every envelope down its one port. Most are for the
 * workspace server; the ones addressed to a service the Electron main process
 * registered (views, menus, the native parts of the app service) are answered
 * by main. The connection process routes each by the runtime's service
 * catalog and hands the host-owned ones to main over the control channel, so
 * the renderer needs no routing knowledge and main sees only the calls that
 * are genuinely its own.
 */

/** One call to a host-owned service, with the authenticated identity it runs as. */
export interface HostCall {
  workspaceId: string;
  callerId: string;
  callerKind: "client" | "panel";
  requestId: string;
  idempotencyKey?: string;
  readOnly?: boolean;
  /** Aborts when the renderer cancels or its port ends. */
  signal?: AbortSignal;
  /** An upload body, for a host-owned streaming service. */
  body?: ReadableStream<Uint8Array> | null;
}

export interface HostServiceEndpoint {
  hasService(service: string): boolean;
  /** Resolves to the service's result, or to a `Response` for a streaming service. */
  dispatch(call: HostCall, service: string, method: string, args: unknown[]): Promise<unknown>;
  /** A server-owned call this runtime relayed failed after admission. */
  observeFailure(call: HostCall, service: string, method: string, error: unknown): void;
}
