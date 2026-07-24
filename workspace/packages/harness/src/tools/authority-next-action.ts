import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@workspace/pi-core";

const authorityNextActionSchema = Type.Object(
  {
    service: Type.String({
      description:
        'Exact service name for the action. If mirroring rpc.call("main", "service.method", args), you may pass "main" here and the qualified service.method below.',
    }),
    method: Type.String({
      description:
        'Exact method name, or the qualified service.method used with rpc.call("main", ...).',
    }),
    args: Type.Optional(
      Type.Array(Type.Unknown(), {
        description: "The exact method arguments. Defaults to an empty argument list.",
      })
    ),
  },
  { additionalProperties: false }
);

export type HostAuthorityNextActionInput = Static<typeof authorityNextActionSchema>;

function canonicalOperation(input: HostAuthorityNextActionInput): HostAuthorityNextActionInput {
  if (input.service !== "main") return input;
  const separator = input.method.indexOf(".");
  if (separator <= 0 || separator === input.method.length - 1) return input;
  return {
    service: input.method.slice(0, separator),
    method: input.method.slice(separator + 1),
    ...(input.args ? { args: input.args } : {}),
  };
}

type PreflightLeaf = {
  capability: string;
  resourceKey: string;
  status: "granted" | "consumable-once" | "acquirable" | "denied";
  tier: "open" | "gated" | "critical";
  failure?: {
    reason: string;
    remediation: { message: string };
  };
};

type PreflightResult = {
  decision: "allowed" | "acquirable" | "denied";
  leaves: PreflightLeaf[];
  wouldPrompt?: {
    cardType: "permission.gated" | "permission.outside" | "confirm.critical";
    renderedAction: string;
  };
};

function render(result: PreflightResult, input: HostAuthorityNextActionInput): string {
  const operation = `${input.service}.${input.method}`;
  const rpcCall = `return await rpc.call("main", ${JSON.stringify(operation)}, ${JSON.stringify(input.args ?? [])});`;
  const evalCall = `eval({ syntax: "typescript", code: ${JSON.stringify(rpcCall)} })`;
  if (result.decision === "allowed") {
    return (
      `READY — call \`${evalCall}\` once. No approval is needed. ` +
      "Do not use ask_user; host-service authority is enforced by the RPC call itself."
    );
  }
  if (result.decision === "acquirable") {
    const action = result.wouldPrompt?.renderedAction ?? operation;
    const critical =
      result.wouldPrompt?.cardType === "confirm.critical"
        ? " The user must confirm this exact irreversible action."
        : "";
    return (
      `ASKS FIRST — call \`${evalCall}\` once. ` +
      `Vibestudio will show the user “${action}” and resume the call after their decision.${critical} ` +
      "Do not use ask_user. Do not create another approval, poll, or read the authority guide."
    );
  }
  const reasons = result.leaves
    .filter((leaf) => leaf.status === "denied")
    .map((leaf) => leaf.failure?.remediation.message ?? leaf.failure?.reason)
    .filter((message): message is string => Boolean(message));
  return `BLOCKED — do not retry ${operation}. ${[...new Set(reasons)].join(" ") || "The live authority contract does not allow this action."}`;
}

/**
 * A single bounded authority-orientation tool. It deliberately returns the
 * next executable action instead of making the model open the implementation
 * guide merely to learn whether a normal call will prompt.
 */
export function createHostAuthorityNextActionTool(
  callMain: <T>(method: string, args: unknown[]) => Promise<T>
): AgentTool<typeof authorityNextActionSchema> {
  return {
    name: "host_authority_next_action",
    label: "host_authority_next_action",
    executionMode: "parallel",
    description:
      "Before a protected host-service call, get one live, side-effect-free answer: call now, call once and let Vibestudio ask the user, or stop. This does not accept live workspace-service methods; resolve and call those through the runtime contract shown by docs_open.",
    parameters: authorityNextActionSchema,
    execute: async (_toolCallId, input): Promise<AgentToolResult<PreflightResult>> => {
      const request: HostAuthorityNextActionInput = {
        service: input.service ?? "",
        method: input.method ?? "",
        ...(input.args ? { args: input.args } : {}),
      };
      const operation = canonicalOperation(request);
      const result = await callMain<PreflightResult>("authority.preflight", [
        {
          service: operation.service,
          method: operation.method,
          args: operation.args ?? [],
        },
      ]);
      return {
        content: [{ type: "text", text: render(result, operation) }],
        details: result,
      };
    },
  };
}
