import { getProfileDataPath } from "@vibestudio/env-paths";
import { Ownership, OWNERSHIP_PARENT_ENV } from "@vibestudio/shared/ownership";

let opening: Promise<Ownership> | undefined;
/** Admit the worker's entire process lifetime before it creates fixture bytes.
 * The trusted run descriptor opts in to owner-process retirement across PIDs;
 * same-process/thread claims close cooperatively and never signal themselves. */
export async function ownTestWorker(): Promise<Ownership | null> {
  if (!process.env[OWNERSHIP_PARENT_ENV]) return null;
  opening ??= Ownership.open({
    profileDir: getProfileDataPath(),
    lifetime: "leased",
    parent: { ...JSON.parse(process.env[OWNERSHIP_PARENT_ENV]!), terminateOwner: true },
    meta: { role: "test-worker" },
  });
  return opening;
}
export async function releaseTestWorker(): Promise<void> {
  const pending = opening;
  opening = undefined;
  if (pending) await (await pending).release();
}
