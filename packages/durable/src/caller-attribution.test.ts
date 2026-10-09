import { describe, expect, it } from "vitest";
import { attachRpcDiagnosticId, RpcBoundaryError } from "@vibestudio/rpc";
import { DurableObjectBase, rpc } from "./index.js";
import { createTestDO, createTestDirectAuthority } from "./test-utils.js";

class CallerProbe extends DurableObjectBase {
  protected createTables(): void {}
  @rpc({
    website: { kind: "closed", reason: "Caller attribution fixture" },
    principals: ["code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "read",
    crossWorkspace: true,
  })
  inspectCaller() {
    return this.caller;
  }
  @rpc({
    website: { kind: "closed", reason: "Local caller attribution fixture" },
    principals: ["code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "read",
  })
  inspectLocalCaller() {
    return this.caller;
  }
  @rpc({
    website: { kind: "closed", reason: "Failure projection fixture" },
    principals: ["code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "read",
  })
  reportFailure(kind: "protocol" | "application") {
    const error = new RpcBoundaryError(
      "Original receiver failure",
      kind,
      "RECEIVER_FAILED",
      undefined,
      {
        operation: "reportFailure",
      }
    );
    attachRpcDiagnosticId(error, "ca91003e-5630-479c-8c49-640c9a0fd644");
    throw error;
  }
}

describe("durable receiver caller attribution", () => {
  for (const [kind, status] of [
    ["protocol", 400],
    ["application", 500],
  ] as const) {
    it(`retains ${kind} failure fields through method-path HTTP status ${status}`, async () => {
      const { instance, db } = await createTestDO(CallerProbe);
      try {
        const response = await instance.fetch(
          new Request("http://test/test-key/reportFailure", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              args: [kind],
              __instanceToken: "token",
              __instanceId: "do:internal/WorkspaceDO:test-key",
              __caller: {
                callerId: "panel:local",
                callerKind: "panel",
                workspaceId: "test",
                authorization: createTestDirectAuthority({
                  callerKind: "panel",
                  method: "reportFailure",
                }),
              },
            }),
          })
        );
        expect(response.status).toBe(status);
        await expect(response.json()).resolves.toMatchObject({
          error: "Original receiver failure",
          errorCode: "RECEIVER_FAILED",
          errorKind: kind,
          errorData: { operation: "reportFailure" },
          diagnosticId: "ca91003e-5630-479c-8c49-640c9a0fd644",
          errorStack: expect.stringContaining("Original receiver failure"),
        });
      } finally {
        db.close();
      }
    });
  }

  for (const ingress of ["method-path", "envelope"] as const) {
    it(`preserves the source workspace through ${ingress} ingress`, async () => {
      const { instance, callAs, db } = await createTestDO(CallerProbe, {
        WORKSPACE_ID: "test",
      });
      const caller = {
        callerId: "panel:source",
        callerKind: "panel" as const,
        callerPanelId: "panel:tree/source",
        userId: "user:source",
        workspaceId: "source-workspace",
      };
      try {
        if (ingress === "method-path") {
          await expect(callAs(caller, "inspectCaller")).resolves.toEqual(caller);
          const denied = await instance.fetch(
            new Request("http://test/test-key/inspectLocalCaller", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                args: [],
                __instanceToken: "token",
                __instanceId: "do:internal/WorkspaceDO:test-key",
                __caller: {
                  ...caller,
                  authorization: createTestDirectAuthority({
                    callerKind: caller.callerKind,
                    method: "inspectLocalCaller",
                  }),
                },
              }),
            })
          );
          expect(denied.status).toBe(403);
          await expect(denied.json()).resolves.toMatchObject({
            errorCode: "EACCES",
            error: expect.stringContaining("does not accept cross-workspace RPC"),
          });
        } else {
          const deliver = (method: string) =>
            instance.fetch(
              new Request("http://test/test-key/__rpc", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  from: caller.callerId,
                  target: "do:test:TestDO:test-key",
                  delivery: {
                    caller: {
                      ...caller,
                      authorization: createTestDirectAuthority({
                        callerKind: caller.callerKind,
                        method,
                      }),
                    },
                  },
                  provenance: [],
                  message: {
                    type: "request",
                    requestId: `request:${method}`,
                    fromId: caller.callerId,
                    method,
                    args: [],
                  },
                }),
              })
            );
          const response = await deliver("inspectCaller");
          const reply = await response.json();
          expect(reply.message).toEqual({
            type: "response",
            requestId: "request:inspectCaller",
            result: caller,
          });
          const denied = await deliver("inspectLocalCaller");
          const deniedReply = await denied.json();
          expect(deniedReply.message).toMatchObject({
            type: "response",
            requestId: "request:inspectLocalCaller",
            errorCode: "EACCES",
            error: expect.stringContaining("does not accept cross-workspace RPC"),
          });
        }
      } finally {
        db.close();
      }
    });
  }
});
