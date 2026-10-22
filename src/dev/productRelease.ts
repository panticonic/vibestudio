import {
  prepareWorkspaceRelease,
  type WorkspaceReleasePreparation,
} from "../../scripts/prepare-workspace-release.mjs";
import { readCurrentHostBuildGeneration } from "../../scripts/host-build-generations.mjs";
import * as path from "node:path";
import { CentralDataManager } from "@vibestudio/shared/centralData";
import { getProfileDataPath } from "@vibestudio/env-paths";
import type { Ownership } from "@vibestudio/shared/ownership";
import { runOwnedChild, type LaunchTermination } from "./launchTermination.js";
import { resolveDevelopmentTemplateSet } from "./developmentTemplateSet.js";
import { productLaunchEnvironment } from "./productLaunch.js";
import {
  inspectWorkspaceSources,
  workspaceSourceFromCheckout,
} from "../workspaceTemplateSource.js";

function profileHasWorkspace(): boolean {
  const centralData = new CentralDataManager({
    databasePath: path.join(getProfileDataPath(), "server-auth", "identity.db"),
  });
  try {
    return centralData.listWorkspaces().length > 0;
  } finally {
    centralData.close();
  }
}

export interface ProductRelease {
  /** The environment a product launch runs under, including its release root. */
  env: NodeJS.ProcessEnv;
  /** Checkouts the caller selected on top of the canonical set. */
  developmentTemplates: Awaited<ReturnType<typeof inspectWorkspaceSources>>;
}

/**
 * Prepare, exactly as the packager does for an installed product, the complete
 * workspace release: every template's source phase and every runtime it
 * declares, built and sealed before any workspace boots. The only difference
 * from an installed product is where the template pins come from: the
 * canonical checkouts as they are now, instead of the published tags.
 *
 * The release lands in the shared derived cache keyed by the host build and
 * the exact template sources, so a launch whose inputs did not change projects
 * the finished release and builds nothing. `pnpm build:product` runs this
 * ahead of time; `pnpm start` runs it again and normally finds it done.
 *
 * The producer is handed to `register` the moment it exists, even if it later
 * fails: the caller stops and joins it (`joinProducer`) before retiring
 * `temporaryRoot`, and a termination request can stop it while it runs.
 */
export async function prepareProductRelease(input: {
  ownership: Ownership;
  termination: LaunchTermination;
  repoRoot: string;
  temporaryRoot: string;
  templateCheckouts: readonly string[];
  register: (preparation: WorkspaceReleasePreparation) => void;
}): Promise<ProductRelease> {
  const { ownership, termination, repoRoot, temporaryRoot } = input;
  const defaultTemplates =
    (await resolveDevelopmentTemplateSet({
      repoRoot,
      checkpointRoot: path.join(temporaryRoot, "default-template-checkpoints"),
    })) ?? undefined;
  if (!defaultTemplates) {
    throw new Error(
      "A source product launch needs the canonical template checkouts. Run `pnpm dev:templates setup`."
    );
  }
  const developmentTemplates = await inspectWorkspaceSources({
    sources: input.templateCheckouts.map(workspaceSourceFromCheckout),
    checkpointRoot: path.join(temporaryRoot, "template-checkpoints"),
  });

  const env = productLaunchEnvironment({
    parent: process.env,
    repoRoot,
    defaultTemplates,
    bootstrapSystem: !profileHasWorkspace(),
    ...(developmentTemplates.length ? { templates: developmentTemplates } : {}),
  });
  await runOwnedChild(
    ownership,
    process.execPath,
    ["scripts/native-host-dependencies.mjs", "--repair"],
    { env, termination }
  );
  await runOwnedChild(ownership, process.execPath, ["scripts/ensure-host-build.mjs"], {
    env,
    termination,
  });
  env["VIBESTUDIO_HOST_ARTIFACT_ROOT"] = readCurrentHostBuildGeneration(repoRoot, "desktop");
  termination.signal.throwIfAborted();
  const preparation = prepareWorkspaceRelease({
    ownership,
    executable: process.execPath,
    entry: path.join(env["VIBESTUDIO_HOST_ARTIFACT_ROOT"]!, "prepare-workspace-templates.mjs"),
    appRoot: repoRoot,
    output: path.join(temporaryRoot, "workspace-release"),
    scratch: path.join(temporaryRoot, "template-preparation"),
    env,
  });
  input.register(preparation);
  await preparation.completed;
  termination.signal.throwIfAborted();
  return { env, developmentTemplates };
}
