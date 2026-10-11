import { spawn } from "node:child_process";
import path from "node:path";
import { joinChildProcess } from "./lib/join-child-process.mjs";

/** One producer owns source publication and exhaustive compilation. Launchers
 * may proceed at sourcesReady; packagers require completed. Every caller must
 * stop and join the producer before retiring its source or output directories.
 * @param {{ appRoot: string, output: string, scratch: string, env: NodeJS.ProcessEnv, executable: string, entry: string }} input
 */
export function prepareWorkspaceRelease(input) {
  const child = spawn(
    input.executable,
    [
      input.entry,
      "--app-root",
      input.appRoot,
      "--output",
      input.output,
      "--scratch",
      input.scratch,
    ],
    { cwd: path.dirname(input.entry), env: input.env, stdio: ["ignore", "pipe", "pipe", "ipc"] }
  );
  let resolveReady, rejectReady;
  const sourcesReady = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let ready = false,
    failure,
    cancellation,
    tail = "";
  for (const [stream, target] of [
    [child.stdout, process.stdout],
    [child.stderr, process.stderr],
  ]) {
    stream.on("data", (chunk) => {
      tail = (tail + chunk).slice(-8192);
      target.write(chunk);
    });
  }
  child.on("message", (message) => {
    if (message?.kind === "sources-ready" && !ready && !cancellation) {
      ready = true;
      input.env["VIBESTUDIO_WORKSPACE_RELEASE_ROOT"] = input.output;
      resolveReady();
    } else if (message?.kind === "failed") {
      failure ??= Object.assign(new Error(message.message), {
        code: message.code,
        stack: message.stack,
      });
    }
  });
  const interrupt = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    cancellation ??= new Error("Workspace release preparation cancelled");
    child.kill("SIGTERM");
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  const completed = joinChildProcess(child)
    .then((result) => {
      if (failure && failure.code !== "ECANCELLED") throw failure;
      if (cancellation) throw cancellation;
      if (failure) throw failure;
      if (result.error) throw result.error;
      if (result.code !== 0)
        throw new Error(
          `Workspace release preparation exited (${result.signal ?? result.code}): ${tail}`
        );
      if (!ready) throw new Error("Workspace release producer exited without publishing sources");
    })
    .catch((error) => {
      rejectReady(error);
      throw error;
    })
    .finally(() => {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
    });
  // Readiness and completion have different consumers. Keep failures observable
  // without an unhandled rejection while a caller is awaiting the other phase.
  void sourcesReady.catch(() => {});
  void completed.catch(() => {});
  return {
    sourcesReady,
    completed,
    async stop() {
      interrupt();
      try {
        await completed;
      } catch (error) {
        // Completion reports preparation failure; stop establishes retirement.
        // Retain state only when the native owner could not acknowledge exit.
        if (error.code === "EOWNERSHIP") throw error;
      }
    },
  };
}
