import { describe, expect, it } from "vitest";
import ts from "typescript";
import {
  isRetryableSystemTestStatusReadFailure,
  settleSystemTestDoctor,
  settleSystemTestStartup,
  systemTestJsonPageExpression,
  systemTestDoctorRecovery,
  systemTestRunCode,
} from "./systemTestCommands.js";
import { RpcError } from "./rpcClient.js";
import { AuthError } from "./output.js";

describe("system-test status polling", () => {
  it("reopens after a stale one-invocation host attestation", () => {
    expect(
      isRetryableSystemTestStatusReadFailure(
        new RpcError(
          "[eval.get] getRun: host authority attestation nonce was replayed or is outside the receiver's retention bound",
          undefined,
          "application"
        )
      )
    ).toBe(true);
    expect(
      isRetryableSystemTestStatusReadFailure(
        new RpcError("[eval.get] getRun: host authority attestation is bound to another invocation")
      )
    ).toBe(false);
  });
});

describe("system-test doctor infrastructure recovery", () => {
  it("classifies missing pairing as automatically recoverable local infrastructure", () => {
    expect(systemTestDoctorRecovery(new AuthError("not paired"))).toEqual({
      ok: false,
      classification: "infrastructure",
      recoverable: true,
      automaticRecovery: "create_ephemeral_instance",
      command: "pnpm system-test doctor",
      error: "not paired",
      exitCode: 3,
    });
    expect(systemTestDoctorRecovery(new Error("validator failed"))).toBeNull();
  });
});

describe("system-test startup preparation", () => {
  it("waits for approved extension builds to become ready", async () => {
    const results = [
      {
        ok: false,
        checks: [
          {
            name: "required-extensions",
            ok: false,
            detail: "required extensions: file-tools=building, test-runner=pending-approval",
          },
        ],
      },
      {
        ok: true,
        checks: [{ name: "required-extensions", ok: true, detail: "ready" }],
      },
    ];

    await expect(
      settleSystemTestDoctor(async () => results.shift() ?? results[0]!, {
        deadlineMs: 1_000,
        pollMs: 0,
      })
    ).resolves.toMatchObject({ ok: true });
  });

  it("keeps approving startup batches and waits while their extensions reconcile", async () => {
    const pending: Array<{
      kind: "unit-install-review";
      mode: "adopt-root";
      callerId: "system:units";
      approvalId: string;
      parts: Array<{ repoPath: string }>;
    }> = [];
    const resolved: string[] = [];
    let reads = 0;
    const prepared = await settleSystemTestStartup(
      async () => {
        reads += 1;
        if (reads === 1) {
          pending.push({
            kind: "unit-install-review",
            mode: "adopt-root",
            callerId: "system:units",
            approvalId: "approval:late",
            parts: [{ repoPath: "extensions/git-bridge" }],
          });
        }
        return reads < 3
          ? {
              ok: false,
              checks: [
                {
                  name: "required-extensions",
                  ok: false,
                  detail:
                    reads === 1
                      ? "required extensions: git-bridge=pending-approval"
                      : "required extensions: git-bridge=missing",
                },
              ],
            }
          : {
              ok: true,
              checks: [{ name: "required-extensions", ok: true, detail: "ready" }],
            };
      },
      {
        getWorkspaceCreationReviewState: async () =>
          reads < 2 ? { status: "preparing" } : { status: "not-required" },
        listPending: async () => pending.splice(0) as never,
        resolveInstallReview: async (approval) => {
          resolved.push(approval.approvalId);
        },
      },
      { deadlineMs: 1_000, pollMs: 0 }
    );

    expect(prepared.doctor.ok).toBe(true);
    expect(prepared.startupApprovals).toEqual({
      approvedReviewIds: ["approval:late"],
      approvedPartCount: 1,
    });
    expect(resolved).toEqual(["approval:late"]);
  });

  it("does not declare startup ready before a late install review can be published", async () => {
    const review = {
      kind: "unit-install-review" as const,
      mode: "adopt-root" as const,
      callerId: "system:workspace-creation" as const,
      approvalId: "approval:after-first-doctor",
      parts: [{ repoPath: "workers/workspace-source" }],
    };
    let pendingReads = 0;
    let stateReads = 0;
    const resolved: string[] = [];

    const prepared = await settleSystemTestStartup(
      async () => ({
        ok: true,
        checks: [{ name: "required-extensions", ok: true, detail: "ready" }],
      }),
      {
        getWorkspaceCreationReviewState: async () => {
          stateReads += 1;
          if (stateReads === 1) return { status: "preparing" } as const;
          if (stateReads === 2) {
            return {
              status: "pending",
              approvalId: review.approvalId,
              partCount: review.parts.length,
            } as const;
          }
          return { status: "resolved" } as const;
        },
        listPending: async () => {
          pendingReads += 1;
          return (pendingReads === 2 ? [review] : []) as never;
        },
        resolveInstallReview: async (approval) => {
          resolved.push(approval.approvalId);
        },
      },
      { deadlineMs: 1_000, pollMs: 0 }
    );

    expect(prepared.doctor.ok).toBe(true);
    expect(resolved).toEqual(["approval:after-first-doctor"]);
    expect(prepared.startupApprovals.approvedReviewIds).toEqual(["approval:after-first-doctor"]);
    expect(stateReads).toBe(3);
  });

  it("refuses to autoapprove an unrelated adopt-root review", async () => {
    await expect(
      settleSystemTestStartup(
        async () => ({ ok: true }),
        {
          getWorkspaceCreationReviewState: async () => ({ status: "preparing" }),
          listPending: async () =>
            [
              {
                kind: "unit-install-review",
                mode: "adopt-root",
                callerId: "system:template-import",
                approvalId: "approval:unrelated",
                parts: [],
              },
            ] as never,
          resolveInstallReview: async () => undefined,
        },
        { deadlineMs: 1_000, pollMs: 0 }
      )
    ).rejects.toThrow(/unrelated pending approval.*approval:unrelated/i);
  });

  it("returns terminal doctor failures without masking them as startup settling", async () => {
    const result = {
      ok: false,
      checks: [{ name: "model", ok: false, detail: "required Spark model is unavailable" }],
    };
    let reads = 0;

    await expect(
      settleSystemTestDoctor(
        async () => {
          reads += 1;
          return result;
        },
        { deadlineMs: 1_000, pollMs: 0 }
      )
    ).resolves.toBe(result);
    expect(reads).toBe(1);
  });
});

describe("system-test durable driver lifecycle", () => {
  it("uses short start/status/result RPCs and retires the driver after parent unwind", () => {
    const code = systemTestRunCode("st_test", {
      names: ["probe"],
      all: false,
      concurrency: 1,
    });

    expect(code).toContain('"startSystemTestRun"');
    expect(code).toContain('"getSystemTestRunSnapshot"');
    expect(code).toContain('"getSystemTestRunResult"');
    expect(code).not.toContain('"runSystemTests"');
    expect(code).toContain(
      'execution: {\n          surface: "code",\n          source: "workers/system-test-runner"'
    );
    expect(code).not.toContain('kind: "do",\n        source: "workers/system-test-runner"');
    expect(code).toContain("let cancellationCleanup = null");
    expect(code).toContain("let cancellationRequested = false");
    expect(code).toContain("cancellationCleanup = cleanup");
    expect(code).toContain('status: "cancelled"');
    expect(code).toContain("if (cancellationCleanup)");
    expect(code).toContain("await releaseDriverResources()");
    expect(code).toContain('"releaseSystemTestRunResult"');
    expect(code).toContain("let driverResultReleased = false");
    expect(code).toContain('snapshot?.status === "cancelling"');
    expect(code.indexOf("await services.runtime.retireEntity")).toBeLessThan(
      code.indexOf("driverRetired = true")
    );
    const cancellationStart = code.indexOf("ctx.onCancel(async () => {");
    const pollingStart = code.indexOf("for (;;) {", cancellationStart);
    expect(cancellationStart).toBeGreaterThanOrEqual(0);
    expect(pollingStart).toBeGreaterThan(cancellationStart);
    expect(code.slice(cancellationStart, pollingStart)).not.toContain(
      "await releaseDriverResources()"
    );
    expect(code.indexOf('"releaseSystemTestRunResult"')).toBeLessThan(
      code.indexOf("driverResultReleased = true")
    );
    expect(code.indexOf("driverResultReleased = true")).toBeLessThan(
      code.indexOf("await retireDriver()")
    );
    expect(code.indexOf("await retireDriver()")).toBeLessThan(
      code.indexOf("driverResourcesReleased = true")
    );
    expect(code.indexOf("driverRetired = true")).toBeLessThan(
      code.indexOf("driverResourcesReleased = true")
    );
    expect(code.indexOf("cancellationCleanup = cleanup")).toBeLessThan(
      code.lastIndexOf("if (cancellationCleanup)")
    );
    expect(code.indexOf("if (cancellationCleanup)")).toBeLessThan(
      code.lastIndexOf("await releaseDriverResources()")
    );
  });

  it("retries each ordered driver cleanup stage after a lost acknowledgement", async () => {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
      ...args: string[]
    ) => (...args: unknown[]) => Promise<unknown>;
    const run = async (failure: "release" | "retire") => {
      const source = ts.transpile(
        systemTestRunCode(`st_retry_${failure}`, {
          names: ["probe"],
          all: false,
          concurrency: 1,
        }),
        {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
        }
      );
      const execute = new AsyncFunction("services", "rpc", "ctx", "scope", source);
      let releaseAttempts = 0;
      let retirementAttempts = 0;
      const driver = { id: "do:driver", targetId: "do:driver" };
      const services = {
        runtime: {
          createEntity: async () => driver,
          retireEntity: async () => {
            retirementAttempts += 1;
            if (failure === "retire" && retirementAttempts === 1) {
              throw new Error("lost retirement acknowledgement");
            }
          },
        },
      };
      const rpc = {
        call: async (_target: string, method: string) => {
          if (method === "startSystemTestRun") return undefined;
          if (method === "getSystemTestRunSnapshot") {
            return { status: "done", result: { success: true } };
          }
          if (method === "getSystemTestRunResult") {
            return { summary: { runId: `st_retry_${failure}`, passed: 1 } };
          }
          if (method === "releaseSystemTestRunResult") {
            releaseAttempts += 1;
            if (failure === "release" && releaseAttempts === 1) {
              throw new Error("lost release acknowledgement");
            }
            return { released: false };
          }
          throw new Error(`unexpected RPC ${method}`);
        },
      };
      const ctx = {
        contextId: "ctx:test",
        reportProgress: () => undefined,
        onCancel: () => undefined,
      };

      await expect(execute(services, rpc, ctx, {})).rejects.toThrow(
        /System-test driver cleanup failed/
      );
      return { releaseAttempts, retirementAttempts };
    };

    await expect(run("release")).resolves.toEqual({
      releaseAttempts: 2,
      retirementAttempts: 1,
    });
    await expect(run("retire")).resolves.toEqual({
      releaseAttempts: 1,
      retirementAttempts: 2,
    });
  });
});

describe("system-test persisted diagnostic paging", () => {
  it("caches a deterministic reconstruction instead of the shared large-return spill", () => {
    const code = systemTestJsonPageExpression(
      "inspectSystemTestRun(record, {})",
      0,
      1024,
      "__page"
    );

    expect(code).toContain("inspectSystemTestRun(record, {})");
    expect(code).toContain("scope[pageKey] = JSON.stringify(value, null, 2)");
    expect(code).not.toContain("$lastLargeReturn");
    expect(code).toContain("source.slice(0, 1024)");
  });
});
