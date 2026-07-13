import type { WorkspaceConfig } from "@vibestudio/workspace-contracts/types";
import { parseWorkspaceConfigContent } from "@vibestudio/workspace/loader";

const WORKSPACE_CONFIG_PATH = "meta/vibestudio.yml";

type WorkspaceConfigFile = {
  content: { kind: "text"; text: string } | { kind: "bytes"; base64: string };
};

export interface WorkspaceConfigVcsReader {
  readFile(ref: string, filePath: string): Promise<WorkspaceConfigFile | null>;
}

export interface StartupWorkspaceConfigVcsReader extends WorkspaceConfigVcsReader {
  repositories: { workspaceView(): Promise<{ stateHash: string }> };
  ensureFresh(): Promise<{ stateHash: string }>;
}

export interface StartupMainRefReader {
  listMains(): ReadonlyArray<unknown>;
}

export interface StartupWorkspaceConfigResult {
  config: WorkspaceConfig;
  stateHash: string;
  source: "protected-main" | "disk-snapshot";
}

export function normalizeStateRef(stateHash: string): string {
  return stateHash.startsWith("state:") ? stateHash : `state:${stateHash}`;
}

export async function readWorkspaceConfigFromState(
  vcs: WorkspaceConfigVcsReader,
  workspacePath: string,
  stateHash: string
): Promise<WorkspaceConfig> {
  const ref = normalizeStateRef(stateHash);
  const file = await vcs.readFile(ref, WORKSPACE_CONFIG_PATH);
  if (!file || file.content.kind !== "text") {
    throw new Error(`${WORKSPACE_CONFIG_PATH} is missing from workspace state ${ref}`);
  }
  return parseWorkspaceConfigContent(file.content.text, workspacePath);
}

export async function readStartupWorkspaceConfig(
  vcs: StartupWorkspaceConfigVcsReader,
  refs: StartupMainRefReader,
  workspacePath: string
): Promise<StartupWorkspaceConfigResult> {
  if (refs.listMains().length > 0) {
    const view = await vcs.repositories.workspaceView();
    return {
      source: "protected-main",
      stateHash: view.stateHash,
      config: await readWorkspaceConfigFromState(vcs, workspacePath, view.stateHash),
    };
  }

  const local = await vcs.ensureFresh();
  return {
    source: "disk-snapshot",
    stateHash: local.stateHash,
    config: await readWorkspaceConfigFromState(vcs, workspacePath, local.stateHash),
  };
}
