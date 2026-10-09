import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionScope } from "./agent/sessionContext.js";
import {
  loadSystemTestArtifact,
  saveSystemTestRun,
  systemTestRunDir,
  type StoredSystemTestRun,
} from "./systemTestStore.js";
import {
  isRetryableSystemTestStatusReadFailure,
  settleSystemTestDoctor,
  settleSystemTestStartup,
  systemTestDoctorRecovery,
  readSystemTestDriverState,
  failedSummary,
  resultValue,
  retainFailedRunEvidence,
  unavailableTrajectory,
} from "./systemTestCommands.js";
import { RpcError } from "./rpcClient.js";
import { AuthError } from "./output.js";

describe("system-test status polling", () => {
  it("reports orchestration failure even when every completed case passed", () => {
    expect(
      failedSummary({ status: "errored", passed: 1, failed: 0, errored: 0, toolFailureCount: 0 })
    ).toBe(true);
    expect(
      failedSummary({ status: "completed", passed: 1, failed: 0, errored: 0, toolFailureCount: 0 })
    ).toBe(false);
  });
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

  it("does not mistake a permission-dependent model check for failure while creation review is preparing", async () => {
    let reads = 0;
    const prepared = await settleSystemTestStartup(
      async () => {
        reads++;
        return reads === 1
          ? {
              ok: false,
              checks: [{ name: "model", ok: false, detail: "permission review pending" }],
            }
          : { ok: true, checks: [{ name: "model", ok: true, detail: "ready" }] };
      },
      {
        getWorkspaceCreationReviewState: async () =>
          reads === 0 ? { status: "preparing" } : { status: "resolved" },
        listPending: async () => [],
        resolveInstallReview: async () => {},
      },
      { pollMs: 0 }
    );
    expect(prepared.doctor.ok).toBe(true);
    expect(prepared.startupApprovals.creationReviewStatus).toBe("resolved");
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
      creationReviewStatus: "not-required",
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

  it("reapproves a durable startup review slot when its version-bound payload changes", async () => {
    const review = (effectiveVersion: string) =>
      ({
        kind: "unit-install-review" as const,
        mode: "adopt-root" as const,
        callerId: "system:units" as const,
        approvalId: "approval:workspace-startup",
        parts: [
          {
            identityKey: "extension:extensions/mobile-debug",
            effectiveVersion,
            change: "added" as const,
            notableRows: [],
            everydayRows: [],
          },
        ],
      }) as never;
    const pending = [[review("version-one")], [review("version-two")], []];
    const resolvedVersions: string[] = [];
    let doctorReads = 0;

    const prepared = await settleSystemTestStartup(
      async () => {
        doctorReads += 1;
        return doctorReads < 3
          ? {
              ok: false,
              checks: [
                {
                  name: "required-extensions",
                  ok: false,
                  detail: "required extensions: mobile-debug=approval-required",
                },
              ],
            }
          : { ok: true, checks: [{ name: "required-extensions", ok: true, detail: "ready" }] };
      },
      {
        getWorkspaceCreationReviewState: async () => ({ status: "resolved" }),
        listPending: async () => (pending.shift() ?? []) as never,
        resolveInstallReview: async (approval) => {
          resolvedVersions.push(approval.parts[0]!.effectiveVersion);
        },
      },
      { deadlineMs: 1_000, pollMs: 0 }
    );

    expect(prepared.doctor.ok).toBe(true);
    expect(resolvedVersions).toEqual(["version-one", "version-two"]);
    expect(prepared.startupApprovals.approvedReviewIds).toEqual(["approval:workspace-startup"]);
    expect(prepared.startupApprovals.approvedPartCount).toBe(2);
  });

  it("leaves unrelated approvals untouched without blocking a ready test workspace", async () => {
    const resolveInstallReview = vi.fn(async () => undefined);
    await expect(
      settleSystemTestStartup(
        async () => ({ ok: true }),
        {
          getWorkspaceCreationReviewState: async () => ({ status: "not-required" }),
          listPending: async () =>
            [
              {
                kind: "credential",
                approvalId: "approval:unrelated-ui-request",
              },
            ] as never,
          resolveInstallReview,
        },
        { deadlineMs: 1_000, pollMs: 0 }
      )
    ).resolves.toMatchObject({ doctor: { ok: true } });
    expect(resolveInstallReview).not.toHaveBeenCalled();
  });

  it("returns terminal doctor failures without masking them as startup settling", async () => {
    const result = {
      ok: false,
      checks: [{ name: "model", ok: false, detail: "required Luna model is unavailable" }],
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

  it("does not mask a terminal provider failure merely because another extension is building", async () => {
    const result = {
      ok: false,
      checks: [
        {
          name: "required-extensions",
          ok: true,
          detail: "declared workspace extensions are approved and build-ready",
          data: [
            {
              source: "extensions/file-tools",
              name: "@workspace-extensions/file-tools",
              status: "building",
            },
            {
              source: "extensions/external-agent",
              name: "@workspace-extensions/external-agent",
              status: "error",
            },
          ],
        },
        {
          name: "external-agent-extension",
          ok: false,
          detail: "Extension is not installed: @workspace-extensions/external-agent",
        },
      ],
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
  it("observes the durable owner without consulting a separate coordinator", async () => {
    const methods: string[] = [];
    const snapshot = { status: "running", progress: { completed: [{ name: "one" }] } };
    const call = async <T>(method: string): Promise<T> => {
      methods.push(method);
      return snapshot as T;
    };
    expect(await readSystemTestDriverState(call, "st_probe")).toBe(snapshot);
    expect(methods).toEqual(["getSystemTestRunSnapshot"]);
  });

  it("stores a terminal result before releasing execution and remains observable afterward", async () => {
    const methods: string[] = [];
    const summary = { passed: 1 };
    const call = async <T>(method: string): Promise<T> => {
      methods.push(method);
      if (method === "getSystemTestRunSnapshot")
        return { status: "done", result: { success: true } } as T;
      if (method === "getSystemTestRunResult") return { summary } as T;
      if (method === "releaseSystemTestRunExecution") return { released: true } as T;
      throw new Error(`unexpected ${method}`);
    };
    for (let observation = 0; observation < 2; observation++) {
      expect(await readSystemTestDriverState(call, "st_probe")).toMatchObject({
        status: "done",
        result: { success: true, returnValue: summary },
      });
    }
    expect(methods).toEqual([
      "getSystemTestRunSnapshot",
      "getSystemTestRunResult",
      "releaseSystemTestRunExecution",
      "getSystemTestRunSnapshot",
      "getSystemTestRunResult",
      "releaseSystemTestRunExecution",
    ]);
  });

  it("never releases an execution whose status observation failed", async () => {
    const methods: string[] = [];
    const call = async <T>(method: string): Promise<T> => {
      methods.push(method);
      throw new Error("connection reset");
    };
    await expect(readSystemTestDriverState(call, "st_probe")).rejects.toThrow("connection reset");
    expect(methods).toEqual(["getSystemTestRunSnapshot"]);
  });
});

describe("system-test run interrupted mid-suite", () => {
  const interrupted = (completed: Array<{ outcome: string }>, total: number) =>
    ({
      status: "done",
      result: { success: false, error: "eval interrupted by restart" },
      progress: { total, completed },
    }) as unknown as Parameters<typeof resultValue>[0];

  it("hands back the run id, what already finished, and how to read it", () => {
    // A sandbox that dies under a long run leaves every finished test durably
    // recorded. Reporting only "eval interrupted by restart" discards that.
    expect(() =>
      resultValue(
        interrupted(
          [
            { outcome: "passed" },
            { outcome: "passed" },
            { outcome: "failed" },
            { outcome: "errored" },
          ],
          40
        ),
        "st_abc"
      )
    ).toThrow(
      "system-test run st_abc did not finish: eval interrupted by restart. 4 of 40 tests " +
        "completed before it stopped (1 errored, 1 failed, 2 passed); those results are " +
        "preserved: vibestudio system-test inspect st_abc --json"
    );
  });

  it("says only what it knows when nothing had finished", () => {
    expect(() => resultValue(interrupted([], 40), "st_abc")).toThrow(
      "system-test run st_abc did not finish: eval interrupted by restart"
    );
    expect(() => resultValue(interrupted([], 40), "st_abc")).not.toThrow(/preserved/u);
  });

  it("still reports a successful run's own value", () => {
    const done = {
      status: "done",
      result: { success: true, returnValue: { runId: "st_abc", passed: 40 } },
    } as unknown as Parameters<typeof resultValue>[0];
    expect(resultValue(done, "st_abc")).toEqual({ runId: "st_abc", passed: 40 });
  });
});

describe("system-test trajectory with neither source", () => {
  it("offers bounded inspection without promising that an oversized heartbeat retained it", () => {
    const error = unavailableTrajectory(
      "st_abc",
      "browser-panel",
      new Error("No durable system-test record exists for st_abc")
    );

    expect(error.message).toContain("No durable system-test record exists for st_abc");
    expect(error.message).toContain("may omit live inspection too");
    expect(error.message).toContain("vibestudio system-test inspect st_abc --test browser-panel");
  });
});

describe("system-test failure evidence retention", () => {
  const original = process.env["XDG_CONFIG_HOME"];
  const roots: string[] = [];
  afterEach(() => {
    if (original === undefined) delete process.env["XDG_CONFIG_HOME"];
    else process.env["XDG_CONFIG_HOME"] = original;
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  function storedRun(): StoredSystemTestRun {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "system-test-retention-"));
    roots.push(root);
    process.env["XDG_CONFIG_HOME"] = root;
    const runId = "run-retention-test";
    const run: StoredSystemTestRun = {
      schemaVersion: 2,
      runId,
      createdAt: Date.now(),
      serverUrl: "http://127.0.0.1:1",
      sessionName: "test",
      ownerId: "owner",
      contextId: "context",
      runnerEntityId: "runner",
      runnerTargetId: "target",
      artifactDir: systemTestRunDir(runId),
      config: { names: ["alpha", "beta"], all: false, concurrency: 1 },
    };
    saveSystemTestRun(run);
    return run;
  }

  function scopeFor(calls: Array<{ method: string; args: unknown[] }>): SessionScope {
    const trajectories: Record<string, string> = {
      alpha: JSON.stringify({ test: "alpha", events: ["x".repeat(300_000)] }),
      beta: JSON.stringify({ test: "beta", events: [] }),
    };
    return {
      client: {
        callTarget: async (_target: string, method: string, args: unknown[]) => {
          calls.push({ method, args });
          if (method === "inspectSystemTestRun") return { diagnostics: ["alpha failed"] };
          if (method === "readSystemTestTrajectoryPage") {
            const [, name, , offset, limit] = args as [string, string, boolean, number, number];
            const text = trajectories[name]!;
            return {
              length: text.length,
              encoding: "plain-string",
              chunk: text.slice(offset, offset + limit),
            };
          }
          throw new Error(`unexpected ${method}`);
        },
      },
    } as unknown as SessionScope;
  }

  it("keeps the inspection packet and failed tests' full trajectories privately", async () => {
    const run = storedRun();
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const summary = {
      failed: 1,
      failedTests: ["alpha"],
      testsWithUnexpectedToolFailures: ["beta"],
    };
    await retainFailedRunEvidence(scopeFor(calls), run, summary);
    const dir = path.join(run.artifactDir, "failure-evidence");
    expect(loadSystemTestArtifact(run.runId, "inspect", dir)).toEqual({
      diagnostics: ["alpha failed"],
    });
    expect(loadSystemTestArtifact(run.runId, "trajectory-alpha-full", dir)).toMatchObject({
      test: "alpha",
    });
    expect(loadSystemTestArtifact(run.runId, "trajectory-beta-full", dir)).toEqual({
      test: "beta",
      events: [],
    });
    expect(loadSystemTestArtifact(run.runId, "inspect-alpha", dir)).toEqual({
      diagnostics: ["alpha failed"],
    });
    expect(loadSystemTestArtifact(run.runId, "trajectory-alpha", dir)).toMatchObject({
      test: "alpha",
    });
    for (const file of fs.readdirSync(dir)) {
      expect(fs.statSync(path.join(dir, file)).mode & 0o777).toBe(0o600);
    }
    expect(fs.existsSync(path.join(dir, "trajectory-alpha-full.json.gz"))).toBe(true);

    const before = calls.length;
    await retainFailedRunEvidence(scopeFor(calls), run, summary);
    expect(calls).toHaveLength(before);
  });

  it("retains nothing for a passing run", async () => {
    const run = storedRun();
    const calls: Array<{ method: string; args: unknown[] }> = [];
    await retainFailedRunEvidence(scopeFor(calls), run, { passed: 2, failed: 0, errored: 0 });
    expect(calls).toEqual([]);
    expect(fs.existsSync(path.join(run.artifactDir, "failure-evidence"))).toBe(false);
  });
});
