/**
 * CompactionTrigger decides when NatStack should ask AgentHarness to compact.
 *
 * Execution is intentionally not here. AgentHarness owns compaction planning,
 * summarisation, session writes, and the `session_compact` event.
 */

import {
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens,
  shouldCompact as upstreamShouldCompact,
  type CompactionSettings,
} from "@earendil-works/pi-agent-core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";

export interface CompactionTriggerOptions {
  /** Fraction of the model context window at which compaction triggers. Default 0.8. */
  contextRatio?: number;
  /** Override the upstream defaults for the trigger decision. */
  settings?: Partial<CompactionSettings>;
}

export class CompactionTrigger {
  private readonly contextRatio: number;
  readonly settings: CompactionSettings;

  constructor(options: CompactionTriggerOptions = {}) {
    this.contextRatio = options.contextRatio ?? 0.8;
    this.settings = { ...DEFAULT_COMPACTION_SETTINGS, ...(options.settings ?? {}) };
  }

  shouldCompact(messages: AgentMessage[], model: Model<any>): boolean {
    if (!this.settings.enabled) return false;
    const contextWindow = readContextWindow(model);
    if (!contextWindow) return false;
    const effectiveWindow = Math.floor(contextWindow * this.contextRatio);
    const estimate = estimateContextTokens(messages);
    return upstreamShouldCompact(estimate.tokens, effectiveWindow, this.settings);
  }
}

function readContextWindow(model: Model<any>): number | undefined {
  const candidate = model as {
    contextWindow?: number;
    context_window?: number;
    maxContextTokens?: number;
  };
  const value =
    candidate.contextWindow ??
    candidate.context_window ??
    candidate.maxContextTokens;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}
