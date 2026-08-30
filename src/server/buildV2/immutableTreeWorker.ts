import { parentPort } from "node:worker_threads";
import { materializeImmutableTree } from "./immutableTreeMaterializer.js";

interface Request {
  id: number;
  source: string;
  target: string;
}

const port = parentPort;
if (!port) throw new Error("Immutable tree worker requires a parent port");

let queue = Promise.resolve();
port.on("message", (request: Request) => {
  queue = queue.then(async () => {
    try {
      await materializeImmutableTree(request.source, request.target);
      port.postMessage({ id: request.id, result: true });
    } catch (error) {
      port.postMessage({
        id: request.id,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message, stack: error.stack }
            : { name: "Error", message: String(error) },
      });
    }
  });
});
