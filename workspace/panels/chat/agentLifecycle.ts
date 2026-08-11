/** Panel adapter for the runtime-neutral agent launch/lifecycle primitives. */
import { rpc } from "@workspace/runtime";
import { waitForApprovalResolution } from "@workspace/pubsub";
import {
  launchAgentIntoChannel,
  withWorkspaceReviewRetry,
  type WorkspaceReviewWaiter,
} from "@workspace/agentic-core";

export const waitForPanelReview: WorkspaceReviewWaiter = (approvalId) =>
  waitForApprovalResolution(rpc, approvalId);

/** Create or reactivate an agent entity, then subscribe it to the channel. */
export async function createAndSubscribeAgent(args: {
  source: string;
  className: string;
  key: string;
  channelId: string;
  channelContextId: string;
  config?: Record<string, unknown>;
  replay?: boolean;
}): Promise<{ ok: boolean; participantId?: string }> {
  if (!args.channelContextId) {
    throw new Error("Cannot subscribe an agent DO without a context ID");
  }
  const { subscription } = await withWorkspaceReviewRetry(
    () =>
      launchAgentIntoChannel(rpc, {
        source: args.source,
        className: args.className,
        key: args.key,
        channelId: args.channelId,
        contextId: args.channelContextId,
        config: args.config,
        replay: args.replay,
      }),
    waitForPanelReview
  );
  return subscription;
}
