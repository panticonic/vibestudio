import * as path from "node:path";
import { prepareWorkspaceTemplates } from "../src/server/workspaceTemplatePreparation.js";

const option = (name: string) => {
  const value = process.argv[process.argv.indexOf(name) + 1];
  if (!process.argv.includes(name) || !value) throw new Error(`${name} is required`);
  return path.resolve(value);
};
const cancellation = new AbortController();
const interrupt = () =>
  cancellation.abort(
    Object.assign(new Error("Template preparation cancelled"), { code: "ECANCELLED" })
  );
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
process.on("disconnect", interrupt);
void prepareWorkspaceTemplates({
  appRoot: option("--app-root"),
  output: option("--output"),
  scratch: option("--scratch"),
  signal: cancellation.signal,
  onSourcesPrepared: () => {
    if (process.connected)
      process.send!({ kind: "sources-ready" }, (error) => {
        if (error) cancellation.abort(error);
      });
  },
})
  .catch((error) => {
    if (cancellation.signal.aborted && error.code !== "EOWNERSHIP")
      error = cancellation.signal.reason;
    // Disconnect revokes the producer. Its original failure remains on stderr
    // when the parent can no longer receive the terminal IPC receipt.
    if (process.connected)
      process.send!(
        {
          kind: "failed",
          message: String(error.message ?? error),
          stack: error.stack,
          code: error.code,
        },
        () => {}
      );
    if (error.code !== "ECANCELLED") console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    process.off("disconnect", interrupt);
    if (process.connected) process.disconnect();
  });
