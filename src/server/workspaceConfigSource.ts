import type { WorkspaceConfig } from "@vibestudio/workspace-contracts/types";
import { readWorkspaceConfig } from "@vibestudio/workspace/configParser";

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
  return readWorkspaceConfig(
    {
      readText: async (filePath) => {
        const file = await vcs.readFile(ref, filePath);
        return file?.content.kind === "text" ? file.content.text : null;
      },
    },
    workspaceId
  ).catch((error) => {
    throw new Error(
      `Cannot read workspace configuration from ${ref}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  });
}
