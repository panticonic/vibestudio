import type { WorkspaceConfig } from "@vibestudio/workspace-contracts/types";
import { parseWorkspaceConfigContentWithId } from "@vibestudio/workspace/configParser";

const WORKSPACE_CONFIG_PATH = "meta/vibestudio.yml";

type WorkspaceConfigFile = {
  content: { kind: "text"; text: string } | { kind: "bytes"; base64: string };
};

export interface WorkspaceConfigVcsReader {
  readFile(ref: string, filePath: string): Promise<WorkspaceConfigFile | null>;
}

export function normalizeStateRef(stateHash: string): string {
  return stateHash.startsWith("state:") ? stateHash : `state:${stateHash}`;
}

export async function readWorkspaceConfigFromState(
  vcs: WorkspaceConfigVcsReader,
  workspaceId: string,
  stateHash: string
): Promise<WorkspaceConfig> {
  const ref = normalizeStateRef(stateHash);
  const file = await vcs.readFile(ref, WORKSPACE_CONFIG_PATH);
  if (!file || file.content.kind !== "text") {
    throw new Error(`${WORKSPACE_CONFIG_PATH} is missing from workspace state ${ref}`);
  }
  return parseWorkspaceConfigContentWithId(file.content.text, workspaceId);
}
