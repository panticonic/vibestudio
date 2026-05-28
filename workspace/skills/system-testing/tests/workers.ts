import type { TestCase } from "../types.js";
import { finalMessageHasAll, noIncompleteInvocations } from "./_helpers.js";

function checked(result: Parameters<typeof finalMessageHasAll>[0], tokens: string[]) {
  const msg = finalMessageHasAll(result, tokens);
  if (!msg.passed) return msg;
  return noIncompleteInvocations(result);
}

export const workerTests: TestCase[] = [
  {
    name: "list-sources",
    description: "List available worker types",
    category: "workers",
    prompt: "Exercise listing worker sources. Finish with WORKER_SOURCES_OK and count.",
    validate: (result) => checked(result, ["WORKER_SOURCES_OK", "count"]),
  },
  {
    name: "create-worker",
    description: "Create a worker instance",
    category: "workers",
    prompt: "Exercise creating and cleaning up a worker. Finish with WORKER_CREATE_OK and destroyed.",
    validate: (result) => checked(result, ["WORKER_CREATE_OK", "destroyed"]),
  },
  {
    name: "list-workers",
    description: "List running worker instances",
    category: "workers",
    prompt: "Exercise listing running workers. Finish with WORKER_LIST_OK and count.",
    validate: (result) => checked(result, ["WORKER_LIST_OK", "count"]),
  },
  {
    name: "create-destroy",
    description: "Create a worker and then destroy it",
    category: "workers",
    prompt: "Exercise worker destruction. Finish with WORKER_DESTROY_OK or WORKER_DESTROY_MISMATCH.",
    validate: (result) => {
      const ok = finalMessageHasAll(result, ["WORKER_DESTROY_OK"]);
      if (ok.passed) return noIncompleteInvocations(result);
      return checked(result, ["WORKER_DESTROY_MISMATCH"]);
    },
  },
  {
    name: "call-do-method",
    description: "Call a method on a Durable Object worker",
    category: "workers",
    prompt: "Exercise calling a worker Durable Object. Finish with WORKER_DO_OK or WORKER_DO_UNAVAILABLE.",
    validate: (result) => {
      const ok = finalMessageHasAll(result, ["WORKER_DO_OK"]);
      if (ok.passed) return noIncompleteInvocations(result);
      return checked(result, ["WORKER_DO_UNAVAILABLE"]);
    },
  },
  {
    name: "worker-env",
    description: "Create a worker with environment variables",
    category: "workers",
    prompt: "Exercise worker environment configuration. Finish with WORKER_ENV_OK or WORKER_ENV_UNOBSERVABLE.",
    validate: (result) => {
      const ok = finalMessageHasAll(result, ["WORKER_ENV_OK"]);
      if (ok.passed) return noIncompleteInvocations(result);
      return checked(result, ["WORKER_ENV_UNOBSERVABLE"]);
    },
  },
];
