export interface ProcessTreeTerminationResult {
  gone: boolean;
  escalated: boolean;
  detail?: string;
}
export function processTreeAlive(pid: number, platform?: NodeJS.Platform): boolean;
export function terminateOwnedProcessTree(
  pid: number,
  options?: {
    termTimeoutMs?: number;
    killTimeoutMs?: number;
    platform?: NodeJS.Platform;
  }
): Promise<ProcessTreeTerminationResult>;
