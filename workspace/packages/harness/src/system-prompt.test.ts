import { describe, expect, it } from "vitest";
import { composeSystemPrompt, VIBEZ1_BASE_SYSTEM_PROMPT } from "./system-prompt.js";

describe("composeSystemPrompt", () => {
  it("appends Vibez1, workspace, skills, and channel prompts by default", () => {
    const prompt = composeSystemPrompt({
      workspacePrompt: "WORKSPACE",
      skillIndex: "SKILLS",
      agentPrompt: "AGENT",
      systemPrompt: "CHANNEL",
    });

    expect(prompt).toContain(VIBEZ1_BASE_SYSTEM_PROMPT);
    expect(prompt.indexOf(VIBEZ1_BASE_SYSTEM_PROMPT)).toBeLessThan(prompt.indexOf("WORKSPACE"));
    expect(prompt.indexOf("WORKSPACE")).toBeLessThan(prompt.indexOf("SKILLS"));
    expect(prompt.indexOf("SKILLS")).toBeLessThan(prompt.indexOf("AGENT"));
    expect(prompt.indexOf("AGENT")).toBeLessThan(prompt.indexOf("CHANNEL"));
  });

  it("lets a channel prompt replace the Vibez1 base while preserving workspace resources and agent behavior", () => {
    const prompt = composeSystemPrompt({
      workspacePrompt: "WORKSPACE",
      skillIndex: "SKILLS",
      agentPrompt: "AGENT",
      systemPrompt: "CHANNEL",
      systemPromptMode: "replace-vibez1",
    });

    expect(prompt).not.toContain(VIBEZ1_BASE_SYSTEM_PROMPT);
    expect(prompt.indexOf("CHANNEL")).toBeLessThan(prompt.indexOf("WORKSPACE"));
    expect(prompt.indexOf("WORKSPACE")).toBeLessThan(prompt.indexOf("SKILLS"));
    expect(prompt.indexOf("SKILLS")).toBeLessThan(prompt.indexOf("AGENT"));
  });

  it("keeps the Vibez1 base when replace-vibez1 has no replacement prompt", () => {
    const prompt = composeSystemPrompt({
      workspacePrompt: "WORKSPACE",
      systemPromptMode: "replace-vibez1",
    });

    expect(prompt).toContain(VIBEZ1_BASE_SYSTEM_PROMPT);
    expect(prompt.indexOf(VIBEZ1_BASE_SYSTEM_PROMPT)).toBeLessThan(prompt.indexOf("WORKSPACE"));
  });

  it("lets a channel prompt replace the full prompt", () => {
    expect(composeSystemPrompt({
      workspacePrompt: "WORKSPACE",
      skillIndex: "SKILLS",
      systemPrompt: "CHANNEL",
      systemPromptMode: "replace",
    })).toBe("CHANNEL");
  });

  it("keeps Vibez1 rich-message and browser-open guidance in the base prompt", () => {
    expect(VIBEZ1_BASE_SYSTEM_PROMPT).toContain("MDX supports standard Markdown");
    expect(VIBEZ1_BASE_SYSTEM_PROMPT).toContain("Callout.Root");
    expect(VIBEZ1_BASE_SYSTEM_PROMPT).toContain("<ActionButton message=");
    expect(VIBEZ1_BASE_SYSTEM_PROMPT).toContain("openExternal(url)");
  });

  it("asks agents to use proper grammar in intermediate messages", () => {
    expect(VIBEZ1_BASE_SYSTEM_PROMPT).toContain(
      "Use proper grammar in commentary/intermediate messages."
    );
  });
});
