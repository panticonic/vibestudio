/**
 * Exact root template for the Electron E2E suite.
 *
 * A workspace is no longer a directory of copied files: it is one creation
 * descriptor naming the exact external root it was made from, plus the
 * materialization of that root. The suite therefore resolves the developer's
 * Base checkout into the same immutable pin the product uses (`pnpm dev` takes
 * the identical path through `prepareDevelopmentBaseCheckpoint`), materializes
 * it once per run, and lets every case copy that already-materialized tree.
 *
 * Resolution is asynchronous and Git-bound, so it happens once in
 * `globalSetup`. The result travels to the synchronous per-case workspace
 * creator through the environment, exactly like the other run-scoped paths.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { sha256Hex } from "@vibestudio/content-addressing";
import { GitClient } from "@vibestudio/git";
import { WORKSPACE_SYSTEM_EPOCH } from "@vibestudio/shared/vcs/systemEpoch";
import type { WorkspaceTemplatePin } from "@vibestudio/workspace-contracts/types";
import { resolveDevelopmentBaseSelection } from "../../src/dev/developmentBaseSelection.js";
import { seedRootTemplateSnapshotFromCheckout } from "../../src/server/acquireRootTemplateSnapshot.js";
import { WorkspaceRootTemplateBootstrap } from "../../src/server/workspaceRootTemplateBootstrap.js";

export const E2E_ROOT_TEMPLATE_ENV = "VIBESTUDIO_E2E_ROOT_TEMPLATE";
export const DEV_ROOT_TEMPLATE_ENV = "VIBESTUDIO_DEV_ROOT_TEMPLATE";
export const DEV_ROOT_TEMPLATE_CHECKOUT_ENV = "VIBESTUDIO_DEV_ROOT_TEMPLATE_CHECKOUT";
export const DEV_ROOT_TEMPLATE_WRITEBACK_ENV = "VIBESTUDIO_DEV_ROOT_TEMPLATE_WRITEBACK";

export const WORKSPACE_CREATION_DESCRIPTOR_PATH = "workspace-creation/v1.json";
export const WORKSPACE_MATERIALIZATION_RECEIPT_PATH = "workspace-creation/materialization-v1.json";

/** The run-scoped root the suite creates every workspace from. */
export interface E2eRootTemplate {
  /** The exact pin every case records in its creation descriptor. */
  pin: WorkspaceTemplatePin;
  /** Committed checkout the workspace runtime seeds its acquisition from. */
  checkout: string;
  /** Already-materialized source tree, ready to copy into a case workspace. */
  materializedSource: string;
}

// The materialized tree carries no workspace identity, so one placeholder id
// is enough to satisfy manifest parsing while preparing the shared copy.
const TEMPLATE_PREPARATION_WORKSPACE_ID = "e2e-root-template";

/** Content hashes are all the bootstrap needs here; the bytes are not retained. */
const hashOnlySink = {
  async put(bytes: Uint8Array) {
    return { digest: sha256Hex(bytes), size: bytes.byteLength };
  },
};

/**
 * Resolve and materialize the developer's Base checkout once for the whole run.
 * Dirty worktrees are handled the same way `pnpm dev` handles them: a private
 * clone owns a synthetic commit, so the developer's branch is never touched.
 */
export async function prepareE2eRootTemplate(input: {
  projectRoot: string;
  runTempRoot: string;
}): Promise<E2eRootTemplate> {
  const selection = await resolveDevelopmentBaseSelection({
    repoRoot: input.projectRoot,
    checkpointTarget: path.join(input.runTempRoot, "base-checkpoint"),
  });
  if (!selection) {
    throw new Error(
      "The Electron E2E suite needs a development Base checkout; select one with `vibestudio base use <path>`"
    );
  }
  const { pin } = selection;
  const gitClient = new GitClient();

  const templateRoot = path.join(input.runTempRoot, "root-template");
  const statePath = path.join(templateRoot, "state");
  const sourcePath = path.join(templateRoot, "source");
  fs.mkdirSync(sourcePath, { recursive: true });
  writeWorkspaceCreationDescriptor(statePath, TEMPLATE_PREPARATION_WORKSPACE_ID, pin);
  const bootstrap = new WorkspaceRootTemplateBootstrap({
    workspaceId: TEMPLATE_PREPARATION_WORKSPACE_ID,
    statePath,
    sourcePath,
    expectedSystemEpoch: WORKSPACE_SYSTEM_EPOCH,
    sink: hashOnlySink,
    acquire: (requested) =>
      seedRootTemplateSnapshotFromCheckout({
        statePath,
        checkout: selection.checkout,
        pin: requested,
        git: gitClient,
        sink: hashOnlySink,
      }),
  });
  await bootstrap.prepareSource();

  return { pin, checkout: selection.checkout, materializedSource: sourcePath };
}

/**
 * Publish the resolved root to worker processes and to the workspace runtime.
 *
 * The runtime reads the ordinary development selectors, so an E2E workspace
 * acquires its root through exactly the code path a developer launch uses.
 */
export function publishE2eRootTemplate(template: E2eRootTemplate): void {
  process.env[E2E_ROOT_TEMPLATE_ENV] = JSON.stringify(template);
  process.env[DEV_ROOT_TEMPLATE_ENV] = JSON.stringify(template.pin);
  process.env[DEV_ROOT_TEMPLATE_CHECKOUT_ENV] = template.checkout;
  // Write-back belongs to the source development instance alone; an E2E run
  // must never publish back into the developer's Base checkout.
  delete process.env[DEV_ROOT_TEMPLATE_WRITEBACK_ENV];
}

export function requireE2eRootTemplate(): E2eRootTemplate {
  const raw = process.env[E2E_ROOT_TEMPLATE_ENV];
  if (!raw) {
    throw new Error(
      `${E2E_ROOT_TEMPLATE_ENV} is not set; the Playwright global setup resolves the exact root template`
    );
  }
  return JSON.parse(raw) as E2eRootTemplate;
}

export function writeWorkspaceCreationDescriptor(
  statePath: string,
  workspaceId: string,
  pin: WorkspaceTemplatePin
): void {
  const descriptorPath = path.join(statePath, WORKSPACE_CREATION_DESCRIPTOR_PATH);
  fs.mkdirSync(path.dirname(descriptorPath), { recursive: true });
  fs.writeFileSync(
    descriptorPath,
    `${JSON.stringify({ version: 1, workspaceId, rootTemplate: pin }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
}

/**
 * Record that this workspace's source already holds the pinned tree.
 *
 * Without the receipt the runtime would re-materialize, discarding the
 * per-case source customization the fixture just applied.
 */
export function writeWorkspaceMaterializationReceipt(
  statePath: string,
  pin: WorkspaceTemplatePin
): void {
  const receiptPath = path.join(statePath, WORKSPACE_MATERIALIZATION_RECEIPT_PATH);
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  fs.writeFileSync(
    receiptPath,
    `${JSON.stringify({ version: 1, commit: pin.commit, snapshot: pin.snapshot }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
}
