import { fileURLToPath } from "node:url";
import { withOwnership } from "../../scripts/lib/owned-entry.mjs";

/** The existing owner/reaper owns the complete preparation process group. */
export async function runE2eRootPreparation<T>(
  operation: string,
  input: object,
  configureSource?: (checkout: string) => void
): Promise<T> {
  return withOwnership(async (ownership) => {
    const owned = ownership.spawn(
      process.execPath,
      ["--import", "tsx", fileURLToPath(new URL("./e2eRootPreparation.ts", import.meta.url))],
      {
        kill: "immediate",
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        label: "e2e-root-preparation",
      }
    );
    const { child } = owned;
    let result: T | undefined,
      completed = false,
      originalError: unknown,
      stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-20_000);
    });
    const finished = new Promise<T>((resolve, reject) => {
      child.once("error", (error) => reject(originalError ?? error));
      child.on(
        "message",
        async (message: { kind: string; checkout?: string; value?: T; message?: string }) => {
          if (message.kind === "configure") {
            try {
              if (!configureSource || typeof message.checkout !== "string")
                throw new Error("Unexpected E2E source configuration request");
              ownership.signal.throwIfAborted();
              await ownership.scope.track(
                Promise.resolve().then(() => configureSource(message.checkout!))
              );
              if (child.connected) child.send({ kind: "configured" });
            } catch (error) {
              originalError = error;
              if (child.connected) child.send({ kind: "configured", error: String(error) });
            }
          } else if (message.kind === "result") {
            result = message.value;
            completed = true;
          } else if (message.kind === "error") originalError ??= new Error(message.message);
        }
      );
      child.once("close", (code, signal) => {
        if (code === 0 && completed) resolve(result as T);
        else
          reject(
            originalError ?? new Error(`E2E root preparation exited ${code ?? signal}: ${stderr}`)
          );
      });
    });
    ownership.scope.defer(() => owned.retire());
    ownership.scope.track(finished);
    await owned.registered;
    child.send({ operation, input });
    return await finished;
  });
}
