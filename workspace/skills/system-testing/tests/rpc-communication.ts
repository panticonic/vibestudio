import type { TestCase } from "../types.js";
import { finalMessageHasAll, noIncompleteInvocations } from "./_helpers.js";

function checked(result: Parameters<typeof finalMessageHasAll>[0], tokens: string[]) {
  const msg = finalMessageHasAll(result, tokens);
  if (!msg.passed) return msg;
  return noIncompleteInvocations(result);
}

export const rpcTests: TestCase[] = [
  {
    name: "cross-service-call",
    description: "Call a service and report the result",
    category: "rpc-communication",
    prompt: "Exercise a core RPC call. Finish with RPC_SERVICE_OK and result-shape.",
    validate: (result) => checked(result, ["RPC_SERVICE_OK", "result-shape"]),
  },
  {
    name: "worker-rpc",
    description: "List worker sources via RPC",
    category: "rpc-communication",
    prompt: "Exercise worker-source inspection through RPC. Finish with RPC_WORKERS_OK and count.",
    validate: (result) => checked(result, ["RPC_WORKERS_OK", "count"]),
  },
];
