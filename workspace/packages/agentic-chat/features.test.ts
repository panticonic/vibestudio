import { describe, expect, it } from "vitest";
import type { MethodDefinition } from "@workspace/pubsub";
import { z } from "zod";
import {
  DEFAULT_AGENTIC_CHAT_UI_FEATURES,
  resolveAgenticChatUiFeatures,
  selectAgenticChatMethods,
  selectAgenticChatTranscriptMessages,
} from "./features";

const METHOD_NAMES = [
  "feedback_form",
  "feedback_custom",
  "confirm",
  "ui_prompt",
  "inline_ui",
  "load_action_bar",
  "client_eval",
  "game_action",
] as const;

function methods(): Record<string, MethodDefinition> {
  return Object.fromEntries(
    METHOD_NAMES.map((name) => [
      name,
      {
        description: name,
        parameters: z.object({}),
        execute: async () => ({ ok: true }),
      } satisfies MethodDefinition,
    ])
  );
}

describe("agentic chat UI features", () => {
  it("preserves the existing full surface when no selection is supplied", () => {
    expect(resolveAgenticChatUiFeatures(undefined)).toBe(DEFAULT_AGENTIC_CHAT_UI_FEATURES);
    expect(
      Object.keys(selectAgenticChatMethods(methods(), DEFAULT_AGENTIC_CHAT_UI_FEATURES))
    ).toEqual(METHOD_NAMES);
  });

  it("removes browser-owned methods while retaining non-UI and caller tools", () => {
    const selected = resolveAgenticChatUiFeatures([]);

    expect(selected).toEqual({ feedback: false, inlineUi: false, actionBar: false });
    expect(Object.keys(selectAgenticChatMethods(methods(), selected))).toEqual([
      "client_eval",
      "game_action",
    ]);
  });

  it("selects surface capabilities independently", () => {
    const selected = resolveAgenticChatUiFeatures(["feedback"]);

    expect(Object.keys(selectAgenticChatMethods(methods(), selected))).toEqual([
      "feedback_form",
      "feedback_custom",
      "confirm",
      "ui_prompt",
      "client_eval",
      "game_action",
    ]);
  });

  it("omits historical inline UI only from stock presentation", () => {
    const messages = [
      { id: "text", senderId: "agent", kind: "message" as const, content: "hello" },
      {
        id: "inline",
        senderId: "agent",
        kind: "message" as const,
        content: "{}",
        contentType: "inline_ui" as const,
      },
    ];

    expect(
      selectAgenticChatTranscriptMessages(messages, resolveAgenticChatUiFeatures([])).map(
        (message) => message.id
      )
    ).toEqual(["text"]);
    expect(selectAgenticChatTranscriptMessages(messages, DEFAULT_AGENTIC_CHAT_UI_FEATURES)).toBe(
      messages
    );
  });
});
