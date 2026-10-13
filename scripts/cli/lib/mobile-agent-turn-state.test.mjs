import test from "node:test";
import assert from "node:assert/strict";
import { visibleAgentTurnState } from "./mobile-agent-turn-state.mjs";

test("recognizes Android subscription setup even when accessibility omits agent attribution", () => {
  const state = visibleAgentTurnState([
    "You",
    "AI Chat: taken into account",
    "Message actions",
    "I just opened this workspace for the first time, help me get onboarded.",
    "Gen — Pending",
    "Interactive UI",
    "Connect a model provider",
    "Connect ChatGPT",
    "This subscription sign-in requires a desktop browser. Connect this provider on desktop, or choose an API key if available..",
  ]);

  assert.equal(state.hasCredentialSetupPrompt, true);
  assert.equal(state.hasFinalVisibleOutput, false);
});

test("keeps ordinary setup overview copy from looking like a credential failure", () => {
  const state = visibleAgentTurnState([
    "AI Chat @codex",
    "Welcome. You can connect a model provider whenever you need a different model.",
    "Setup overview",
  ]);

  assert.equal(state.hasCredentialSetupPrompt, false);
  assert.equal(state.hasFinalVisibleOutput, true);
});

test("requires a pending generation before classifying a provider choice as a blocker", () => {
  const overview = visibleAgentTurnState([
    "Connect a model provider",
    "Connect ChatGPT",
  ]);
  assert.equal(overview.hasCredentialSetupPrompt, false);

  const pending = visibleAgentTurnState([
    "Gen — Pending",
    "Interactive UI",
    "Connect a model provider",
    "Connect ChatGPT",
  ]);
  assert.equal(pending.hasCredentialSetupPrompt, true);
});

test("retains the existing real-model credential prompt detection", () => {
  const state = visibleAgentTurnState([
    "AI Chat @codex",
    "Credential required for openai: connect it before continuing.",
  ]);

  assert.equal(state.hasCredentialSetupPrompt, true);
  assert.equal(state.hasFinalVisibleOutput, false);
});
