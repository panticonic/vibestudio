import { describe, expect, it } from "vitest";
import { blobstoreMethods } from "../../blobstore.js";
import { browserDataMethods } from "../../browserData.js";
import { extensionsMethods } from "../../extensions.js";
import { gitInteropMethods } from "../../gitInterop.js";
import { runtimeMethods } from "../../runtime.js";
import { vcsMethods, vcsOperationRegistry } from "../../vcs.js";
import { workspaceMethods } from "../../workspace.js";
import { gadMethods, gadWireMethods } from "../../workspaceSource.js";
import {
  BLOBSTORE_METHOD_NAMES,
  BROWSER_DATA_METHOD_NAMES,
  EXTENSIONS_METHOD_NAMES,
  GAD_METHOD_NAMES,
  GAD_WIRE_METHOD_NAMES,
  GIT_INTEROP_METHOD_NAMES,
  COMMAND_BOUND_METHOD_NAMES,
  CONTEXT_BOUND_METHOD_NAMES,
  RUNTIME_METHOD_NAMES,
  VCS_METHOD_NAMES,
  WORKSPACE_METHOD_NAMES,
} from "./runtimeClientMethods.js";

describe("generated lazy runtime client manifests", () => {
  it.each([
    ["runtime", RUNTIME_METHOD_NAMES, runtimeMethods],
    ["workspace", WORKSPACE_METHOD_NAMES, workspaceMethods],
    ["blobstore", BLOBSTORE_METHOD_NAMES, blobstoreMethods],
    ["extensions", EXTENSIONS_METHOD_NAMES, extensionsMethods],
    ["browserData", BROWSER_DATA_METHOD_NAMES, browserDataMethods],
    ["gitInterop", GIT_INTEROP_METHOD_NAMES, gitInteropMethods],
    ["vcs", VCS_METHOD_NAMES, vcsMethods],
    ["gad", GAD_METHOD_NAMES, gadMethods],
    ["gadWire", GAD_WIRE_METHOD_NAMES, gadWireMethods],
  ] as const)("keeps %s names aligned with its canonical schema table", (_name, names, methods) => {
    expect(names).toEqual(Object.keys(methods));
  });

  it("keeps the context-binding projection aligned with the canonical registry", () => {
    expect(Object.keys(CONTEXT_BOUND_METHOD_NAMES)).toEqual(["vcs"]);
    expect(CONTEXT_BOUND_METHOD_NAMES.vcs).toEqual(
      Object.entries(vcsOperationRegistry)
        .filter(([, operation]) =>
          operation.references.some(
            (reference) =>
              reference.kind === "context" &&
              reference.path.length === 1 &&
              reference.path[0] === "contextId"
          )
        )
        .map(([method]) => method)
    );
  });

  it("keeps the command-binding projection aligned with the canonical registry", () => {
    expect(Object.keys(COMMAND_BOUND_METHOD_NAMES)).toEqual(["vcs"]);
    expect(COMMAND_BOUND_METHOD_NAMES.vcs).toEqual(
      Object.entries(vcsOperationRegistry)
        .filter(([, operation]) =>
          operation.references.some(
            (reference) =>
              reference.kind === "command" &&
              reference.path.length === 1 &&
              reference.path[0] === "commandId"
          )
        )
        .map(([method]) => method)
    );
  });
});
