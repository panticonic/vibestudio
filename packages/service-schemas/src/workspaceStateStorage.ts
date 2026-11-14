/**
 * The storage declaration of `WorkspaceStateDO`, a Dolt cell. It is read by the
 * class (its schema) and by the runtime deployment (`celld.durable_objects`),
 * which must agree: a local table not declared at deploy would be versioned.
 */

/**
 * Tables a reset does not rewind and a fork does not copy (L3): the close-cleanup
 * outbox, the lifecycle registry, the alarm schedule, the durable work owners and
 * every `local_` table (the panel-tree revision, the legacy import's staging).
 * The framework adds its own (`vsl_%`, `state`) in `doltLocalPatterns`.
 */
export const WORKSPACE_STATE_LOCAL_TABLES = [
  "panel_close_cleanup",
  "local_%",
  "lifecycle_epochs",
  "lifecycle_leases",
  "lifecycle_ops",
  "do_alarms",
  "do_alarm_test_policies",
  "durable_work_owners",
] as const;
