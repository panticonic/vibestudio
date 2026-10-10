import * as path from "node:path";
import { prepareWorkspaceTemplates } from "../src/server/workspaceTemplatePreparation.js";

const option = (name: string) => {
  const value = process.argv[process.argv.indexOf(name) + 1];
  if (!process.argv.includes(name) || !value) throw new Error(`${name} is required`);
  return path.resolve(value);
};
const cancellation = new AbortController();
const interrupt = () => cancellation.abort(new Error("Template preparation cancelled"));
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
void prepareWorkspaceTemplates({
  appRoot: option("--app-root"),
  output: option("--output"),
  scratch: option("--scratch"),
  signal: cancellation.signal,
})
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  });
