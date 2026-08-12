import { CONTENT_TYPE_INLINE_UI, type MethodDefinition } from "@workspace/pubsub";
import type { ChatMessage } from "@workspace/agentic-core";

/**
 * Optional browser-owned surfaces that an AgenticChat participant can expose.
 *
 * The selection is a capability boundary, not merely a rendering preference:
 * omitted features are neither advertised as channel methods nor mounted by
 * the stock layout. The selection is fixed for the lifetime of a mounted chat
 * participant because changing its method surface requires a new channel join.
 */
export const AGENTIC_CHAT_UI_FEATURES = ["feedback", "inline-ui", "action-bar"] as const;

export type AgenticChatUiFeature = (typeof AGENTIC_CHAT_UI_FEATURES)[number];

export interface ResolvedAgenticChatUiFeatures {
  readonly feedback: boolean;
  readonly inlineUi: boolean;
  readonly actionBar: boolean;
}

export const DEFAULT_AGENTIC_CHAT_UI_FEATURES: ResolvedAgenticChatUiFeatures = Object.freeze({
  feedback: true,
  inlineUi: true,
  actionBar: true,
});

export function resolveAgenticChatUiFeatures(
  features: readonly AgenticChatUiFeature[] | undefined
): ResolvedAgenticChatUiFeatures {
  if (features === undefined) return DEFAULT_AGENTIC_CHAT_UI_FEATURES;
  const selected = new Set(features);
  return Object.freeze({
    feedback: selected.has("feedback"),
    inlineUi: selected.has("inline-ui"),
    actionBar: selected.has("action-bar"),
  });
}

const UI_METHOD_FEATURE = {
  feedback_form: "feedback",
  feedback_custom: "feedback",
  confirm: "feedback",
  ui_prompt: "feedback",
  inline_ui: "inlineUi",
  load_action_bar: "actionBar",
} as const satisfies Record<string, keyof ResolvedAgenticChatUiFeatures>;

/** Keep non-UI methods and only the browser-owned UI methods selected for this join. */
export function selectAgenticChatMethods(
  methods: Record<string, MethodDefinition>,
  features: ResolvedAgenticChatUiFeatures
): Record<string, MethodDefinition> {
  return Object.fromEntries(
    Object.entries(methods).filter(([name]) => {
      const feature = UI_METHOD_FEATURE[name as keyof typeof UI_METHOD_FEATURE];
      return feature === undefined || features[feature];
    })
  );
}

/**
 * Apply the same capability selection to the stock transcript. The durable
 * channel view remains complete for custom consumers; only the stock
 * presentation omits historical inline UI when that surface is unavailable.
 */
export function selectAgenticChatTranscriptMessages(
  messages: ChatMessage[],
  features: ResolvedAgenticChatUiFeatures
): ChatMessage[] {
  return features.inlineUi
    ? messages
    : messages.filter((message) => message.contentType !== CONTENT_TYPE_INLINE_UI);
}
