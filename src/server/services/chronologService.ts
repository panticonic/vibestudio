import type { z } from "zod";
import {
  CHRONOLOG_PRINCIPALS,
  CHRONOLOG_TRANSACTION_RESOLVER,
  chronologMethods,
} from "@vibestudio/service-schemas/chronolog";
import {
  fixedPreparedAuthoritySelection,
  preparedAuthorityPayload,
  preparedAuthorityState,
  type ServiceDefinition,
} from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler, parseServiceHandlerArgs } from "@vibestudio/shared/serviceHandlers";
import {
  ServiceError,
  verifiedInitiatingUserId,
  type ServiceContext,
} from "@vibestudio/shared/serviceDispatcher";
import type { WorkspaceChildHubPort } from "../workspaceChildHubPort.js";

type Methods = typeof chronologMethods;
type Input<M extends keyof Methods> = z.output<Methods[M]["args"]>[0];
type Result<M extends keyof Methods> = z.output<Methods[M]["returns"]>;
type SigningPrincipal = Awaited<ReturnType<WorkspaceChildHubPort["chronologPrincipal"]>>;

/** Host-only endpoint of a workspace's native Chronolog node. */
export interface ChronologWorkspaceData {
  /** Decode and validate exact canonical bytes without signing or changing state. */
  reviewProgram(input: Input<"transact">, signal?: AbortSignal): Promise<readonly string[]>;
  transact(
    principal: SigningPrincipal,
    input: Input<"transact">,
    signal?: AbortSignal
  ): Promise<Result<"transact">>;
  outcome(
    publicKey: string,
    input: Input<"outcome">,
    signal?: AbortSignal
  ): Promise<Result<"outcome">>;
  query(publicKey: string, input: Input<"query">, signal?: AbortSignal): Promise<Result<"query">>;
  subscribe(publicKey: string, input: Input<"subscribe">, signal?: AbortSignal): Promise<Response>;
}

function account(ctx: ServiceContext): string {
  const userId = verifiedInitiatingUserId(ctx);
  if (!userId)
    throw new ServiceError("chronolog", "", "Chronolog requires a verified account", "EACCES");
  return userId;
}

interface PreparedTransaction {
  readonly userId: string;
  readonly input: Input<"transact">;
}

export function createChronologService({
  hub,
  data,
}: {
  hub: Pick<WorkspaceChildHubPort, "chronologPrincipal" | "chronologPublicPrincipal">;
  data: ChronologWorkspaceData;
}): ServiceDefinition {
  const publicPrincipal = async (ctx: ServiceContext) =>
    (await hub.chronologPublicPrincipal({ userId: account(ctx) }, { signal: ctx.signal }))
      .publicKey;

  return {
    name: "chronolog",
    description: "Read and write authenticated Chronolog groups from this workspace.",
    authority: { principals: [...CHRONOLOG_PRINCIPALS] },
    methods: chronologMethods,
    authorityPreparation: {
      [CHRONOLOG_TRANSACTION_RESOLVER]: async (ctx, args) => {
        const userId = account(ctx);
        const [input] = parseServiceHandlerArgs(chronologMethods.transact, args);
        const steps = await data.reviewProgram(input, ctx.signal);
        const resource = { type: "chronolog-group", label: "Chronolog group", value: input.group };
        return preparedAuthorityState(
          [
            fixedPreparedAuthoritySelection({
              capability: chronologMethods.transact.capability,
              resourceKey: input.group,
              challenge: {
                title: "Write to a Chronolog group",
                deniedReason: "Signing this Chronolog transaction was denied.",
                resource,
                operation: { kind: "workspace", verb: "write to the group", object: resource },
                allowedDecisions: ["once", "deny"],
                substance: {
                  kind: "change-set",
                  summary: "Sign and submit this change program",
                  facts: steps.map((value, index) => ({ label: `Step ${index + 1}`, value })),
                },
                details: [
                  { label: "Operation ID", value: input.operationId, format: "code" },
                  ...(input.basedOn
                    ? [
                        {
                          label: "Reviewed revision",
                          value: input.basedOn.point.root,
                          format: "code" as const,
                        },
                      ]
                    : []),
                ],
              },
            }),
          ],
          { userId, input } satisfies PreparedTransaction
        );
      },
    },
    handler: defineServiceHandler("chronolog", chronologMethods, {
      transact: async (ctx) => {
        const { userId, input } = preparedAuthorityPayload<PreparedTransaction>(
          ctx,
          CHRONOLOG_TRANSACTION_RESOLVER
        );
        if (userId !== account(ctx))
          throw new ServiceError(
            "chronolog",
            "transact",
            "The initiating account changed before signing",
            "EACCES"
          );
        ctx.signal?.throwIfAborted();
        const signer = await hub.chronologPrincipal({ userId }, { signal: ctx.signal });
        ctx.signal?.throwIfAborted();
        return data.transact(signer, input, ctx.signal);
      },
      outcome: async (ctx, [input]) => data.outcome(await publicPrincipal(ctx), input, ctx.signal),
      query: async (ctx, [input]) => data.query(await publicPrincipal(ctx), input, ctx.signal),
      subscribe: async (ctx, [input]) =>
        data.subscribe(await publicPrincipal(ctx), input, ctx.signal),
    }),
  };
}
