import type { TestCase } from "../types.js";
import { finalMessageHasAll, noIncompleteInvocations } from "./_helpers.js";

function checked(result: Parameters<typeof finalMessageHasAll>[0], markers: string[]) {
  const msg = finalMessageHasAll(result, markers);
  if (!msg.passed) return msg;
  return noIncompleteInvocations(result);
}

export const cdpGadDiagnosticTests: TestCase[] = [
  {
    name: "cdp-click-type-evaluate",
    description: "Automate a browser page",
    category: "cdp-gad-diagnostics",
    prompt: "Automate a tiny disposable browser page. Finish with CDP_PLAYWRIGHT_OK, clicked, evaluated, and screenshot.",
    validate: (result) => checked(result, ["CDP_PLAYWRIGHT_OK", "clicked", "evaluated", "screenshot"]),
  },
  {
    name: "panel-stateargs-cdp-roundtrip",
    description: "Inspect panel state after a change",
    category: "cdp-gad-diagnostics",
    prompt: "Open a workspace panel, change its state, and inspect it. Finish with STATEARGS_CDP_OK, STATEARGS_CDP_OK_2, snapshot, and stateArgs.",
    validate: (result) => checked(result, ["STATEARGS_CDP_OK", "STATEARGS_CDP_OK_2", "snapshot", "stateArgs"]),
  },
  {
    name: "gad-integrity-diagnostics",
    description: "Run a GAD health check",
    category: "cdp-gad-diagnostics",
    prompt: "Run a quick GAD health check. Finish with GAD_DIAGNOSTICS_OK, storage, publication, turn, invocation, hashes, and integrity.",
    validate: (result) => checked(result, ["GAD_DIAGNOSTICS_OK", "storage", "publication", "turn", "invocation", "hashes", "integrity"]),
  },
  {
    name: "gad-branch-file-diff-probe",
    description: "Probe GAD branch and state inspection",
    category: "cdp-gad-diagnostics",
    prompt: "Probe GAD branch and state inspection. Finish with GAD_BRANCH_OK, branch-files, state-probe, and controlled-errors.",
    validate: (result) => checked(result, ["GAD_BRANCH_OK", "branch-files", "state-probe", "controlled-errors"]),
  },
];
