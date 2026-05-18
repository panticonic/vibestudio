import { describe, it, expect } from "vitest";

import { buildTurnSnapshot } from "./turn-snapshot.js";

describe("buildTurnSnapshot", () => {
  const fakeModel = { id: "openai-codex:gpt-5", provider: "openai-codex", modelId: "gpt-5", api: "openai" } as any;
  const tools = [
    { name: "read", label: "Read", parameters: {}, execute: async () => ({ content: [], details: null }) } as any,
    { name: "edit", label: "Edit", parameters: {}, execute: async () => ({ content: [], details: null }) } as any,
  ];

  it("captures every field passed in", () => {
    const snapshot = buildTurnSnapshot({
      sessionLeafId: "leaf-1",
      messages: [{ role: "user", content: "hi", timestamp: 1 } as any],
      systemPrompt: "PROMPT",
      model: fakeModel,
      thinkingLevel: "high",
      tools,
    });
    expect(snapshot.sessionLeafId).toBe("leaf-1");
    expect(snapshot.systemPrompt).toBe("PROMPT");
    expect(snapshot.model).toBe(fakeModel);
    expect(snapshot.thinkingLevel).toBe("high");
    expect(snapshot.tools).toHaveLength(2);
    expect(snapshot.activeToolNames).toEqual(new Set(["read", "edit"]));
  });

  it("copies the messages array so callers can mutate without affecting the snapshot", () => {
    const messages = [{ role: "user", content: "hi", timestamp: 1 } as any];
    const snapshot = buildTurnSnapshot({
      sessionLeafId: null,
      messages,
      systemPrompt: "",
      model: fakeModel,
      thinkingLevel: "medium",
      tools,
    });
    messages.push({ role: "assistant", content: "ok", timestamp: 2 } as any);
    expect(snapshot.messages).toHaveLength(1);
  });

  it("accepts an explicit activeToolNames override", () => {
    const snapshot = buildTurnSnapshot({
      sessionLeafId: null,
      messages: [],
      systemPrompt: "",
      model: fakeModel,
      thinkingLevel: "medium",
      tools,
      activeToolNames: ["read"],
    });
    expect(snapshot.activeToolNames).toEqual(new Set(["read"]));
  });
});
