import {
  canonicalTemplateUrlFromCheckout,
  inspectWorkspaceSources,
} from "../../src/workspaceTemplateSource.js";
/** Run canonical template preparation inside its caller's owned process group.
 * Git subprocesses inherit that group, so a dead worker cannot leave a writer
 * after the run reaper removes its checkout. */
import {
  prepareE2eRootTemplateInProcess,
  deriveE2eRootTemplateInProcess,
} from "./e2eRootTemplate.js";

if (!process.send) throw new Error("E2E root preparation requires its owner IPC channel");
const request = await new Promise<{ operation: string; input: Record<string, unknown> }>(
  (resolve) => process.once("message", resolve)
);
try {
  let result;
  if (request.operation === "prepare")
    result = await prepareE2eRootTemplateInProcess(
      request.input as Parameters<typeof prepareE2eRootTemplateInProcess>[0]
    );
  else if (request.operation === "derive")
    result = await deriveE2eRootTemplateInProcess({
      ...(request.input as Omit<
        Parameters<typeof deriveE2eRootTemplateInProcess>[0],
        "configureSource"
      >),
      configureSource: async (checkout) => {
        const configured = new Promise<void>((resolve, reject) =>
          process.once("message", (message: { error?: string }) =>
            message.error ? reject(new Error(message.error)) : resolve()
          )
        );
        process.send!({ kind: "configure", checkout });
        await configured;
      },
    });
  else if (request.operation === "inspect") {
    const input = request.input as { checkouts: string[]; checkpointRoot: string };
    result = await inspectWorkspaceSources({
      sources: input.checkouts.map((checkout) => ({
        checkout,
        url: canonicalTemplateUrlFromCheckout(checkout),
      })),
      checkpointRoot: input.checkpointRoot,
    });
  } else throw new Error("Unknown E2E root preparation operation");
  process.send!({ kind: "result", value: result }, () => process.disconnect());
} catch (error) {
  process.exitCode = 1;
  process.send!(
    {
      kind: "error",
      message: error instanceof Error ? (error.stack ?? error.message) : String(error),
    },
    () => process.disconnect()
  );
}
