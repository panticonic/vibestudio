/**
 * Compatibility epoch for the workspace source/runtime ABI. It prevents a
 * checkout authored for one host contract from running against another.
 *
 * This is deliberately separate from authoritative persistence versions:
 * every durable store owns a production baseline and ordered migrations. A
 * manifest mismatch requires a supported workspace-source upgrade; it never
 * authorizes resetting persisted state.
 */
export const WORKSPACE_SYSTEM_EPOCH = 56 as const;
