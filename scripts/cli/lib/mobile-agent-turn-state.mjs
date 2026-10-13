export function visibleAgentTurnState(labels) {
  const text = labels.join("\n");
  const isTyping = /\b(?:AI Chat|Agent) typing\b/i.test(text);
  const agentIndex = labels.findLastIndex((label) => isAgentAttributionLabel(label));
  const agentLabels = agentIndex >= 0 ? labels.slice(agentIndex + 1, agentIndex + 12) : [];
  const agentText = agentLabels.join("\n");
  const hasAgentAttribution =
    agentIndex >= 0 || /(?:^|\n)AI Chat(?:\s*|\n)@[a-z0-9][a-z0-9_-]*(?:\s|\n|$)/i.test(text);
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
  const hasUnresolvedApproval = hasVisibleApprovalPrompt(labels);
  const hasSubstantialContent = agentLabels.some(isSubstantialAgentContent);
  const hasAgentOutput = hasAgentAttribution && hasSubstantialContent && !hasCredentialSetupPrompt;
  return {
    hasAgentOutput,
    hasFinalVisibleOutput: hasAgentOutput && !isTyping && !hasUnresolvedApproval,
    hasCredentialSetupPrompt,
    hasUnresolvedApproval,
    isTyping,
    fingerprint: (agentLabels.length ? agentLabels : labels).filter(Boolean).slice(0, 60).join("|"),
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

function isSubstantialAgentContent(label) {
  const normalized = label.replace(/\s+/g, " ").trim();
  if (normalized.length < 8) return false;
  if (/^(?:AI Chat|AI Chat typing|Agent typing)$/i.test(normalized)) return false;
  if (isAgentAttributionLabel(normalized)) return false;
  if (
    /^(?:Approve all|Use once|Reply|Copy message|Enter API Key|Internal Browser|External Browser)$/i.test(
      normalized
    )
  ) {
    return false;
  }
  return true;
}
