import type { TestCase, TestExecutionResult } from "../types.js";
import {
  completedScenarioEvidence,
  requireCodeOperations,
  walkArrays,
  walkRecords,
} from "./_scenario-evidence.js";
import { findLastAgentMessage } from "./_helpers.js";

function semanticRpc(
  result: TestExecutionResult,
  operations: readonly (readonly string[])[],
  describe: (values: readonly unknown[], final: string) => { passed: boolean; reason?: string }
) {
  const completed = completedScenarioEvidence(result);
  if (!completed.passed) return completed;
  const exercised = requireCodeOperations(completed.evidence.evalCode, operations);
  if (!exercised.passed) return exercised;
  return describe(completed.evidence.evalValues, findLastAgentMessage(result));
}

export const rpcTests: TestCase[] = [
  {
    name: "cross-service-call",
    description: "Call a service and report the result",
    category: "rpc-communication",
    prompt: "Ask the workspace service for the active workspace and summarize its response.",
    validate: (result) =>
      semanticRpc(result, [["workspace.getActive"], ["workspace.getConfig"]], (values, final) => {
        const workspace = walkRecords(values).find(
          (value) =>
            typeof value["name"] === "string" ||
            typeof value["workspace"] === "string" ||
            typeof value["workspaceId"] === "string"
        );
        if (!workspace) {
          return { passed: false, reason: "The completed service call returned no workspace identity" };
        }
        return /workspace/iu.test(final) && /(active|current|name|id|config)/iu.test(final)
          ? { passed: true }
          : { passed: false, reason: "The final response did not explain the returned workspace" };
      }),
  },
  {
    name: "worker-rpc",
    description: "List worker sources via RPC",
    category: "rpc-communication",
    prompt: "Ask the worker service which worker sources can be launched and summarize the result.",
    validate: (result) =>
      semanticRpc(result, [["workers.listSources"]], (values, final) => {
        const sources = walkArrays(values).find((value) =>
          value.every(
            (entry) =>
              entry !== null &&
              typeof entry === "object" &&
              typeof (entry as Record<string, unknown>)["source"] === "string"
          )
        );
        if (!sources) {
          return { passed: false, reason: "The completed worker RPC returned no source array" };
        }
        const reportedCount = final.match(/\b(\d+)\b/u)?.[1];
        return reportedCount !== undefined && Number(reportedCount) === sources.length
          ? { passed: true }
          : {
              passed: false,
              reason: `Final response did not report the observed worker-source count ${sources.length}`,
            };
      }),
  },
];
