/**
 * Exact current-generation workspace source/runtime ABI. A different value is
 * rejected and the pre-release workspace must be recreated from the promoted
 * external Base; the host carries no source or persistence compatibility path.
 */
export const WORKSPACE_SYSTEM_EPOCH = 61 as const;
