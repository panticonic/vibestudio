/**
 * Small reviewed policy of product-shipped code allowed to attest agent context.
 * Exact effective versions are resolved from the immutable first-run snapshot;
 * paths alone never confer trust.
 */
export const PRODUCT_CONDUIT_UNITS = [
  "workers/agent-worker",
  "workers/explorer-agent",
  "workers/gmail-agent",
  "workers/linked-agent",
  "workers/news-agent",
  "workers/silent-agent-worker",
  "workers/terminal-chat",
  "workers/test-agent",
] as const;
