import { describe, expect, it, vi } from "vitest";
import { ServiceError } from "@natstack/shared/serviceDispatcher";
import { createShellApprovalService } from "./shellApprovalService.js";

describe("shellApprovalService", () => {
  it("accepts every approval decision exposed by the consent UI", () => {
    const service = createShellApprovalService({
      approvalQueue: {
        request: vi.fn(),
        requestClientConfig: vi.fn(),
        requestCredentialInput: vi.fn(),
        requestUserland: vi.fn(),
        resolve: vi.fn(),
        resolveUserland: vi.fn(),
        submitClientConfig: vi.fn(),
        submitCredentialInput: vi.fn(),
        listPending: vi.fn(() => []),
      },
    });

    for (const decision of ["once", "session", "version", "repo", "deny", "dismiss"] as const) {
      expect(() => service.methods["resolve"]?.args.parse(["approval-1", decision])).not.toThrow();
    }
  });

  it("validates userland choices against the pending prompt", async () => {
    const resolve = vi.fn();
    const resolveUserland = vi.fn();
    const service = createShellApprovalService({
      approvalQueue: {
        request: vi.fn(),
        requestClientConfig: vi.fn(),
        requestCredentialInput: vi.fn(),
        requestUserland: vi.fn(),
        resolve,
        resolveUserland,
        submitClientConfig: vi.fn(),
        submitCredentialInput: vi.fn(),
        listPending: vi.fn(() => [{
          approvalId: "approval-1",
          callerId: "worker:alpha",
          callerKind: "worker" as const,
          repoPath: "workers/alpha",
          effectiveVersion: "hash-1",
          requestedAt: 10,
          kind: "userland" as const,
          subject: { id: "team-x:foo" },
          title: "Allow foo?",
          options: [{ value: "allow", label: "Allow" }],
        }]),
      },
    });

    await expect(service.handler({ callerId: "shell", callerKind: "shell" }, "resolveUserland", ["approval-1", "allow"]))
      .resolves.toBeUndefined();
    expect(resolveUserland).toHaveBeenCalledWith("approval-1", "allow");

    await expect(service.handler({ callerId: "shell", callerKind: "shell" }, "resolveUserland", ["approval-1", "synthetic"]))
      .rejects.toMatchObject({ name: "ServiceError", code: "EINVAL" });

    await expect(service.handler({ callerId: "shell", callerKind: "shell" }, "resolveUserland", ["approval-1", "dismiss"]))
      .resolves.toBeUndefined();
    expect(resolve).toHaveBeenCalledWith("approval-1", "dismiss");
  });

  it("uses typed errors for missing userland approvals and unknown methods", async () => {
    const service = createShellApprovalService({
      approvalQueue: {
        request: vi.fn(),
        requestClientConfig: vi.fn(),
        requestCredentialInput: vi.fn(),
        requestUserland: vi.fn(),
        resolve: vi.fn(),
        resolveUserland: vi.fn(),
        submitClientConfig: vi.fn(),
        submitCredentialInput: vi.fn(),
        listPending: vi.fn(() => []),
      },
    });

    await expect(service.handler({ callerId: "shell", callerKind: "shell" }, "resolveUserland", ["approval-1", "allow"]))
      .rejects.toMatchObject({ name: "ServiceError", code: "ENOENT" });
    await expect(service.handler({ callerId: "shell", callerKind: "shell" }, "missing", []))
      .rejects.toBeInstanceOf(ServiceError);
  });
});
