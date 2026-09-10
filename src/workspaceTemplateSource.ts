import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { sha256Hex } from "@vibestudio/content-addressing";
import { GitClient, readExactGitSnapshot } from "@vibestudio/git";
import { WORKSPACE_SYSTEM_EPOCH } from "@vibestudio/shared/vcs/systemEpoch";
import { validateRootTemplateSource } from "@vibestudio/workspace/rootTemplate";
import { normalizeTemplateGitUrl } from "@vibestudio/workspace/templateCoordinates";
import type { WorkspaceTemplatePin } from "@vibestudio/workspace-contracts/types";
import { WorkspaceTemplatePinSchema } from "@vibestudio/workspace-contracts/workspaceConfigSchema";
import type { WorkspaceSource } from "@vibestudio/workspace/workspaceSources";
import { checkpointWorkspaceSource } from "./workspaceTemplateCheckpoint.js";
import { enumerateRootTemplateRepositories } from "./server/workspaceRootTemplateBootstrap.js";

export interface WorkspaceSourceInspection extends WorkspaceSource {
  sourceCheckout: string;
  changedPaths: readonly string[];
}

function git(checkout: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", checkout, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function canonicalTemplateUrlFromCheckout(checkout: string): string {
  const remote = git(checkout, ["remote", "get-url", "origin"]);
  const scp = /^git@([^:]+):(.+)$/u.exec(remote);
  const ssh = /^ssh:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/u.exec(remote);
  const transport = scp
    ? `https://${scp[1]}/${scp[2]}`
    : ssh
      ? `https://${ssh[1]}/${ssh[2]}`
      : remote;
  try {
    return normalizeTemplateGitUrl(transport);
  } catch (error) {
    throw new Error(
      `Template checkout ${checkout} origin must identify its canonical HTTP(S) remote; got ${remote}`,
      { cause: error }
    );
  }
}

export async function inspectWorkspaceSources(input: {
  checkouts: readonly string[];
  checkpointRoot: string;
}): Promise<WorkspaceSourceInspection[]> {
  const gitClient = new GitClient();
  const selections: WorkspaceSourceInspection[] = [];
  const selectedUrls = new Set<string>();
  for (const [index, requested] of input.checkouts.entries()) {
    const sourceCheckout = fs.realpathSync(path.resolve(requested));
    const url = canonicalTemplateUrlFromCheckout(sourceCheckout);
    if (selectedUrls.has(url)) {
      throw new Error(`Template checkout selected more than once for ${url}`);
    }
    selectedUrls.add(url);
    const checkpoint = await checkpointWorkspaceSource({
      checkout: sourceCheckout,
      target: path.join(input.checkpointRoot, String(index)),
    });
    const status = await gitClient.status(checkpoint.checkout);
    if (!status.commit || !status.branch) {
      throw new Error(`Development template checkpoint ${checkpoint.checkout} has no named commit`);
    }
    const snapshot = await readExactGitSnapshot({
      git: gitClient,
      dir: checkpoint.checkout,
      commit: status.commit,
      label: `development template ${url}`,
      sink: {
        async put(bytes) {
          return { digest: sha256Hex(bytes), size: bytes.byteLength };
        },
      },
      reservedPaths: "exclude",
    });
    const manifest = validateRootTemplateSource({
      workspaceId: "development-template",
      expectedSystemEpoch: WORKSPACE_SYSTEM_EPOCH,
      readFile: snapshot.readFile,
      snapshotPaths: snapshot.files.map((file) => file.path),
      repositories: enumerateRootTemplateRepositories(snapshot),
    });
    const pin = WorkspaceTemplatePinSchema.parse({
      url,
      ref: `refs/heads/${status.branch}`,
      commit: snapshot.commit,
    }) as WorkspaceTemplatePin;
    selections.push({
      ...checkpoint,
      pin,
      review: {
        ...(manifest.presentation
          ? {
              presentation: {
                name: manifest.presentation.name,
                description: manifest.presentation.description,
              },
            }
          : {}),
        ...manifest.inventory,
      },
    });
  }
  return selections;
}
