import type { TestCase } from "../types.js";
import {
  finalMessageHasAll,
  finalMessageHasNumericField,
  noIncompleteInvocations,
} from "./_helpers.js";

function checked(result: Parameters<typeof finalMessageHasAll>[0], tokens: string[]) {
  const msg = finalMessageHasAll(result, tokens);
  if (!msg.passed) return msg;
  return noIncompleteInvocations(result);
}

export const multiUserTests: TestCase[] = [
  {
    name: "account-whoami",
    description: "Identify the user account this session runs as",
    category: "multi-user",
    prompt:
      "Figure out which user account this session is operating on behalf of and report the profile identity without exposing any secrets or tokens. Finish with ACCOUNT_PROFILE_OK and user:<id-or-name>.",
    validate: (result) => checked(result, ["ACCOUNT_PROFILE_OK", "user:"]),
  },
  {
    name: "workspace-members",
    description: "List the members of the active workspace",
    category: "multi-user",
    prompt:
      "Report who has access to the active workspace — list its members and their roles. Finish with MEMBERS_OK and count:<number>.",
    validate: (result) => {
      const base = checked(result, ["MEMBERS_OK"]);
      if (!base.passed) return base;
      return finalMessageHasNumericField(result, "count");
    },
  },
  {
    name: "workspace-presence",
    description: "Report which users are currently present in the workspace",
    category: "multi-user",
    prompt:
      "Find out which users are currently present in this workspace right now and report the presence list (an empty list is a valid answer). Finish with PRESENCE_OK and present:<count>.",
    validate: (result) => checked(result, ["PRESENCE_OK", "present:"]),
  },
  {
    name: "channel-roster-identity",
    description: "Distinguish human and agent participants in the current channel",
    category: "multi-user",
    prompt:
      "Look at who is participating in your current conversation channel and report the roster, distinguishing human participants from agent participants. Finish with CHANNEL_ROSTER_OK, humans:<count>, and agents:<count>.",
    validate: (result) =>
      checked(result, ["CHANNEL_ROSTER_OK", "humans:", "agents:"]),
  },
  {
    name: "hub-workspace-listing",
    description: "List the workspaces known to the hub control plane",
    category: "multi-user",
    prompt:
      "Report which workspaces this server's hub knows about. Finish with HUB_LIST_OK and count:<number>, or HUB_UNAVAILABLE with the concrete blocking reason if the hub control plane is not reachable from this context.",
    validate: (result) => {
      const ok = finalMessageHasAll(result, ["HUB_LIST_OK"]);
      if (ok.passed) {
        const pending = noIncompleteInvocations(result);
        if (!pending.passed) return pending;
        return finalMessageHasNumericField(result, "count");
      }
      return checked(result, ["HUB_UNAVAILABLE"]);
    },
  },
];
