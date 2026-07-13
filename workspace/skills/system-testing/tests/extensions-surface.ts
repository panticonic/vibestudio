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

export const extensionSurfaceTests: TestCase[] = [
  {
    name: "extension-list",
    description: "List the extensions available in this workspace",
    category: "extensions",
    prompt:
      "Report which extensions are available in this workspace. Finish with EXT_LIST_OK and count:<number>.",
    validate: (result) => {
      const base = checked(result, ["EXT_LIST_OK"]);
      if (!base.passed) return base;
      return finalMessageHasNumericField(result, "count");
    },
  },
  {
    name: "extension-typecheck-unit",
    description: "Typecheck a workspace unit through the typecheck extension",
    category: "extensions",
    prompt:
      "Run a type check over a small existing workspace panel or package using the workspace's supported typecheck surface (not shell commands), and report the diagnostic outcome. Finish with EXT_TYPECHECK_OK and diagnostics:<count>.",
    validate: (result) => checked(result, ["EXT_TYPECHECK_OK", "diagnostics:"]),
  },
  {
    name: "extension-invoke-roundtrip",
    description: "Invoke a harmless extension method and report the structured result",
    category: "extensions",
    prompt:
      "Pick a running extension that exposes a harmless read-only method, invoke it, and report the structured result shape you got back. Finish with EXT_INVOKE_OK and method:<name>, or EXT_INVOKE_UNAVAILABLE with the concrete blocking reason.",
    validate: (result) => {
      const ok = finalMessageHasAll(result, ["EXT_INVOKE_OK", "method:"]);
      if (ok.passed) return noIncompleteInvocations(result);
      return checked(result, ["EXT_INVOKE_UNAVAILABLE"]);
    },
  },
];
