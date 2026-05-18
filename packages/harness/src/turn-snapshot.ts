/**
 * TurnSnapshot - NatStack's turn-boundary view of the harness state.
 *
 * The worker can inspect this snapshot when refreshing model, thinking level,
 * and roster choices between harness save points.
 */

import type { AgentMessage, AgentTool, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";

export interface TurnSnapshot {
  /** Session leaf at the moment the snapshot was built. */
  sessionLeafId: string | null;
  /** Transcript visible to the model at turn start. */
  messages: AgentMessage[];
  /** Composed system prompt active for this run. */
  systemPrompt: string;
  /** Provider model selected for this run. */
  model: Model<any>;
  /** Reasoning level requested for this run. */
  thinkingLevel: ThinkingLevel;
  /** Tools available to the model this run. */
  tools: AgentTool<any>[];
  /** Names of currently-active tools (subset of `tools`). */
  activeToolNames: Set<string>;
}

export interface BuildTurnSnapshotInput {
  sessionLeafId: string | null;
  messages: AgentMessage[];
  systemPrompt: string;
  model: Model<any>;
  thinkingLevel: ThinkingLevel;
  tools: AgentTool<any>[];
  activeToolNames?: Iterable<string>;
}

export function buildTurnSnapshot(input: BuildTurnSnapshotInput): TurnSnapshot {
  return {
    sessionLeafId: input.sessionLeafId,
    messages: [...input.messages],
    systemPrompt: input.systemPrompt,
    model: input.model,
    thinkingLevel: input.thinkingLevel,
    tools: [...input.tools],
    activeToolNames: new Set(
      input.activeToolNames ?? input.tools.map((tool) => tool.name),
    ),
  };
}
