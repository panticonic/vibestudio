import type { ExecFileException } from "node:child_process";

/**
 * rsync exit 24 means a source file disappeared while the scan was running.
 * Workspace writes use atomic temporary files, so that is a successful
 * best-effort mirror: the committed replacement is present and the transient
 * staging pathname was never part of the workspace state to preserve.
 */
export function isSuccessfulDevTemplateMirrorExit(error: ExecFileException | null): boolean {
  return error === null || error.code === 24;
}
