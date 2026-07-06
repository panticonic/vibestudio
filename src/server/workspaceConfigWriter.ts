import YAML from "yaml";
import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import type { WorkspaceConfig } from "@vibestudio/shared/workspace/types";
import { parseWorkspaceConfigContent } from "@vibestudio/shared/workspace/loader";
import { mirrorWorktreeTree, putBytes } from "./services/blobstoreService.js";
import type { RefService, MainRefOperation } from "./services/refService.js";

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
  wouldChange(nextConfig: WorkspaceConfig): Promise<boolean>;
  persist(input: {
    ctx: ServiceContext;
    nextConfig: WorkspaceConfig;
    summary: string;
    operation: Extract<MainRefOperation, "push" | "import">;
  }): Promise<boolean>;
}

export function createWorkspaceConfigMainWriter(deps: {
  workspacePath: string;
  blobsDir: string;
  refs: Pick<RefService, "readMain" | "updateMains">;
  vcs: WorkspaceConfigVcs;
}): WorkspaceConfigMainWriter {
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

  const renderNext = async (
    nextConfig: WorkspaceConfig
  ): Promise<{ currentStateHash: string; currentContent: string; nextContent: string }> => {
    const current = await readCurrentMeta();
    return {
      currentStateHash: current.stateHash,
      currentContent: current.content,
      nextContent: renderWorkspaceConfigYaml(current.content, nextConfig, deps.workspacePath),
    };
  };

  return {
    async wouldChange(nextConfig) {
      const rendered = await renderNext(nextConfig);
      return rendered.currentContent !== rendered.nextContent;
    },

    async persist(input) {
      const rendered = await renderNext(input.nextConfig);
      if (rendered.currentContent === rendered.nextContent) return false;

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
      if (nextState.stateHash === rendered.currentStateHash) return false;

      await deps.refs.updateMains({
        entries: [
          {
            repoPath: META_REPO_PATH,
            expectedOld: rendered.currentStateHash,
            next: nextState.stateHash,
          },
        ],
        gateContext: {
          kind: "system",
          actor: {
            id: input.ctx.caller.runtime.id,
            kind: input.ctx.caller.runtime.kind,
          },
        },
        operation: input.operation,
        reason: input.summary,
        writer: "server:gitInterop",
        onBehalfOf: input.ctx.caller,
      });
      return true;
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
