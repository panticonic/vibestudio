import type { InvocationOutcome, SubagentProgressUpdate } from "@workspace/agentic-protocol";

export type SubagentProgressEntry = SubagentProgressUpdate & { at: string };

export interface SubagentRunState {
  runId?: string;
  mode?: "fresh" | "fork";
  taskChannelId?: string;
  contextId?: string;
  parentContextId?: string | null;
  childEntityId?: string;
  label?: string;
  agentKind?: string;
  launchConfig?: Record<string, unknown> | null;
}

export interface TaskCardPayload {
  id: string;
  taskType: string;
  title: string;
  execution: {
    status: "pending" | "running" | "complete" | "error" | "cancelled" | "abandoned";
    terminalOutcome?: InvocationOutcome;
    description: string;
    progress?: SubagentProgressEntry[];
    result?: unknown;
    isError?: boolean;
  };
  subagent?: SubagentRunState;
}
