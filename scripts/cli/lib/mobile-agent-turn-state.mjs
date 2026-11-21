export function readRenderedAgentReply(document) {
  const conversation = document.querySelector('[data-part="message-list"]');
  const contents = conversation?.querySelectorAll(
    '[data-message-role="agent"][data-message-tier="primary"] .message-content'
  );
  const last = contents?.[contents.length - 1];
  return {
    id: last?.getAttribute("data-message-id") ?? null,
    reply: last?.textContent?.trim() ?? "",
    typing: Boolean(conversation?.querySelector(".typing-indicator")),
  };
}

export function visibleAgentTurnState(labels) {
  const text = labels.join("\n");
  const agentIndex = labels.findLastIndex((label) => isAgentAttributionLabel(label));
  const agentLabels = agentIndex >= 0 ? labels.slice(agentIndex + 1, agentIndex + 12) : [];
  const agentText = agentLabels.join("\n");
  const credentialSetupCopy =
    /Credential (?:required|needs refresh) for/i.test(agentText) ||
    /Connect a URL-bound model credential for/i.test(agentText) ||
    /No built-in setup is available for this model provider/i.test(agentText) ||
    /No provider details available/i.test(agentText);
  const hasPendingGeneration = /\bGen\s*[—–-]\s*Pending\b/i.test(text);
  const hasPendingProviderSetup =
    hasPendingGeneration &&
    /Connect a model provider[\s\S]{0,240}Connect ChatGPT/i.test(text);
  const hasCredentialSetupPrompt =
    credentialSetupCopy ||
    hasPendingProviderSetup ||
    /This subscription sign-in requires a desktop browser/i.test(text);
  return {
    hasCredentialSetupPrompt,
    hasUnresolvedApproval: hasVisibleApprovalPrompt(labels),
  };
}

function hasVisibleApprovalPrompt(labels) {
  return labels.some((label) => {
    const normalized = label.replace(/\s+/g, " ").trim();
    return (
      /^(?:Add to workspace|Use once|Start)$/i.test(normalized) ||
      /^Use once\./i.test(normalized) ||
      /Approve workspace extensions/i.test(normalized)
    );
  });
}

function isAgentAttributionLabel(label) {
  const normalized = label.replace(/\s+/g, " ").trim();
  return (
    /^(?:AI Chat\s*)?@[a-z0-9][a-z0-9_-]*$/i.test(normalized) ||
    /^AI Chat\s*@[a-z0-9][a-z0-9_-]*(?:\s|$)/i.test(normalized)
  );
}
