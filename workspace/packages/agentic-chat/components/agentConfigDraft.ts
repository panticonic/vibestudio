import type { AgentSubscriptionConfig, AvailableAgent, ModelCatalog } from "@workspace/agentic-core";
import type { DefaultAgentConfig } from "@workspace/model-catalog/catalog";
import type { AgentConfigDraft } from "./AgentConfigForm";

/**
 * Shared agent-config-draft helpers used by both the modal `AgentDialog` and the
 * inline first-agent setup (`AgentSetupInline`). Kept framework-free (no hooks)
 * so they're trivially unit-testable and reusable across surfaces.
 */

/**
 * Resolve a sensible default model ref: prefer the explicit workspace default,
 * then a recommended+connected model, then any connected model, then any
 * recommended model, then the first model in the catalog.
 */
export function pickDefaultModel(
  catalog: ModelCatalog | null,
  connected: ReadonlySet<string>,
  defaultModelRef?: string | null
): string {
  const models = catalog?.models ?? [];
  return (
    (defaultModelRef && models.some((m) => m.ref === defaultModelRef) ? defaultModelRef : null) ??
    models.find((m) => m.recommended && connected.has(m.ref))?.ref ??
    models.find((m) => connected.has(m.ref))?.ref ??
    models.find((m) => m.recommended)?.ref ??
    models[0]?.ref ??
    ""
  );
}

/** Project a UI draft into the wire-level subscription config (drops empties). */
export function draftToConfig(draft: AgentConfigDraft): AgentSubscriptionConfig {
  const config: AgentSubscriptionConfig = {};
  if (draft.model) config.model = draft.model;
  if (draft.thinkingLevel) config.thinkingLevel = draft.thinkingLevel;
  if (draft.approvalLevel !== undefined) config.approvalLevel = draft.approvalLevel;
  if (draft.respondPolicy) config.respondPolicy = draft.respondPolicy;
  if (draft.respondFrom && draft.respondFrom.length > 0) config.respondFrom = draft.respondFrom;
  if (draft.handle) config["handle"] = draft.handle;
  if (draft.systemPrompt) config.systemPrompt = draft.systemPrompt;
  return config;
}

/**
 * Seed a fresh draft for an agent type from its manifest `defaultConfig`, falling
 * back to the resolved default model. `showReactiveness` decides whether a
 * default respondPolicy is seeded (only meaningful in multi-agent channels).
 */
export function draftForAgent(
  agent: AvailableAgent | undefined,
  opts: {
    modelCatalog: ModelCatalog | null;
    connectedRefs: ReadonlySet<string>;
    defaultModelRef?: string | null;
    /** Saved workspace defaults — layered over the agent manifest defaults so a
     *  freshly-seeded draft matches the saved defaults (the "Save as defaults"
     *  control then only appears once the user changes something). */
    defaultAgentConfig?: DefaultAgentConfig | null;
    showReactiveness?: boolean;
  }
): AgentConfigDraft {
  const defaults = agent?.defaultConfig ?? {};
  const ws = opts.defaultAgentConfig;
  const defaultHandle =
    typeof defaults["handle"] === "string" ? defaults["handle"] : agent?.proposedHandle;
  return {
    model:
      typeof defaults.model === "string"
        ? defaults.model
        : pickDefaultModel(opts.modelCatalog, opts.connectedRefs, opts.defaultModelRef),
    thinkingLevel: ws?.thinkingLevel ?? defaults.thinkingLevel,
    approvalLevel: ws?.approvalLevel ?? defaults.approvalLevel,
    respondPolicy: defaults.respondPolicy ?? (opts.showReactiveness ? "mentioned" : undefined),
    respondFrom: defaults.respondFrom,
    handle: defaultHandle,
    systemPrompt: defaults.systemPrompt,
  };
}
