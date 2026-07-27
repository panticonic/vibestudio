/**
 * Existing provider integrations continue to fit without configuration. Relay
 * delivery cannot exceed this budget because its durable queue has a tighter
 * storage envelope than a co-located direct ingress.
 */
export const WEBHOOK_DEFAULT_MAX_BODY_BYTES = 1_500_000;
export const WEBHOOK_RELAY_MAX_BODY_BYTES = WEBHOOK_DEFAULT_MAX_BODY_BYTES;

/** Conservative operator default for direct ingress. */
export const WEBHOOK_DEFAULT_DIRECT_MAX_BODY_BYTES = 16 * 1024 * 1024;

/**
 * Hard configuration bound while delivery events contain both the raw Buffer
 * and its 4/3-size base64 representation. At this limit those two values alone
 * occupy roughly 149 MiB before payload parsing and dispatch.
 */
export const WEBHOOK_HARD_MAX_BODY_BYTES = 64 * 1024 * 1024;
