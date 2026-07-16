import type { RpcCaller } from "@vibestudio/rpc";
import type {
  UserNotification,
  UserNotificationAcknowledgementResult,
  UserNotificationListResult,
} from "@vibestudio/shared/userNotifications";
import { createGadServiceClient } from "@vibestudio/shared/workspaceServiceRpc";
import {
  callTypedServiceMethod,
  createTypedServiceClient,
  type ServiceCallFn,
  type TypedServiceClient,
} from "@vibestudio/shared/typedServiceClient";
import { blobstoreMethods } from "@vibestudio/service-schemas/blobstore";
import {
  gadMethods,
  gadWireMethods,
  type EnvelopeLineage,
  type GadSqlBinding,
  type GadSqlInput,
  type PrivateLineageForPublishedEnvelope,
  type PublishedArtifact,
} from "./gad-schema.js";
import type { ChannelEnvelopePage } from "@vibestudio/shared/channelEnvelopePaging";
import {
  hydrateStoredValueRefs,
  type ChannelEnvelope,
  type TrajectoryEvent,
} from "@workspace/agentic-protocol";

export { GAD_WORKSPACE_SERVICE_PROTOCOL } from "@vibestudio/shared/workspaceServiceRpc";
export type * from "./gad-schema.js";

/** Typed entirely from the shared GAD runtime method schemas. */
export type GadClient = TypedServiceClient<typeof gadMethods>;

export function createGadClient(rpc: RpcCaller): GadClient {
  const service = createGadServiceClient(rpc);
  const wireTransport: ServiceCallFn = (_service, method, args) => service.call(method, ...args);
  const call = <T>(method: keyof typeof gadWireMethods & string, ...args: unknown[]) =>
    callTypedServiceMethod("gad-wire", gadWireMethods, wireTransport, method, args) as Promise<T>;
  const normalizeSqlArgs = (
    input: GadSqlInput,
    bindings?: GadSqlBinding[]
  ): [string, GadSqlBinding[]] => {
    if (typeof input === "string") return [input, bindings ?? []];
    return [input.sql, input.bindings ?? input.params ?? bindings ?? []];
  };
  const blobstore = createTypedServiceClient("blobstore", blobstoreMethods, (svc, method, args) =>
    rpc.call("main", `${svc}.${method}`, args)
  );
  const hydrate = async <T>(value: T): Promise<T> =>
    hydrateStoredValueRefs(value, {
      getText: (digest) => blobstore.getText(digest),
    }) as Promise<T>;
  const hydrateLineage = async (item: EnvelopeLineage): Promise<EnvelopeLineage> => ({
    ...item,
    envelope: await hydrate(item.envelope),
    trajectoryEvent: await hydrate(item.trajectoryEvent),
  });

  const adapter: GadClient = {
    rawSql: (input, bindings) => call("rawSql", ...normalizeSqlArgs(input, bindings)),
    query: (input, bindings) => call("query", ...normalizeSqlArgs(input, bindings)),
    status: () => call("getStatus"),
    ensureBlob: (hash, size, mimeType) => call("ensureBlob", hash, size, mimeType),
    listUserNotificationsForMe: async () =>
      (await call<UserNotificationListResult>("listUserNotificationsForMe")).notifications,
    acknowledgeUserNotification: async (id) =>
      (
        await call<UserNotificationAcknowledgementResult>("acknowledgeUserNotification", {
          id,
        })
      ).acknowledged,
    putUserNotification: (input) => call<UserNotification>("putUserNotification", input),
    deleteUserNotification: async (userId, id) =>
      (
        await call<{ deleted: boolean }>("deleteUserNotification", {
          userId,
          id,
        })
      ).deleted,
    getTrajectoryBranchHead: (input) => call("getTrajectoryBranchHead", input),
    listTrajectoryEvents: async (input) =>
      Promise.all(
        (await call<TrajectoryEvent[]>("listTrajectoryEvents", input)).map((event) =>
          hydrate(event)
        )
      ),
    appendChannelEnvelope: (input) =>
      call<ChannelEnvelope>("appendChannelEnvelope", input).then(hydrate),
    appendChannelEnvelopeWithRegistryMutation: (input) =>
      call<ChannelEnvelope>("appendChannelEnvelopeWithRegistryMutation", input).then(hydrate),
    listMessageTypes: (input) => call("listMessageTypes", input),
    getMessageType: (input) => call("getMessageType", input),
    getChannelEnvelope: (input) =>
      call<ChannelEnvelope | null>("getChannelEnvelope", input).then((value) =>
        value ? hydrate(value) : null
      ),
    getTrajectoryForEnvelope: (input) =>
      call<EnvelopeLineage | null>("getTrajectoryForEnvelope", input).then((value) =>
        value ? hydrateLineage(value) : null
      ),
    listPublishedEnvelopesForTrajectory: async (input) =>
      Promise.all(
        (await call<EnvelopeLineage[]>("listPublishedEnvelopesForTrajectory", input)).map(
          hydrateLineage
        )
      ),
    getEnvelopesForTrajectory: async (input) =>
      Promise.all(
        (await call<EnvelopeLineage[]>("getEnvelopesForTrajectory", input)).map(hydrateLineage)
      ),
    getPublishedArtifactsForTurn: async (input) =>
      Promise.all(
        (await call<PublishedArtifact[]>("getPublishedArtifactsForTurn", input)).map(
          async (item) => ({
            ...item,
            lineage: await hydrateLineage(item.lineage),
          })
        )
      ),
    getPrivateLineageForPublishedEnvelope: async (input) => {
      const value = await call<PrivateLineageForPublishedEnvelope | null>(
        "getPrivateLineageForPublishedEnvelope",
        input
      );
      return value
        ? {
            ...value,
            lineage: await hydrateLineage(value.lineage),
            branchEvents: await Promise.all(value.branchEvents.map((event) => hydrate(event))),
          }
        : null;
    },
    getDownstreamConsumers: async (input) =>
      Promise.all(
        (await call<TrajectoryEvent[]>("getDownstreamConsumers", input)).map((event) =>
          hydrate(event)
        )
      ),
    readChannelEnvelopes: async (input) => {
      const page = await call<ChannelEnvelopePage<ChannelEnvelope>>("readChannelEnvelopes", input);
      return {
        ...page,
        items: await Promise.all(page.items.map((envelope) => hydrate(envelope))),
      };
    },
    inspectChannelEnvelopes: (input) => call("inspectChannelEnvelopes", input),
    listStoredValueRefs: (input) => call("listStoredValueRefs", input ?? {}),
    inspectStorageDiagnostics: (input) => call("inspectStorageDiagnostics", input ?? {}),
    inspectPublicationIntegrity: (input) => call("inspectPublicationIntegrity", input ?? {}),
    inspectTurnState: (input) => call("inspectTurnState", input ?? {}),
    inspectInvocationState: (input) => call("inspectInvocationState", input ?? {}),
    inspectChannelRoster: (input) => call("inspectChannelRoster", input),
    inspectAgentHealth: (input) => call("inspectAgentHealth", input),
    validateGadHashes: (input) => call("validateGadHashes", input),
    clearDirtyAfterValidation: (input) => call("clearDirtyAfterValidation", input),
    checkGadIntegrity: (input) => call("checkGadIntegrity", input),
    rebuildTrajectoryProjections: (input) => call("rebuildTrajectoryProjections", input),
  };

  return createTypedServiceClient("gad", gadMethods, (_service, method, args) => {
    const member = (adapter as unknown as Record<string, unknown>)[method];
    if (typeof member !== "function") {
      throw new Error(`GAD public adapter has no method ${JSON.stringify(method)}`);
    }
    return (member as (...values: unknown[]) => Promise<unknown>)(...args);
  });
}
