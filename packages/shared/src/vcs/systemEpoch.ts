/**
 * One destructive pre-release epoch for the workspace system: semantic state,
 * host projections, and the workspace runtime contract advance together.
 *
 * A workspace manifest must declare this exact epoch. Older workspaces are
 * rejected at startup instead of mixing old userland runtime code with a new
 * host or carrying migration/compatibility paths during pre-release.
 */
export const WORKSPACE_SYSTEM_EPOCH = 56 as const;
