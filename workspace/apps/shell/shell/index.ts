/**
 * Shell Client - Unified exports for shell RPC and events.
 */

export * from "./client.js";
export { useShellEvent, type EventPayloads } from "./useShellEvent.js";
export { useDirectShellEvent } from "./useDirectShellEvent.js";
export { useNativeShellOverlay } from "./useNativeShellOverlay.js";
