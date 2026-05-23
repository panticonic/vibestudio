import type { SessionInfo } from "./types.js";
import { liveSessionCwd } from "./vscodeShellIntegrationMeta.js";

export function documentTitleForSession(session: SessionInfo | undefined): string {
  if (!session) return "Terminal";
  const cwd = liveSessionCwd(session) ?? session.command.cwd;
  const label = session.label.trim();
  const argvLabel = session.command.argv.join(" ").trim();
  if (label && label !== session.sessionId && label !== "Shell" && label !== argvLabel) {
    return compactHomePath(label);
  }
  return compactHomePath(cwd || label || "Terminal");
}

export function compactHomePath(value: string): string {
  const trimmed = value.trim();
  const posix = /^\/(?:home|Users)\/([^/\s]+)(\/.*)?$/.exec(trimmed);
  if (posix) return `~${posix[2] ?? ""}`;
  const windows = /^[A-Za-z]:\\Users\\([^\\\s]+)(\\.*)?$/.exec(trimmed);
  if (windows) return `~${windows[2] ?? ""}`;
  return value;
}
