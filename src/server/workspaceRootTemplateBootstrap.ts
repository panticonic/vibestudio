import * as fs from "node:fs";
import * as path from "node:path";
import {
  canonicalSnapshotDigest,
  compareUtf16CodeUnits,
  type CanonicalSnapshotDigest,
} from "@vibestudio/content-addressing";
import type { ExactGitSnapshot, ExactSnapshotFile } from "@vibestudio/git";
import { parseWorkspaceConfigContentWithId } from "@vibestudio/workspace/configParser";
import { WorkspaceCreationDescriptorSchema } from "@vibestudio/workspace-contracts/workspaceConfigSchema";
import type {
  WorkspaceCreationDescriptor,
  WorkspaceTemplatePin,
} from "@vibestudio/workspace-contracts/types";
import { discoverRepos } from "./vcsHost/repoDiscovery.js";

const CREATION_DESCRIPTOR_PATH = "workspace-creation/v1.json";
const WORKSPACE_MANIFEST_PATH = "meta/vibestudio.yml";

export interface RootTemplateRepository {
  repoPath: string;
  subdir: string;
  snapshot: CanonicalSnapshotDigest;
  files: ExactSnapshotFile[];
}

export interface PreparedRootTemplateInitialization {
  pin: WorkspaceTemplatePin;
  repositories: RootTemplateRepository[];
}

export interface WorkspaceRootTemplateBootstrapDeps {
  workspaceId: string;
  statePath: string;
  acquire(pin: WorkspaceTemplatePin): Promise<ExactGitSnapshot>;
}

function repositorySnapshot(files: readonly ExactSnapshotFile[]): CanonicalSnapshotDigest {
  return canonicalSnapshotDigest(
    files.map((file) => ({
      path: file.path,
      mode: file.mode === 0o755 ? 0o100755 : 0o100644,
      size: file.size,
      contentHash: file.contentHash,
    }))
  );
}

/**
 * Split one verified root snapshot into the semantic repositories it contains.
 * Files outside workspace source sections are repository tooling and remain
 * outside the imported workspace tree.
 */
export function enumerateRootTemplateRepositories(
  snapshot: ExactGitSnapshot
): RootTemplateRepository[] {
  const repositories: RootTemplateRepository[] = [];
  for (const repository of discoverRepos(snapshot.files.map((file) => file.path))) {
    const prefix = repository.repoPath === "meta" ? "meta/" : `${repository.repoPath}/`;
    const files = snapshot.files
      .filter((file) => file.path.startsWith(prefix))
      .map((file) => ({ ...file, path: file.path.slice(prefix.length) }))
      .sort((left, right) => compareUtf16CodeUnits(left.path, right.path));
    repositories.push({
      repoPath: repository.repoPath,
      subdir: repository.repoPath,
      snapshot: repositorySnapshot(files),
      files,
    });
  }
  return repositories;
}

/**
 * The entire host-side template boundary: if workspace creation carries one
 * exact root pin, acquire that one immutable snapshot and expose its ordinary
 * workspace repositories for the initial semantic publication. There is no
 * dependency walk, lock generation, layering, conflict policy, or lifecycle
 * state here; those begin only after the imported workspace can run userland.
 */
export class WorkspaceRootTemplateBootstrap {
  private readonly descriptorPath: string;

  constructor(private readonly deps: WorkspaceRootTemplateBootstrapDeps) {
    this.descriptorPath = path.join(deps.statePath, CREATION_DESCRIPTOR_PATH);
  }

  async prepareInitialization(): Promise<PreparedRootTemplateInitialization | null> {
    const descriptor = this.readDescriptor();
    if (!descriptor) return null;
    const snapshot = await this.deps.acquire(descriptor.rootTemplate);
    if (
      snapshot.commit !== descriptor.rootTemplate.commit ||
      snapshot.snapshot !== descriptor.rootTemplate.snapshot
    ) {
      throw new Error(
        `Root template acquisition returned coordinates different from the creation descriptor`
      );
    }
    const manifestBytes = snapshot.readFile(WORKSPACE_MANIFEST_PATH);
    if (!manifestBytes) {
      throw new Error(`Root template is missing ${WORKSPACE_MANIFEST_PATH}`);
    }
    const manifest = new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes);
    parseWorkspaceConfigContentWithId(manifest, this.deps.workspaceId);
    const repositories = enumerateRootTemplateRepositories(snapshot);
    if (!repositories.some((repository) => repository.repoPath === "meta")) {
      throw new Error(`Root template has no importable meta repository`);
    }
    return {
      pin: descriptor.rootTemplate,
      repositories,
    };
  }

  private readDescriptor(): WorkspaceCreationDescriptor | null {
    if (!fs.existsSync(this.descriptorPath)) return null;
    const descriptor = WorkspaceCreationDescriptorSchema.parse(
      JSON.parse(fs.readFileSync(this.descriptorPath, "utf8"))
    );
    if (descriptor.workspaceId !== this.deps.workspaceId) {
      throw new Error(
        `Workspace creation descriptor belongs to ${descriptor.workspaceId}, expected ${this.deps.workspaceId}`
      );
    }
    return descriptor;
  }
}
