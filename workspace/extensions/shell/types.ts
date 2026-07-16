import { z } from "zod";

export const execRequestSchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).optional().default([]),
    cwd: z.string().optional(),
    env: z.record(z.string()).optional().default({}),
    shell: z.boolean().optional().default(false),
    timeoutMs: z
      .number()
      .int()
      .min(1)
      .max(10 * 60_000)
      .optional()
      .default(30_000),
    stdin: z
      .string()
      .max(64 * 1024)
      .optional(),
    maxOutputBytes: z
      .number()
      .int()
      .min(1024)
      .max(16 * 1024 * 1024)
      .optional()
      .default(1024 * 1024),
    // When set, the run is confined to the context's materialized working folder
    // (cwd resolves within it, env/cwd default to it) instead of the workspace root.
    contextId: z.string().min(1).optional(),
    contextAttachToken: z.string().min(16).optional(),
  })
  .strict();

export const openRequestSchema = z
  .object({
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional().default([]),
    cwd: z.string().optional(),
    env: z.record(z.string()).optional().default({}),
    cols: z.number().int().min(1).max(1000).optional().default(80),
    rows: z.number().int().min(1).max(1000).optional().default(24),
    label: z.string().max(80).optional(),
    // Context-scoped placement: the session lives inside the exact semantic
    // context projection; cwd confinement is relative to that projection.
    contextId: z.string().min(1).optional(),
    contextAttachToken: z.string().min(16).optional(),
    /** Semantic input for a matched launch adapter. The shell only forwards it;
     * adapter-specific meaning remains with the owning extension. */
    launchIntent: z.record(z.unknown()).optional(),
  })
  .strict();

export const createContextRequestSchema = z
  .object({
    title: z.string().min(1).max(80).optional(),
  })
  .optional();

/** A launch adapter registered by an extension (see registerLaunchAdapter). */
export const launchAdapterSchema = z
  .object({
    id: z.string().min(1),
    match: z.object({
      /** Regex source applied to `argv.join(" ")`. */
      pattern: z.string().min(1),
    }),
    /** Detection metadata surfaced as SessionInfo.detectedAgent when matched. */
    detect: z
      .object({
        kind: z.string().min(1),
        title: z.string().optional(),
      })
      .optional(),
    /** Context-scoped launch enrichment: an extension method invoked before spawn. */
    handler: z
      .object({
        extension: z.string().min(1),
        method: z.string().min(1),
      })
      .optional(),
  })
  .strict();

export type LaunchAdapter = z.infer<typeof launchAdapterSchema>;

export const unregisterLaunchAdapterSchema = z
  .object({
    id: z.string().min(1),
  })
  .strict();

export type ExecRequest = z.infer<typeof execRequestSchema>;
export type OpenRequest = z.infer<typeof openRequestSchema>;
export type CreateContextRequest = z.infer<typeof createContextRequestSchema>;
export interface FreshContextHandle {
  contextId: string;
  contextAttachToken: string;
}
export type ScrollCursor = string;

export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut?: boolean;
  truncated?: boolean;
}

export interface SessionInfo {
  sessionId: string;
  ownerCallerId: string;
  label: string;
  command: { argv: string[]; cwd: string };
  /** Set for context-scoped sessions (placed inside a VCS context folder). */
  contextId?: string;
  revisionLabel?: string;
  pid: number;
  pgid: number;
  cols: number;
  rows: number;
  startedAt: number;
  lastActivityAt: number;
  alive: boolean;
  exit?: { code: number | null; signal?: string; at: number };
  processTree: Array<{ pid: number; ppid: number; comm: string; args: string[] }>;
  listeningPorts: Array<{
    proto: "tcp" | "tcp6" | "udp" | "udp6";
    addr: string;
    port: number;
    pid: number;
  }>;
  detectedPorts: number[];
  detectedUrls: string[];
  bytesOut: number;
  meta: Record<string, unknown>;
  // `kind` is an open string: built-in adapters seed the historical set
  // (claude-code/codex/aider/opencode/test-runner/dev-server) but extensions
  // register arbitrary kinds via registerLaunchAdapter.
  detectedAgent?: { kind: string; title?: string };
}

export type SessionInfoEvent =
  | { type: "snapshot-batch"; sessions: SessionInfo[] }
  | { type: "snapshot"; sessionId: string; info: SessionInfo }
  | { type: "opened"; sessionId: string; info: SessionInfo }
  | { type: "exit"; sessionId: string; exit: { code: number | null; signal?: string; at: number } }
  | { type: "disposed"; sessionId: string }
  | { type: "heartbeat"; at: number };
