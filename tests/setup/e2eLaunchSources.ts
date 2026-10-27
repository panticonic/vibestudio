import path from "node:path";
import { Ownership } from "@vibestudio/shared/ownership";
import { prepareWorkspaceRelease } from "../../scripts/prepare-workspace-release.mjs";
import { runOwnedCleanupSteps, runWithOwnedCleanup } from "../../scripts/lib/owned-cleanup.mjs";

/** Publish the exact case's sources, using its runtime's dependency policy. */
export async function prepareE2eLaunchSources(input: {
  projectRoot: string;
  hostGeneration: string;
  testRoot: string;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const ownership = await Ownership.open({
    profileDir: path.join(input.testRoot, "source-profile"),
    lifetime: "leased",
    meta: { kind: "e2e-workspace-sources" },
  });
  let preparation: ReturnType<typeof prepareWorkspaceRelease> | undefined;
  await runWithOwnedCleanup(
    async () => {
      // Case-specific pins include source customizations. An inherited completed
      // release belongs to a different input set and cannot supply this case.
      delete input.env["VIBESTUDIO_WORKSPACE_RELEASE_ROOT"];
      preparation = prepareWorkspaceRelease({
        ownership,
        scope: "sources",
        executable: process.execPath,
        entry: path.join(input.hostGeneration, "prepare-workspace-templates.mjs"),
        appRoot: input.projectRoot,
        output: path.join(input.testRoot, "workspace-sources"),
        scratch: path.join(input.testRoot, "source-preparation"),
        env: input.env,
      });
      await preparation.completed;
    },
    () =>
      runOwnedCleanupSteps(
        [() => preparation?.stop(), () => ownership.release()],
        "E2E source preparation cleanup failed"
      ),
    "E2E source preparation and cleanup failed"
  );
  // Prepared artifacts belong to the case, whose existing cleanup ledger keeps
  // them until its desktop and workspace processes have all stopped.
}
