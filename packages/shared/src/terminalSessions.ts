/**
 * One of a person's terminal sessions in a workspace, as the terminal app
 * launch service (`terminalApps`) records it. Validated on the wire by
 * `TerminalSessionEntrySchema` in `@vibestudio/service-schemas/terminalApps`.
 */
export interface TerminalSessionEntry {
  sessionId: string;
  kind: "app" | "shell";
  /** `terminal-apps/<name>` for an app. */
  source?: string;
  title: string;
  /** One emoji, when the app declares it. */
  icon?: string;
  /** The app's runtime principal while it runs (approvals name it). */
  principalId?: string;
  /** The live PTY session to attach to with the shell extension. */
  shellSessionId: string | null;
  running: boolean;
  /** A lifecycle/observation failure; the known session remains actionable. */
  failure?: string;
  /** Exact semantic context shared by this session's incarnations. */
  contextId?: string;
  exit?: { code: number | null; signal?: string };
  createdAt: number;
  lastActiveAt: number;
}
