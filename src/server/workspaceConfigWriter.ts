import YAML from "yaml";
import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import type { WorkspaceConfig } from "@vibestudio/workspace-contracts/types";
import { parseWorkspaceConfigContent } from "@vibestudio/workspace/loader";
import { mirrorWorktreeTree, putBytes } from "./services/blobstoreService.js";
import {
  isRefConflictError,
  type ProtectedRefStore,
  type MainRefOperation,
} from "./services/protectedRefStore.js";

const META_REPO_PATH = "meta";
const WORKSPACE_CONFIG_FILE = "vibestudio.yml";
const REGULAR_FILE_MODE = 33188;

type WorkspaceConfigFile = {
  content: { kind: "text"; text: string } | { kind: "bytes"; base64: string };
};

type WorkspaceConfigVcs = {
  readFile(ref: string, filePath: string): Promise<WorkspaceConfigFile | null>;
  listFiles(ref: string): Promise<Array<{ path: string; contentHash: string; mode: number }>>;
  ensureRepoLogsFromDisk?(): Promise<void>;
};

export interface WorkspaceConfigMainWriter {
  wouldMutate(mutate: WorkspaceConfigMutation): Promise<boolean>;
  applyMutation(input: {
    ctx: ServiceContext;
    mutate: WorkspaceConfigMutation;
    summary: string;
    operation: Extract<MainRefOperation, "push" | "import">;
  }): Promise<WorkspaceConfigMutationResult>;
}

export type WorkspaceConfigMutation = (currentConfig: WorkspaceConfig) => WorkspaceConfig;

export interface WorkspaceConfigMutationResult {
  changed: boolean;
  nextConfig: WorkspaceConfig;
}

export function createWorkspaceConfigMainWriter(deps: {
  workspacePath: string;
  blobsDir: string;
  refs: Pick<ProtectedRefStore, "readMain">;
  vcs: WorkspaceConfigVcs;
  /** Publish through the GAD writer DO so protected refs and recorded main
   * provenance advance atomically under a durable write-ahead intent. */
  publishMain(input: {
    ctx: ServiceContext;
    expectedOld: string;
    files: Array<{ path: string; contentHash: string; mode: number }>;
    summary: string;
    operation: Extract<MainRefOperation, "push" | "import">;
  }): Promise<{ stateHash: string }>;
}): WorkspaceConfigMainWriter {
  let mutationQueue = Promise.resolve();

  const readCurrentMeta = async (): Promise<{ stateHash: string; content: string }> => {
    let metaMain = deps.refs.readMain(META_REPO_PATH);
    if (!metaMain && deps.vcs.ensureRepoLogsFromDisk) {
      await deps.vcs.ensureRepoLogsFromDisk();
      metaMain = deps.refs.readMain(META_REPO_PATH);
    }
    if (!metaMain) {
      throw new Error("Cannot persist workspace config: protected meta/main is not initialized");
    }
    const file = await deps.vcs.readFile(metaMain.stateHash, WORKSPACE_CONFIG_FILE);
    if (!file || file.content.kind !== "text") {
      throw new Error(
        `Cannot persist workspace config: ${META_REPO_PATH}/${WORKSPACE_CONFIG_FILE} is missing from protected main`
      );
    }
    return { stateHash: metaMain.stateHash, content: file.content.text };
  };

  const renderMutation = async (
    mutate: WorkspaceConfigMutation
  ): Promise<{
    currentStateHash: string;
    currentContent: string;
    nextContent: string;
    nextConfig: WorkspaceConfig;
  }> => {
    const current = await readCurrentMeta();
    const currentConfig = parseWorkspaceConfigContent(current.content, deps.workspacePath);
    const nextConfig = mutate(currentConfig);
    return {
      currentStateHash: current.stateHash,
      currentContent: current.content,
      nextContent: renderWorkspaceConfigYaml(current.content, nextConfig, deps.workspacePath),
      nextConfig,
    };
  };

  const applyMutation = async (
    input: Parameters<WorkspaceConfigMainWriter["applyMutation"]>[0]
  ): Promise<WorkspaceConfigMutationResult> => {
    // Conflicts can only come from another protected meta/main writer. Re-read
    // and reapply the narrow mutation instead of replaying a stale snapshot.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const rendered = await renderMutation(input.mutate);
      if (rendered.currentContent === rendered.nextContent) {
        return { changed: false, nextConfig: rendered.nextConfig };
      }

      const existingFiles = await deps.vcs.listFiles(rendered.currentStateHash);
      const { digest } = await putBytes(deps.blobsDir, Buffer.from(rendered.nextContent, "utf8"));
      let replaced = false;
      const nextFiles = existingFiles.map((file) => {
        if (file.path !== WORKSPACE_CONFIG_FILE) return file;
        replaced = true;
        return { ...file, contentHash: digest };
      });
      if (!replaced) {
        nextFiles.push({
          path: WORKSPACE_CONFIG_FILE,
          contentHash: digest,
          mode: REGULAR_FILE_MODE,
        });
      }
      nextFiles.sort((a, b) => a.path.localeCompare(b.path));

      const nextState = await mirrorWorktreeTree(deps.blobsDir, nextFiles);
      if (nextState.stateHash === rendered.currentStateHash) {
        return { changed: false, nextConfig: rendered.nextConfig };
      }

      try {
        const published = await deps.publishMain({
          ctx: input.ctx,
          expectedOld: rendered.currentStateHash,
          files: nextFiles,
          summary: input.summary,
          operation: input.operation,
        });
        if (published.stateHash !== nextState.stateHash) {
          throw new Error(
            `Workspace config publish hash mismatch: staged ${nextState.stateHash}, published ${published.stateHash}`
          );
        }
        return { changed: true, nextConfig: rendered.nextConfig };
      } catch (error) {
        if (!isRefConflictError(error) || attempt === 4) throw error;
      }
    }
    throw new Error("Workspace config mutation retry budget exhausted");
  };

  return {
    async wouldMutate(mutate) {
      const rendered = await renderMutation(mutate);
      return rendered.currentContent !== rendered.nextContent;
    },

    applyMutation(input) {
      const run = mutationQueue.then(
        () => applyMutation(input),
        () => applyMutation(input)
      );
      mutationQueue = run.then(
        () => undefined,
        () => undefined
      );
      return run;
    },
  };
}

export function renderWorkspaceConfigYaml(
  currentContent: string,
  nextConfig: WorkspaceConfig,
  workspacePath: string
): string {
  const beforeParsed = (YAML.parse(currentContent) as Record<string, unknown> | null) ?? {};
  const nextContent = YAML.stringify({ ...beforeParsed, ...nextConfig });
  parseWorkspaceConfigContent(nextContent, workspacePath);
  return nextContent;
}
