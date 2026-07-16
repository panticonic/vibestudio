import { describe, expect, it, vi } from "vitest";
import {
  createSemanticControlPlaneCaller,
  hasExactCausalInvocation,
  SEMANTIC_CONTROL_PLANE,
  semanticControlPlaneEnvironment,
  type SemanticControlPlaneCaller,
} from "./controlPlane.js";

describe("semantic control-plane topology", () => {
  it("binds the hub-issued workspace identity independently of the object storage key", () => {
    expect(semanticControlPlaneEnvironment("ws_authoritative")).toEqual({
      WORKSPACE_ID: "ws_authoritative",
    });
    expect(SEMANTIC_CONTROL_PLANE.objectKey).toBe("workspace-semantic-control-plane");
  });

  it("refuses to construct an authority environment without a workspace identity", () => {
    expect(() => semanticControlPlaneEnvironment("")).toThrow(
      "Semantic control plane requires a workspace identity"
    );
  });

  it("uses one process-local caller for the sealed semantic control plane", async () => {
    const dispatch = vi.fn(async () => ({ ok: true }));
    const caller = createSemanticControlPlaneCaller({ dispatch } as never);

    await expect(caller.call("inspect", { key: "value" })).resolves.toEqual({ ok: true });
    expect(dispatch).toHaveBeenCalledWith(
      {
        source: SEMANTIC_CONTROL_PLANE.source,
        className: SEMANTIC_CONTROL_PLANE.className,
        objectKey: SEMANTIC_CONTROL_PLANE.objectKey,
      },
      "inspect",
      { key: "value" }
    );
  });

  it("validates the complete causal coordinate against the canonical invocation row", async () => {
    const parent = {
      kind: "trajectory-invocation" as const,
      logId: "trajectory:channel:test",
      head: "main",
      invocationId: "invocation:test",
    };
    const call = vi.fn(async () => ({
      rows: [
        {
          log_id: parent.logId,
          head: parent.head,
          invocation_id: parent.invocationId,
        },
      ],
    }));
    const caller: SemanticControlPlaneCaller = {
      call: call as SemanticControlPlaneCaller["call"],
    };

    await expect(hasExactCausalInvocation(caller, parent)).resolves.toBe(true);
    expect(call).toHaveBeenCalledWith("inspectInvocationState", {
      trajectoryId: parent.logId,
      branchId: parent.head,
      invocationId: parent.invocationId,
      limit: 1,
    });

    call.mockResolvedValueOnce({
      rows: [{ log_id: parent.logId, head: parent.head, invocation_id: "invocation:other" }],
    });
    await expect(hasExactCausalInvocation(caller, parent)).resolves.toBe(false);
  });
});
