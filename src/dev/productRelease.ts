import {
  prepareWorkspaceRelease,
  type WorkspaceReleasePreparation,
} from "../../scripts/prepare-workspace-release.mjs";
import { readCurrentHostBuildGeneration } from "../../scripts/host-build-generations.mjs";
import * as path from "node:path";
import {
  computeHostBuildFingerprint,
  readHostBuildFingerprint,
  sameHostBuildFingerprint,
} from "../../scripts/host-build-fingerprint.mjs";
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

interface ProductReleaseInput {
  ownership: Ownership;
  termination: LaunchTermination;
  repoRoot: string;
  temporaryRoot: string;
  templateCheckouts: readonly string[];
  register: (preparation: WorkspaceReleasePreparation) => void;
}

/** Build and seal the complete release ahead of a product launch. */
export function prepareProductRelease(input: ProductReleaseInput): Promise<ProductRelease> {
  return resolveProductRelease(input, buildProductHost, "release");
}

/** Launch consumes exact completed artifacts and has no compilation fallback. */
export function loadProductRelease(input: ProductReleaseInput): Promise<ProductRelease> {
  return resolveProductRelease(input, verifyProductHost, "existing");
}

async function buildProductHost(
  input: ProductReleaseInput,
  env: NodeJS.ProcessEnv
): Promise<string> {
  await runOwnedChild(
    input.ownership,
    process.execPath,
    ["scripts/native-host-dependencies.mjs", "--repair"],
    { env, termination: input.termination }
  );
  await runOwnedChild(input.ownership, process.execPath, ["scripts/ensure-host-build.mjs"], {
    env,
    termination: input.termination,
  });
  return readCurrentHostBuildGeneration(input.repoRoot, "desktop");
}

async function verifyProductHost(
  input: ProductReleaseInput,
  env: NodeJS.ProcessEnv
): Promise<string> {
  let root: string;
  try {
    root = readCurrentHostBuildGeneration(input.repoRoot, "desktop");
    const expected = computeHostBuildFingerprint({ cwd: input.repoRoot, mode: "production" });
    const actual = readHostBuildFingerprint(root, "host-build-fingerprint.json");
    if (!sameHostBuildFingerprint(actual, expected) || actual?.inputCount !== expected.inputCount) {
      throw new Error("Host artifacts do not match the current source snapshot.");
    }
  } catch (cause) {
    throw new Error(
      "Product host build is missing or stale. Run pnpm build:product before starting.",
      {
        cause,
      }
    );
  }
  await runOwnedChild(input.ownership, process.execPath, ["scripts/native-host-dependencies.mjs"], {
    env,
    termination: input.termination,
  });
  return root;
}

async function resolveProductRelease(
  input: ProductReleaseInput,
  prepareHost: (input: ProductReleaseInput, env: NodeJS.ProcessEnv) => Promise<string>,
  scope: "release" | "existing"
): Promise<ProductRelease> {
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
  env["VIBESTUDIO_HOST_ARTIFACT_ROOT"] = await prepareHost(input, env);
  termination.signal.throwIfAborted();
  const preparation = prepareWorkspaceRelease({
    ownership,
    scope,
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
