import { spawn } from "node:child_process";
import { createOwnedProcessGroupReceiver } from "@vibestudio/shared/ownedProcessRegistration";
import { tsImport } from "tsx/esm/api";

const { OwnedProcessGroup } = await tsImport(
  "@vibestudio/shared/ownedProcessGroup",
  import.meta.url
);

/** Run resource ownership behind an IPC lease, so a killed launcher cannot
 * skip the owner's finally block. The owner remains alive to retire its
 * children and storage when the kernel revokes that lease. */
export async function runParentOwnedMain(main) {
  if (process.send) {
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("disconnect", stop);
    if (!process.connected) stop();
    try {
      await main(controller.signal);
    } finally {
      process.off("disconnect", stop);
      if (process.connected) process.disconnect();
    }
    return;
  }

  const child = spawn(process.execPath, process.argv.slice(1), {
    cwd: process.cwd(),
    env: process.env,
    detached: process.platform !== "win32",
    stdio: ["inherit", "inherit", "inherit", "ipc"],
  });
  child.on("error", () => undefined);
  const exited = new Promise((resolve, reject) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", reject);
  });
  const owner = child.pid === undefined ? null : OwnedProcessGroup.create(child);
  const registered = owner?.identity
    ? createOwnedProcessGroupReceiver(child, owner.identity, (identity) =>
        OwnedProcessGroup.adopt(identity)
      )
    : null;
  const stop = () => {
    if (child.connected) child.disconnect();
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(signal, stop);
  try {
    const result = await exited;
    process.exitCode = result.code ?? 1;
  } finally {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.off(signal, stop);
    const results = await Promise.allSettled([owner?.retire(), registered?.close()]);
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    );
    if (failures.length)
      throw new AggregateError(failures, "Parent-owned execution did not retire");
  }
}
