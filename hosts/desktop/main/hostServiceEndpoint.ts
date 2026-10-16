import { RpcBoundaryError, type RpcCallOptions } from "@vibestudio/rpc";
import {
  createVerifiedCaller,
  type ServiceDispatcher,
  type VerifiedCodeIdentity,
} from "@vibestudio/shared/serviceDispatcher";
import type { HostEndpoint } from "./connectionLink.js";

/** One workspace's desktop runtime, as far as service dispatch needs it. */
export interface HostServiceRuntime {
  workspaceId: string;
  dispatcher: ServiceDispatcher;
}

export interface HostServiceEndpointDeps {
  /** The workspace's desktop runtime, created on first use; rejects once access was removed. */
  resolveWorkspace(workspaceId: string): Promise<HostServiceRuntime>;
  /** The sealed code identity of the document a caller id names. */
  codeIdentityForCaller(callerId: string): VerifiedCodeIdentity | null;
  /** The runtime lease a panel's session redeems. */
  panelRuntimeConnection(
    callerId: string
  ): { runtimeEntityId: string; connectionId: string } | undefined;
}

/**
 * The services the Electron main process owns, served to renderer sessions
 * that live in the connection process.
 *
 * The connection process authenticated the renderer's port and decided that the
 * call is for a host-owned service; main supplies the caller's sealed code
 * identity from its own window records and dispatches. Nothing a renderer sent
 * decides who it acts as.
 */
export function createHostServiceEndpoint(deps: HostServiceEndpointDeps): HostEndpoint {
  const verifiedCaller = (callerId: string, callerKind: "client" | "panel") =>
    createVerifiedCaller(callerId, callerKind, deps.codeIdentityForCaller(callerId));
  return {
    async catalog(workspaceId) {
      const runtime = await deps.resolveWorkspace(workspaceId);
      return runtime.dispatcher.getServices();
    },
    async dispatch(request, context) {
      const runtime = await deps.resolveWorkspace(request.workspaceId);
      if (!runtime.dispatcher.hasService(request.service)) {
        throw new RpcBoundaryError(
          `Host service ${request.service} is not registered for this workspace`,
          "protocol"
        );
      }
      const options: RpcCallOptions = {
        ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {}),
        ...(request.readOnly ? { readOnly: true } : {}),
      };
      return runtime.dispatcher.dispatch(
        {
          caller: verifiedCaller(request.callerId, request.callerKind),
          requestId: request.requestId,
          signal: context.signal,
          ...(context.body ? { body: context.body } : {}),
          ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
          ...(options.readOnly ? { readOnly: true } : {}),
        },
        request.service,
        request.method,
        request.args
      );
    },
    async panelLease(callerId) {
      return deps.panelRuntimeConnection(callerId);
    },
    observeFailure(event, error) {
      void deps.resolveWorkspace(event.workspaceId).then(
        (runtime) =>
          runtime.dispatcher.observeFailure(
            {
              caller: verifiedCaller(event.callerId, event.callerKind),
              requestId: event.requestId,
            },
            event.service,
            event.method,
            error
          ),
        () => undefined
      );
    },
  };
}
