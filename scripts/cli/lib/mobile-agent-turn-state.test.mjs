import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { readRenderedAgentReply, visibleAgentTurnState } from "./mobile-agent-turn-state.mjs";

test("reads the reply beyond the setup card and excludes other authors", () => {
  const { document } = parseHTML(`
    <div data-part="message-list">
      <div data-message-role="player"><div class="message-content">Help me get onboarded.</div></div>
      <div class="inline-ui-frame">Explore workspaces</div>
      <div data-message-role="agent" data-message-tier="primary">
        <div class="message-content" data-message-id="reply">E2E model response: initial agent turn completed.</div>
      </div>
      <div data-message-role="agent" data-message-tier="secondary">
        <div class="message-content" data-message-id="diagnostic">A separate activity</div>
      </div>
      <div class="typing-indicator">AI Chat typing</div>
    </div>
  `);
  assert.deepEqual(readRenderedAgentReply(document), {
    id: "reply",
    reply: "E2E model response: initial agent turn completed.",
    typing: true,
  });
  document.querySelector(".typing-indicator").remove();
  assert.equal(readRenderedAgentReply(document).typing, false);
});

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
});

test("keeps ordinary setup overview copy from looking like a credential failure", () => {
  const state = visibleAgentTurnState([
    "AI Chat @codex",
    "Welcome. You can connect a model provider whenever you need a different model.",
    "Setup overview",
  ]);

  assert.equal(state.hasCredentialSetupPrompt, false);
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
});
