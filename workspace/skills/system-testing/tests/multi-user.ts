import type { TestCase, TestExecutionResult } from "../types.js";
import {
  completedScenarioEvidence,
  requireCodeOperations,
  walkArrays,
  walkRecords,
} from "./_scenario-evidence.js";
import { findLastAgentMessage } from "./_helpers.js";

function checked(
  result: TestExecutionResult,
  operations: readonly (readonly string[])[],
  validate: (values: readonly unknown[], final: string) => { passed: boolean; reason?: string }
) {
  const completed = completedScenarioEvidence(result);
  if (!completed.passed) return completed;
  const exercised = requireCodeOperations(completed.evidence.evalCode, operations);
  if (!exercised.passed) return exercised;
  return validate(completed.evidence.evalValues, findLastAgentMessage(result));
}

function firstArray(values: readonly unknown[]): unknown[] | null {
  return walkArrays(values)[0] ?? null;
}

function finalReportsCount(final: string, count: number): boolean {
  return new RegExp(`\\b${count}\\b`, "u").test(final);
}

export const multiUserTests: TestCase[] = [
  {
    name: "account-whoami",
    description: "Identify the user account this session runs as",
    category: "multi-user",
    prompt:
      "Which account is this session acting for? Report the live profile identity without exposing credentials or secrets.",
    validate: (result) =>
      checked(result, [["account.getProfile"]], (values, final) => {
        const profile = walkRecords(values).find(
          (value) => typeof value["userId"] === "string" && typeof value["handle"] === "string"
        );
        if (!profile) return { passed: false, reason: "Account lookup returned no live profile" };
        const handle = profile["handle"] as string;
        const userId = profile["userId"] as string;
        return final.includes(handle) || final.includes(userId)
          ? { passed: true }
          : { passed: false, reason: "Final response did not identify the returned account" };
      }),
  },
  {
    name: "workspace-members",
    description: "List the members of the active workspace",
    category: "multi-user",
    prompt: "Who belongs to this workspace, and what roles do they have?",
    validate: (result) =>
      checked(result, [["account.listWorkspaceMembers"]], (values, final) => {
        const members = firstArray(values);
        if (!members) return { passed: false, reason: "Membership lookup returned no member array" };
        const shaped = members.every((member) => {
          if (!member || typeof member !== "object" || Array.isArray(member)) return false;
          const record = member as Record<string, unknown>;
          return typeof record["handle"] === "string" && typeof record["role"] === "string";
        });
        return shaped && finalReportsCount(final, members.length)
          ? { passed: true }
          : {
              passed: false,
              reason: "Final response did not accurately summarize the returned member roles/count",
            };
      }),
  },
  {
    name: "workspace-presence",
    description: "Report which users are currently present in the workspace",
    category: "multi-user",
    prompt: "Who is currently present in this workspace? An empty presence list is a valid result.",
    validate: (result) =>
      checked(result, [["workspacePresence.list"]], (values, final) => {
        const presence = firstArray(values);
        if (!presence) return { passed: false, reason: "Presence lookup returned no array" };
        return finalReportsCount(final, presence.length) && /(present|presence|online|nobody|no one)/iu.test(final)
          ? { passed: true }
          : { passed: false, reason: "Final response did not summarize the observed presence list" };
      }),
  },
  {
    name: "channel-roster-identity",
    description: "Distinguish human and agent participants in the current channel",
    category: "multi-user",
    prompt: "Who is participating in this conversation, and which participants are people or agents?",
    validate: (result) =>
      checked(result, [["chat.getParticipants"], ["chat.participants"]], (values, final) => {
        const roster = firstArray(values);
        if (!roster) return { passed: false, reason: "Channel inspection returned no participant roster" };
        return /(human|person|user)/iu.test(final) && /agent/iu.test(final)
          ? { passed: true }
          : { passed: false, reason: "Final response did not distinguish people from agents" };
      }),
  },
  {
    name: "hub-workspace-listing",
    description: "List the workspaces known to the hub control plane",
    category: "multi-user",
    prompt: "Which workspaces can this account access through the hub?",
    validate: (result) =>
      checked(result, [["hubControl.listWorkspaces"]], (values, final) => {
        const workspaces = firstArray(values);
        if (!workspaces) return { passed: false, reason: "Hub lookup returned no workspace array" };
        return finalReportsCount(final, workspaces.length) && /workspace/iu.test(final)
          ? { passed: true }
          : { passed: false, reason: "Final response did not summarize the visible workspaces" };
      }),
  },
];
