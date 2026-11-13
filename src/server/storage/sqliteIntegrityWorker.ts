import { parentPort } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const port = parentPort;
if (!port) throw new Error("SQLite integrity worker requires a parent port");

/** Problems integrity_check reports, or an empty list for a sound database. */
function integrityProblems(filePath: string, readOnly: boolean): string[] {
  const database = new DatabaseSync(path.toNamespacedPath(path.resolve(filePath)), { readOnly });
  try {
    // integrity_check returns the single row "ok", or one row per problem.
    const problems = (
      database.prepare("PRAGMA integrity_check(8)").all() as Record<string, unknown>[]
    ).flatMap((row) => Object.values(row).map(String));
    return problems.length === 1 && problems[0] === "ok" ? [] : problems;
  } finally {
    database.close();
  }
}

port.on("message", (request: { id: number; paths: string[]; readOnly: boolean }) => {
  try {
    for (const filePath of request.paths) {
      let problems: string[];
      try {
        problems = integrityProblems(filePath, request.readOnly);
      } catch (error) {
        // Opening or checking a badly damaged file throws before any row is
        // returned; name the file so the failure is actionable.
        throw new Error(
          `${filePath} failed SQLite verification: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      if (problems.length > 0) {
        throw new Error(`${filePath} failed SQLite integrity_check: ${problems.join("; ")}`);
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
