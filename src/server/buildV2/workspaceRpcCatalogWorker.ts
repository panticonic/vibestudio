import { parentPort } from "node:worker_threads";
import { collectWorkspaceRpcCatalog } from "./workspaceRpcCatalog.js";
import type { UnitAuthorityManifest } from "@vibestudio/shared/authorityManifest";
import type { WorkspaceRpcSchemaMetadata } from "./workspaceRpcCatalog.js";
import { serializeBuildWorkerFailure } from "./workerFailure.js";

interface Request {
  id: number;
  workerSourcePath: string;
  input: {
    provider: string;
    authority: UnitAuthorityManifest;
    rpcSchemas?: Readonly<Record<string, Readonly<Record<string, WorkspaceRpcSchemaMetadata>>>>;
  };
}

const port = parentPort;
if (!port) throw new Error("Workspace RPC catalog worker requires a parent port");

let queue = Promise.resolve();
port.on("message", (request: Request) => {
  queue = queue.then(async () => {
    try {
      const result = await collectWorkspaceRpcCatalog(request.workerSourcePath, request.input);
      port.postMessage({ id: request.id, result });
    } catch (error) {
      port.postMessage({
        id: request.id,
        failure: serializeBuildWorkerFailure(error),
      });
    }
  });
});
