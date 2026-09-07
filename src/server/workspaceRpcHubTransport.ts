import { workspaceRpcDestination } from "@vibestudio/rpc";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { WorkspaceRpcInvocation } from "./workspaceRpcTransport.js";
import { forwardWorkspaceRpcHttp, receiveWorkspaceRpcHttp } from "./workspaceRpcTransport.js";

/** Hub routing uses exact stable workspace IDs and live process generations.
 * The callback resolves no destination until both hard policies have passed. */
export async function receiveHubWorkspaceRpcHttp(
  req: IncomingMessage,
  res: ServerResponse,
  options: {
    authenticateSource(): string;
    assertAccess(invocation: WorkspaceRpcInvocation): void;
    resolveDestination(workspaceId: string): Promise<{
      url: URL | string;
      runtimeToken: string;
      assertLive(): void;
    }>;
  }
): Promise<void> {
  let sourceWorkspaceId: string;
  await receiveWorkspaceRpcHttp(req, res, {
    authenticate() {
      const current = options.authenticateSource();
      if (sourceWorkspaceId !== undefined && sourceWorkspaceId !== current) {
        throw Object.assign(new Error("Workspace child runtime expired"), { code: "EACCES" });
      }
      sourceWorkspaceId = current;
    },
    assertLive(invocation) {
      if (
        invocation.caller.workspaceId !== sourceWorkspaceId ||
        workspaceRpcDestination(invocation.envelope.destination) === sourceWorkspaceId
      ) {
        throw Object.assign(new Error("Workspace caller does not match its host"), {
          code: "EACCES",
        });
      }
      options.assertAccess(invocation);
    },
    async dispatch(delivery) {
      const destination = await options.resolveDestination(
        workspaceRpcDestination(delivery.invocation.envelope.destination)!
      );
      await forwardWorkspaceRpcHttp({
        url: destination.url,
        runtimeToken: destination.runtimeToken,
        invocation: delivery.invocation,
        body: delivery.body,
        signal: delivery.signal,
        onEnvelope: delivery.send,
        assertLive() {
          if (options.authenticateSource() !== sourceWorkspaceId) {
            throw Object.assign(new Error("Workspace child runtime expired"), { code: "EACCES" });
          }
          destination.assertLive();
          options.assertAccess(delivery.invocation);
        },
      });
    },
  });
}
