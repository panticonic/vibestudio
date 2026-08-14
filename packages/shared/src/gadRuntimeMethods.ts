/**
 * Portable GAD runtime method manifest.
 *
 * This lower-layer file intentionally contains names only: host capability
 * manifests can consume it without depending on userland protocol schemas.
 * The userland Zod contract is required at compile time to implement every
 * name in this tuple exactly.
 */
export const GAD_RUNTIME_METHOD_NAMES = [
  "status",
  "ensureBlob",
  "listUserNotificationsForMe",
  "acknowledgeUserNotification",
  "putUserNotification",
  "deleteUserNotification",
  "getTrajectoryBranchHead",
  "listTrajectoryBranches",
  "listTrajectoryInvocations",
  "listTrajectoryApprovals",
  "listChannelEnvelopes",
  "listTrajectoryEvents",
  "appendChannelEnvelope",
  "listMessageTypes",
  "getMessageType",
  "getChannelEnvelope",
  "getTrajectoryForEnvelope",
  "resolveTrajectoryForkPoint",
  "listPublishedEnvelopesForTrajectory",
  "getEnvelopesForTrajectory",
  "getPublishedArtifactsForTurn",
  "getPrivateLineageForPublishedEnvelope",
  "getDownstreamConsumers",
  "readChannelEnvelopes",
  "inspectChannelEnvelopes",
  "listStoredValueRefs",
  "inspectStorageDiagnostics",
  "inspectPublicationIntegrity",
  "inspectTurnState",
  "inspectInvocationState",
  "diagnoseInvocation",
  "inspectChannelRoster",
  "inspectAgentHealth",
  "listAgentDirectory",
  "searchAgentDirectory",
  "describeChannels",
  "validateGadHashes",
  "clearDirtyAfterValidation",
  "checkGadIntegrity",
  "rebuildTrajectoryProjections",
] as const;

export type GadRuntimeMethodName = (typeof GAD_RUNTIME_METHOD_NAMES)[number];
