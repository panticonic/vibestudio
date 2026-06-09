import { describe, expect, it } from "vitest";
import {
  appendInstalledAgent,
  resolveChatContextId,
  type InstalledAgentRecord,
} from "./bootstrap.js";

describe("resolveChatContextId", () => {
  it("prefers the state-args context when present", () => {
    expect(resolveChatContextId("ctx-from-state", "ctx-from-runtime")).toBe("ctx-from-state");
  });

  it("falls back to the runtime context", () => {
    expect(resolveChatContextId(undefined, "ctx-from-runtime")).toBe("ctx-from-runtime");
  });

  it("returns null when no usable context is available", () => {
    expect(resolveChatContextId(undefined, undefined)).toBeUndefined();
    expect(resolveChatContextId("", "   ")).toBeUndefined();
  });
});

describe("appendInstalledAgent", () => {
  const sample: InstalledAgentRecord = {
    agentId: "AiChatWorker",
    handle: "ai-chat-abcd",
    key: "ai-chat-abcd-12345678",
    source: "workers/agent-worker",
    className: "AiChatWorker",
  };

  it("creates a new array when existing is undefined", () => {
    const next = appendInstalledAgent(undefined, sample);
    expect(next).toEqual([sample]);
  });

  it("appends to an existing array without mutating it", () => {
    const existing: InstalledAgentRecord[] = [
      { agentId: "A", handle: "a", key: "a-1", source: "src", className: "A" },
    ];
    const next = appendInstalledAgent(existing, sample);
    expect(next).toHaveLength(2);
    expect(next[0]).toEqual(existing[0]);
    expect(next[1]).toEqual(sample);
    // Source array must not be mutated.
    expect(existing).toHaveLength(1);
  });

  it("preserves all persisted fields needed by bootstrap rehydration", () => {
    const next = appendInstalledAgent(undefined, sample);
    const persisted = next[0]!;
    // These exact fields are read by the rehydration block in index.tsx
    expect(persisted.agentId).toBe(sample.agentId);
    expect(persisted.handle).toBe(sample.handle);
    expect(persisted.key).toBe(sample.key);
    expect(persisted.source).toBe(sample.source);
    expect(persisted.className).toBe(sample.className);
  });
});
