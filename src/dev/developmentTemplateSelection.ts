import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { sha256Hex } from "@vibestudio/content-addressing";
import { GitClient, readExactGitSnapshot } from "@vibestudio/git";
import { WORKSPACE_SYSTEM_EPOCH } from "@vibestudio/shared/vcs/systemEpoch";
import {
  parseTemplateManifestContent,
  validateTemplateSnapshotInventory,
} from "@vibestudio/workspace/templateManifest";
import { normalizeTemplateGitUrl } from "@vibestudio/workspace/templateCoordinates";
import type { WorkspaceTemplatePin } from "@vibestudio/workspace-contracts/types";
import { WorkspaceTemplatePinSchema } from "@vibestudio/workspace-contracts/workspaceConfigSchema";
import { prepareDevelopmentTemplateCheckpoint } from "./developmentTemplateCheckpoint.js";

export interface DevelopmentTemplateSelection {
  pin: WorkspaceTemplatePin;
  checkout: string;
  sourceCheckout: string;
  temporary: boolean;
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

export async function resolveDevelopmentTemplateSelections(input: {
  checkouts: readonly string[];
  checkpointRoot: string;
}): Promise<DevelopmentTemplateSelection[]> {
  const gitClient = new GitClient();
  const selections: DevelopmentTemplateSelection[] = [];
  const selectedUrls = new Set<string>();
  for (const [index, requested] of input.checkouts.entries()) {
    const sourceCheckout = fs.realpathSync(path.resolve(requested));
    const url = canonicalTemplateUrlFromCheckout(sourceCheckout);
    if (selectedUrls.has(url)) {
      throw new Error(`Template checkout selected more than once for ${url}`);
    }
    selectedUrls.add(url);
    const checkpoint = await prepareDevelopmentTemplateCheckpoint({
      checkout: sourceCheckout,
      target: path.join(input.checkpointRoot, String(index)),
      gitClient,
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
    const manifestBytes = snapshot.readFile("meta/template.yml");
    if (!manifestBytes)
      throw new Error(`Template checkout ${sourceCheckout} has no meta/template.yml`);
    const manifest = parseTemplateManifestContent(
      new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes),
      WORKSPACE_SYSTEM_EPOCH
    );
    validateTemplateSnapshotInventory(
      manifest.inventory,
      snapshot.files.map((file) => file.path)
    );
    if (manifest.dependencies.length === 0) {
      throw new Error(
        `Development template ${url} is root-capable; select it with --base-checkout instead`
      );
    }
    if (snapshot.readFile("meta/vibestudio.yml")) {
      throw new Error(`Contribution template ${url} must not contain meta/vibestudio.yml`);
    }
    const pin = WorkspaceTemplatePinSchema.parse({
      url,
      ref: `refs/heads/${status.branch}`,
      commit: snapshot.commit,
      snapshot: snapshot.snapshot,
    }) as WorkspaceTemplatePin;
    selections.push({ ...checkpoint, pin });
  }
  return selections;
}
