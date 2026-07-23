import type { TestCase } from "../types.js";
import {
  completedToolNames,
  findLastAgentMessage,
  getToolCalls,
  incompleteToolCalls,
} from "./_helpers.js";

function completedEvalFileRoundTrip(result: Parameters<typeof getToolCalls>[0]): boolean {
  return getToolCalls(result).some((call) => {
    if (call.name !== "eval" || call.execution?.status !== "complete" || call.execution.isError) {
      return false;
    }
    const code = call.arguments?.["code"];
    return (
      typeof code === "string" &&
      /\bfs\.(?:writeFile|write)\s*\(/.test(code) &&
      /\bfs\.(?:readFile|read)\s*\(/.test(code)
    );
  });
}

function codeLoadsRuntimeModule(code: string): boolean {
  return (
    /\bimport\s*\(/u.test(code) ||
    /\bimport\s+(?:[\s\S]*?\s+from\s+)?["'][^"']+["']/u.test(code)
  );
}

export const smokeTests: TestCase[] = [
  {
    name: "eval-return-value",
    description: "Agent computes a value and reports it",
    category: "smoke",
    prompt:
      "What is the factorial of 5? Verify the computation using the workspace before telling me the result.",
    validate: (result) => {
      const completed = completedToolNames(result);
      if (!completed.has("eval")) {
        return {
          passed: false,
          reason: `Expected a completed eval tool call; completed tools: ${[...completed].join(", ") || "(none)"}`,
        };
      }
      const msg = findLastAgentMessage(result);
      const verified = getToolCalls(result).some(
        (call) =>
          call.name === "eval" &&
          call.execution?.status === "complete" &&
          call.execution.isError !== true &&
          typeof call.arguments?.["code"] === "string" &&
          JSON.stringify(call.execution.result ?? "").includes("120")
      );
      const hasResult = verified && /\b120\b/.test(msg);
      return {
        passed: hasResult,
        reason: hasResult
          ? undefined
          : "Expected a successful runtime computation whose canonical result and natural-language report both establish 120",
      };
    },
  },
  {
    name: "fs-write-read",
    description: "Agent writes a file and reads it back",
    category: "smoke",
    prompt: "Exercise a basic file write/read round-trip.",
    validate: (result) => {
      const completed = completedToolNames(result);
      const missing = ["write", "read"].filter((name) => !completed.has(name));
      // The sandbox skill documents two equally supported file surfaces:
      // dedicated file tools and server-side eval's runtime `fs` API. Require
      // concrete completed invocation evidence for either; do not force an
      // agent away from the natural eval path merely to satisfy card names.
      if (missing.length > 0 && !completedEvalFileRoundTrip(result)) {
        return {
          passed: false,
          reason: `Expected completed write/read tools or one completed eval using both fs.writeFile and fs.readFile. Completed: ${[...completed].join(", ") || "(none)"}`,
        };
      }
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasWriteRead =
        lower.includes("wrote") ||
        lower.includes("read") ||
        lower.includes("content") ||
        lower.includes("match");
      return {
        passed: hasWriteRead,
        reason: hasWriteRead
          ? undefined
          : `Expected write/read confirmation, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "build-service",
    description: "Agent imports a workspace package and inspects exports",
    category: "smoke",
    prompt:
      "Choose a workspace package and tell me what it actually exposes when loaded at runtime.",
    validate: (result) => {
      const completed = completedToolNames(result);
      if (!completed.has("eval")) {
        return {
          passed: false,
          reason: `Expected a completed eval tool call; completed tools: ${[...completed].join(", ") || "(none)"}`,
        };
      }
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const loadedPackage = getToolCalls(result).some(
        (call) =>
          call.name === "eval" &&
          call.execution?.status === "complete" &&
          call.execution.isError !== true &&
          typeof call.arguments?.["code"] === "string" &&
          codeLoadsRuntimeModule(call.arguments["code"])
      );
      const hasExports =
        loadedPackage &&
        (lower.includes("export") ||
          lower.includes("function") ||
          lower.includes("module") ||
          lower.includes("import"));
      return {
        passed: hasExports,
        reason: hasExports ? undefined : `Expected export information, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "file-search-read-tools",
    description:
      "Agent exercises write, find, grep, and read through the default file-tool surface",
    category: "smoke",
    prompt:
      "Leave a small temporary workspace note containing the distinctive text agentic-file-tools-smoke, then verify that you can rediscover and read the exact note by searching the workspace. Tell me what you observed.",
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      if (!msg.trim()) return { passed: false, reason: "No agent response received" };
      const calls = getToolCalls(result);
      const completed = completedToolNames(result);
      const missing = ["write", "find", "grep", "read"].filter((name) => !completed.has(name));
      if (missing.length > 0) {
        return {
          passed: false,
          reason: `Expected completed tool calls for ${missing.join(", ")}. Completed: ${[...completed].join(", ") || "(none)"}`,
        };
      }
      const incomplete = incompleteToolCalls(result);
      if (incomplete.length > 0) {
        return {
          passed: false,
          reason: `Expected no pending/error tool calls, got: ${incomplete.map((c) => `${c.name}:${c.execution?.status ?? "unknown"}`).join(", ")}`,
        };
      }
      const write = calls.find(
        (call) =>
          call.name === "write" &&
          call.execution?.status === "complete" &&
          call.execution.isError !== true &&
          typeof call.arguments?.["path"] === "string" &&
          typeof call.arguments?.["content"] === "string" &&
          call.arguments["content"].includes("agentic-file-tools-smoke")
      );
      const path = write?.arguments?.["path"];
      const grep = calls.find(
        (call) =>
          call.name === "grep" &&
          call.execution?.status === "complete" &&
          call.execution.isError !== true &&
          call.arguments?.["pattern"] === "agentic-file-tools-smoke"
      );
      const read = calls.find(
        (call) =>
          call.name === "read" &&
          call.execution?.status === "complete" &&
          call.execution.isError !== true &&
          typeof path === "string" &&
          call.arguments?.["path"] === path &&
          JSON.stringify(call.execution.result ?? "").includes("agentic-file-tools-smoke")
      );
      const find = calls.find(
        (call) =>
          call.name === "find" &&
          call.execution?.status === "complete" &&
          call.execution.isError !== true
      );
      const hasEvidence = Boolean(write && find && grep && read);
      return {
        passed: hasEvidence,
        reason: hasEvidence
          ? undefined
          : "Completed file-tool calls did not identity-join the written marker path to an exact successful read and content search",
      };
    },
  },
];
