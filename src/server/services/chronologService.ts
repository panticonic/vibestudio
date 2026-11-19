import { z } from "zod";
import { decodeRpcJson } from "@vibestudio/rpc";
import {
  CHRONOLOG_CREATE_RESOLVER,
  CHRONOLOG_INVITE_RESOLVER,
  CHRONOLOG_JOIN_RESOLVER,
  CHRONOLOG_PRINCIPALS,
  CHRONOLOG_TRANSACTION_RESOLVER,
  chronologMethods,
} from "@vibestudio/service-schemas/chronolog";
import {
  fixedPreparedAuthoritySelection,
  preparedAuthorityPayload,
  preparedAuthorityState,
  type AuthorityPreparationResolver,
  type ServiceDefinition,
} from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler, parseServiceHandlerArgs } from "@vibestudio/shared/serviceHandlers";
import {
  ServiceError,
  verifiedInitiatingUserId,
  type AuthorityChallengePresentation,
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
  reviewProgram(program: string, signal?: AbortSignal): Promise<readonly string[]>;
  identity(publicKey: string, signal?: AbortSignal): Promise<Result<"groups.identity">>;
  list(publicKey: string, signal?: AbortSignal): Promise<Result<"groups.list">>;
  create(
    principal: SigningPrincipal,
    input: Input<"groups.create">,
    signal?: AbortSignal
  ): Promise<Result<"groups.create">>;
  invite(
    publicKey: string,
    input: Input<"groups.invite">,
    signal?: AbortSignal
  ): Promise<Result<"groups.invite">>;
  join(
    publicKey: string,
    input: Input<"groups.join">,
    signal?: AbortSignal
  ): Promise<Result<"groups.join">>;
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

type WriteMethod = "transact" | "groups.create" | "groups.invite" | "groups.join";
interface PreparedWrite<M extends WriteMethod> {
  readonly userId: string;
  readonly input: Input<M>;
}

const groupResource = (value: string) => ({
  type: "chronolog-group",
  label: "Chronolog group",
  value,
});
const stepsAsFacts = (steps: readonly string[]) =>
  steps.map((value, index) => ({ label: `Step ${index + 1}`, value }));

function prepareWrite<M extends WriteMethod>(
  method: M,
  describe: (
    input: Input<M>,
    signal?: AbortSignal
  ) => Promise<{
    resourceKey: string;
    resource: AuthorityChallengePresentation["resource"];
    title: string;
    summary: string;
    facts?: Array<{ label: string; value: string }>;
    details?: AuthorityChallengePresentation["details"];
  }>
): AuthorityPreparationResolver {
  return async (ctx, args) => {
    const userId = account(ctx);
    const [input] = parseServiceHandlerArgs(chronologMethods[method], args);
    const { resourceKey, resource, title, summary, facts, details } = await describe(
      input,
      ctx.signal
    );
    return preparedAuthorityState(
      [
        fixedPreparedAuthoritySelection({
          capability: chronologMethods[method].capability,
          resourceKey,
          challenge: {
            title,
            deniedReason: "The Chronolog change was denied.",
            resource,
            operation: { kind: "workspace", verb: title, object: resource },
            allowedDecisions: ["once", "deny"],
            substance: { kind: "change-set", summary, facts },
            details,
          },
        }),
      ],
      { userId, input } satisfies PreparedWrite<M>
    );
  };
}

function approvedWrite<M extends WriteMethod>(
  ctx: ServiceContext,
  resolver: string
): PreparedWrite<M> {
  const prepared = preparedAuthorityPayload<PreparedWrite<M>>(ctx, resolver);
  if (prepared.userId !== account(ctx))
    throw new ServiceError(
      "chronolog",
      "",
      "The initiating account changed before approval took effect",
      "EACCES"
    );
  ctx.signal?.throwIfAborted();
  return prepared;
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
      [CHRONOLOG_TRANSACTION_RESOLVER]: prepareWrite("transact", async (input, signal) => ({
        resourceKey: input.group,
        resource: groupResource(input.group),
        title: "Write to a Chronolog group",
        summary: "Sign and submit this change program",
        facts: stepsAsFacts(await data.reviewProgram(input.program, signal)),
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
      })),
      [CHRONOLOG_CREATE_RESOLVER]: prepareWrite("groups.create", async (input, signal) => ({
        resourceKey: input.operationId,
        resource: groupResource(input.name),
        title: "Create a Chronolog group",
        summary: "Create this group with the reviewed SQL schema",
        facts: stepsAsFacts(await data.reviewProgram(input.schema, signal)),
      })),
      [CHRONOLOG_INVITE_RESOLVER]: prepareWrite("groups.invite", async (input) => ({
        resourceKey: input.group,
        resource: groupResource(input.group),
        title: "Invite a Chronolog group member",
        summary: "Admit this account from the specified workspace node",
        facts: [
          { label: "Account key", value: input.member },
          { label: "Workspace node", value: input.node.endpoint.nodeId },
          { label: "Role", value: input.role },
        ],
      })),
      [CHRONOLOG_JOIN_RESOLVER]: prepareWrite("groups.join", async (input) => ({
        resourceKey: input.group,
        resource: groupResource(input.group),
        title: "Join a Chronolog group",
        summary: "Install the signed invitation for this group",
      })),
    },
    handler: defineServiceHandler("chronolog", chronologMethods, {
      "groups.identity": async (ctx) => data.identity(await publicPrincipal(ctx), ctx.signal),
      "groups.list": async (ctx) => data.list(await publicPrincipal(ctx), ctx.signal),
      "groups.create": async (ctx) => {
        const { userId, input } = approvedWrite<"groups.create">(ctx, CHRONOLOG_CREATE_RESOLVER);
        const signer = await hub.chronologPrincipal({ userId }, { signal: ctx.signal });
        ctx.signal?.throwIfAborted();
        return data.create(signer, input, ctx.signal);
      },
      "groups.invite": async (ctx) => {
        const { input } = approvedWrite<"groups.invite">(ctx, CHRONOLOG_INVITE_RESOLVER);
        return data.invite(await publicPrincipal(ctx), input, ctx.signal);
      },
      "groups.join": async (ctx) => {
        const { input } = approvedWrite<"groups.join">(ctx, CHRONOLOG_JOIN_RESOLVER);
        return data.join(await publicPrincipal(ctx), input, ctx.signal);
      },
      transact: async (ctx) => {
        const { userId, input } = approvedWrite<"transact">(ctx, CHRONOLOG_TRANSACTION_RESOLVER);
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

/** Send only private runtime calls over the node's host-authenticated route. */
export function chronologNodeData(
  request: (input: unknown, signal?: AbortSignal) => Promise<Response>
): ChronologWorkspaceData {
  const call = async (
    input: { action: string; [field: string]: unknown },
    signal?: AbortSignal
  ): Promise<Response> => {
    const response = await request(input, signal);
    if (!response.ok) {
      const body = await response.text();
      const detail = /^[A-Z0-9_]{1,120}$/u.test(body)
        ? body
        : "The Chronolog node refused this operation";
      throw new ServiceError(
        "chronolog",
        input.action,
        detail,
        response.status === 403 ? "EACCES" : "EIO"
      );
    }
    return response;
  };
  const read = async <T>(
    body: { action: string; [field: string]: unknown },
    schema: z.ZodType<T>,
    signal?: AbortSignal
  ) => schema.parse(decodeRpcJson(await (await call(body, signal)).text()));
  return {
    reviewProgram: async (program, signal) => {
      const input = { action: "review", program };
      return read(input, z.array(z.string()), signal);
    },
    identity: (publicKey, signal) => {
      const input = { action: "identity", publicKey };
      return read(input, chronologMethods["groups.identity"].returns, signal);
    },
    list: (publicKey, signal) => {
      const input = { action: "list", publicKey };
      return read(input, chronologMethods["groups.list"].returns, signal);
    },
    create: (principal, input, signal) =>
      read(
        { ...input, action: "create", principal },
        chronologMethods["groups.create"].returns,
        signal
      ),
    invite: async (publicKey, input, signal) => {
      const request = { ...input, action: "invite", publicKey };
      const offer = await (await call(request, signal)).text();
      return chronologMethods["groups.invite"].returns.parse({ group: input.group, offer });
    },
    join: (publicKey, input, signal) =>
      read(
        { ...input, action: "join", publicKey, offer: decodeRpcJson(input.offer) },
        chronologMethods["groups.join"].returns,
        signal
      ),
    transact: (principal, input, signal) =>
      read({ ...input, action: "transact", principal }, chronologMethods.transact.returns, signal),
    outcome: (publicKey, input, signal) =>
      read({ ...input, action: "outcome", publicKey }, chronologMethods.outcome.returns, signal),
    query: (publicKey, input, signal) =>
      read({ ...input, action: "query", publicKey }, chronologMethods.query.returns, signal),
    subscribe: (publicKey, input, signal) => {
      const request = { ...input, action: "subscribe", publicKey };
      return call(request, signal);
    },
  };
}
