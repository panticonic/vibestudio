import {
  nativeInvocationSourceSchema,
  nativeInvocationId,
} from "@vibestudio/service-schemas/nativeInvocation";

/** The same channel carries native tool starts and their channel-RPC calls. */
export function inspectNativeApprovalInvocation(
  event: Record<string, unknown>,
  channelName: string
) {
  const transport = event["transport"];
  if (
    transport &&
    typeof transport === "object" &&
    "kind" in transport &&
    transport.kind === "channel"
  ) {
    if (event["nativeSource"] !== undefined)
      throw new Error("A channel transport start must not claim a native task source");
    return null;
  }
  const source = nativeInvocationSourceSchema.parse(event["nativeSource"]);
  if (
    nativeInvocationId(source) !== event["invocationId"] ||
    source.owner.runtimeId !== event["actorId"] ||
    source.owner.channelId !== channelName
  )
    throw new Error("Canonical native invocation attribution differs from its original source");
  return { source, invocationId: nativeInvocationId(source) };
}
