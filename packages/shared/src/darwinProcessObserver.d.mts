import type { OwnedProcessGroupMember } from "./ownedProcessIdentity.mjs";

export interface DarwinProcessRecord extends OwnedProcessGroupMember {
  startCoordinate: string;
}

export interface DarwinProcessGroupSnapshot {
  processGroupId: number;
  leader: DarwinProcessRecord | null;
  activeMemberCount: number;
  members: DarwinProcessRecord[];
  truncated: boolean;
}

export function resolveDarwinProcessObserverPath(appRoot?: string, arch?: string): string;

export function parseDarwinProcessGroupSnapshot(
  value: unknown,
  expectedProcessGroupId: number
): DarwinProcessGroupSnapshot;

export function readDarwinProcessGroupSnapshot(
  processGroupId: number,
  leaderPid: number,
  options?: {
    observerPath?: string;
    run?: (
      executable: string,
      args: string[],
      options: { encoding: "utf8" }
    ) => {
      status: number | null;
      stdout: string;
      stderr: string;
      error?: Error;
    };
  }
): DarwinProcessGroupSnapshot;
