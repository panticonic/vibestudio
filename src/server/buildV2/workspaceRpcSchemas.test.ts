import { describe, expect, it } from "vitest";
import { buildDiagnosticSchema } from "@vibestudio/service-schemas/build";
import {
  unknownWorkspaceRpcSchemaError,
  unknownWorkspaceRpcSchemaMessage,
  workspaceRpcSchema,
} from "./workspaceRpcSchemas.js";
import { BuildDiagnosticsError, diagnosticsFromError } from "./diagnostics.js";

describe("workspace RPC schemas", () => {
  it("explains that application protocols do not name a host-owned rpcSchema", () => {
    expect(workspaceRpcSchema("taskflow.tasks.v1")).toBeUndefined();
    expect(
      unknownWorkspaceRpcSchemaMessage({
        repoPath: "workers/taskflow-store",
        className: "TaskFlowStore",
        rpcSchema: "taskflow.tasks.v1",
      })
    ).toContain("must omit package.json#vibestudio.durable.classes[].rpcSchema");
  });

  it("attaches the exact removal field and canonical declaration location as a structured repair", () => {
    const error = unknownWorkspaceRpcSchemaError({
      repoPath: "workers/taskflow-store",
      className: "TaskFlowStore",
      rpcSchema: "taskflow.tasks.v1",
    });
    expect(error).toBeInstanceOf(BuildDiagnosticsError);
    // The throw path reaches reports through diagnosticsFromError unchanged.
    const [diagnostic] = diagnosticsFromError(error);
    expect(diagnostic).toMatchObject({
      source: "schema",
      severity: "error",
      file: "workers/taskflow-store/package.json",
      message: expect.stringContaining(
        "must omit package.json#vibestudio.durable.classes[].rpcSchema"
      ),
      repair: {
        code: "application-protocol-declaration",
        remove: {
          file: "workers/taskflow-store/package.json",
          field: 'vibestudio.durable.classes[className="TaskFlowStore"].rpcSchema',
        },
        declareAt: { file: "meta/vibestudio.yml", field: "services[].protocols" },
        docsId: "runtime:workerRuntime.workers.resolveService",
      },
    });
    // The repair survives the public wire schema (buildDiagnosticSchema is strict).
    expect(buildDiagnosticSchema.parse(diagnostic).repair).toEqual(diagnostic!.repair);
  });
});
