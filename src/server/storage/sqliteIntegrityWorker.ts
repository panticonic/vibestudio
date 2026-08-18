import { parentPort } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";

const port = parentPort;
if (!port) throw new Error("SQLite integrity worker requires a parent port");

port.on("message", (request: { id: number; paths: string[]; readOnly: boolean }) => {
  try {
    for (const filePath of request.paths) {
      const database = new DatabaseSync(filePath, { readOnly: request.readOnly });
      try {
        const result = database.prepare("PRAGMA integrity_check").get() as Record<string, unknown>;
        if (!Object.values(result).includes("ok")) {
          throw new Error(`${filePath} failed SQLite integrity_check`);
        }
      } finally {
        database.close();
      }
    }
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
