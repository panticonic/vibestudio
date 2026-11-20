import { parentPort } from "node:worker_threads";
import {
  materializeImmutableTree,
  materializePackageResources,
} from "./immutableTreeMaterializer.js";
import { serializeBuildWorkerFailure } from "./workerFailure.js";

interface Request {
  id: number;
  source: string;
  target: string;
  kind: "tree" | "package" | "workspace-package";
}

const port = parentPort;
if (!port) throw new Error("Immutable tree worker requires a parent port");

let queue = Promise.resolve();
port.on("message", (request: Request) => {
  queue = queue.then(async () => {
    try {
      if (request.kind !== "tree")
        await materializePackageResources(
          request.source,
          request.target,
          request.kind === "workspace-package"
        );
      else await materializeImmutableTree(request.source, request.target);
      port.postMessage({ id: request.id, result: true });
    } catch (error) {
      port.postMessage({
        id: request.id,
        failure: serializeBuildWorkerFailure(error),
      });
    }
  });
});
