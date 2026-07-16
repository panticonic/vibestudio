/**
 * Canonical identity boundary for per-channel agent trajectories.
 *
 * This package is shared by host code and userland agent code. A
 * runtime/process/entity identifier is attribution, not a trajectory
 * capability; only a trusted channel binding may be converted into these
 * coordinates.
 */

import { stableSha256Hex } from "@vibestudio/content-addressing";

export const CHANNEL_TRAJECTORY_LOG_PREFIX = "branch:channel:";

export interface ChannelTrajectoryCoordinates {
  readonly channelId: string;
  readonly logId: string;
  readonly head: string;
}

export interface TrajectoryInvocationCoordinates {
  readonly logId: string;
  readonly head: string;
  readonly invocationId: string;
}

const TRAJECTORY_INVOCATION_COMMAND_DOMAIN = "vibestudio/trajectory-invocation-command/v1";

function requireChannelId(channelId: string): void {
  if (channelId.length === 0) {
    throw new TypeError("channel trajectory identity requires a non-empty channelId");
  }
}

function requireCoordinate(name: keyof TrajectoryInvocationCoordinates, value: string): void {
  if (value.length === 0) {
    throw new TypeError(`trajectory invocation command identity requires a non-empty ${name}`);
  }
}

/** Canonical trajectory log capability derived from a trusted channel id. */
export function logIdForChannel(channelId: string): string {
  requireChannelId(channelId);
  return `${CHANNEL_TRAJECTORY_LOG_PREFIX}${channelId}`;
}

/** Reverse only the canonical channel-log namespace; arbitrary log IDs are not channels. */
export function channelIdFromTrajectoryLog(logId: string): string | null {
  if (!logId.startsWith(CHANNEL_TRAJECTORY_LOG_PREFIX)) return null;
  const channelId = logId.slice(CHANNEL_TRAJECTORY_LOG_PREFIX.length);
  return channelId.length > 0 ? channelId : null;
}

/**
 * Channel trajectories use their log capability as the named head. Keeping
 * this convention here prevents host and userland code from independently
 * inventing a head name for the same trajectory.
 */
export function headForChannel(channelId: string): string {
  return logIdForChannel(channelId);
}

/** The complete, walkable coordinates for one canonical channel trajectory. */
export function channelTrajectoryFor(channelId: string): ChannelTrajectoryCoordinates {
  const logId = logIdForChannel(channelId);
  return { channelId, logId, head: logId };
}

/**
 * Globally stable semantic-command identity for one exact trajectory
 * invocation. The domain-separated canonical tuple prevents delimiter
 * ambiguity and prevents tool-call ids from colliding across trajectories.
 */
export function commandIdForTrajectoryInvocation(
  coordinates: TrajectoryInvocationCoordinates
): string {
  requireCoordinate("logId", coordinates.logId);
  requireCoordinate("head", coordinates.head);
  requireCoordinate("invocationId", coordinates.invocationId);
  return `command:trajectory-invocation:${stableSha256Hex([
    TRAJECTORY_INVOCATION_COMMAND_DOMAIN,
    coordinates.logId,
    coordinates.head,
    coordinates.invocationId,
  ])}`;
}
