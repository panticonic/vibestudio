import { describe, expect, it } from "vitest";
import { unknownWorkspaceRpcSchemaMessage, workspaceRpcSchema } from "./workspaceRpcSchemas.js";

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
});
