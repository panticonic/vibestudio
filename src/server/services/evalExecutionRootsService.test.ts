import { describe, expect, it, vi } from "vitest";
import type { ExecutionAdmissionFact } from "@vibestudio/rpc";
import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import type { Sha256 } from "@vibestudio/shared/execution/identity";
import {
  executionArtifactDigest,
  executionSourceClosureDigest,
  type ExecutionArtifactRefV1,
} from "@vibestudio/shared/execution/retention";
import { createEvalExecutionRootsService } from "./evalExecutionRootsService.js";

const runtimeId = "do:vibestudio/internal:EvalDO:object-one";
const runId = "run:one";

function artifact(): ExecutionArtifactRefV1 {
  const effectiveVersion = "e".repeat(64) as Sha256;
  const buildKey = "b".repeat(64) as Sha256;
  const artifactDigest = "a".repeat(64) as Sha256;
  const contentRoots = [{ repoPath: "packages/example", stateHash: `state:${"c".repeat(64)}` }];
  const sourceState = {
    kind: "workspace" as const,
    workspaceId: "workspace:one",
    effectiveVersion,
    state: { kind: "event" as const, eventId: "event:one" },
    contentRoots,
    sourceClosureDigest: executionSourceClosureDigest(contentRoots),
  };
  return {
    version: 1,
    sourceState,
    recipeDigest: buildKey,
    buildKey,
    artifactDigest,
    executionDigest: executionArtifactDigest({
      version: 1,
      sourceState,
      recipeDigest: buildKey,
      buildKey,
      artifactDigest,
    }),
  };
}

function execution(): ExecutionAdmissionFact {
  return {
    v: 2,
    authoritySessionId: "authority:one",
    authoritySessionVersion: 1,
    admissionKey: "eval:one",
    controllerRuntimeId: "agent:one",
    mode: "interactive",
    ownerUser: "user:one",
    workspaceId: "workspace:one",
    contextId: "context:one",
    agentBinding: null,
    taskRef: "task:one",
    taskAuthority: "task:one",
    executionImage: {
      principal: `code:vibestudio/internal@one`,
      repoPath: "vibestudio/internal",
      ref: "state:one",
      effectiveVersion: "one",
      executionDigest: "d".repeat(64),
    },
    executor: {
      kind: "eval",
      runtimeId,
      evalRunId: runId,
      authorityManifest: {
        mode: "adaptive",
        effects: "read-write",
        approvals: "prompt",
        requests: [],
        digest: "f".repeat(64),
      },
    },
    parent: null,
    causalParent: null,
    issuedAt: 1,
    expiresAt: Number.MAX_SAFE_INTEGER,
    nonce: "execution-session-nonce",
  };
}

function context(): ServiceContext {
  return {
    caller: {
      runtime: { id: runtimeId, kind: "do" },
      code: {
        callerId: runtimeId,
        callerKind: "do",
        repoPath: "vibestudio/internal",
        effectiveVersion: "one",
        executionDigest: "d".repeat(64),
        requested: [],
      },
      subject: { userId: "one", handle: "one" },
    },
  };
}

describe("eval execution root publication ingress", () => {
  it.each(["kernel", "code-owner"])(
    "journals the exact artifact with %s attribution",
    async (attribution) => {
      const reserve = vi.fn(() => ({ reservationId: "reservation:one", epoch: 1 }));
      const finalize = vi.fn();
      const dispatch = vi.fn(async () => undefined);
      const service = createEvalExecutionRootsService({
        executionSessions: { resolve: () => execution(), resolveInvocation: () => execution() },
        publicationPort: { reserve, finalize },
        doDispatch: { dispatch } as never,
        entityStore: {
          cache: {
            resolveActive: () => ({
              id: runtimeId,
              kind: "do",
              className: "EvalDO",
              source: { repoPath: "vibestudio/internal", effectiveVersion: "one" },
              contextId: "context:one",
              activeExecutionDigest: "d".repeat(64),
            }),
          },
        } as never,
      });
      const ref = artifact();
      const ctx = context();
      if (attribution === "code-owner") {
        ctx.caller.code = {
          ...ctx.caller.code!,
          repoPath: "workers/owner",
          executionDigest: "e".repeat(64),
          evalOrigin: { ownerId: "do:workers/owner:Owner:one" },
        };
      }

      await expect(
        service.handler(ctx, "retain", [runId, "@workspace/example", ref])
      ).resolves.toEqual({ retained: true });
      expect(reserve).toHaveBeenCalledWith({
        owner: "eval-run",
        ownerId: `${runtimeId}:${runId}:@workspace/example`,
        artifacts: [{ buildKey: ref.buildKey, executionDigest: ref.executionDigest }],
      });
      expect(dispatch).toHaveBeenCalledWith(
        { source: "vibestudio/internal", className: "EvalDO", objectKey: "object-one" },
        "retainExecutionRoot",
        runId,
        "@workspace/example",
        ref
      );
      expect(finalize).toHaveBeenCalledWith({ reservationId: "reservation:one", epoch: 1 });
    }
  );

  it.each(["wrong-run", "evaluated-code", "website-code", "wrong-kernel"])(
    "rejects %s at the sealed kernel boundary",
    async (kind) => {
      const service = createEvalExecutionRootsService({
        executionSessions: { resolve: () => execution(), resolveInvocation: () => execution() },
        publicationPort: { reserve: vi.fn(), finalize: vi.fn() } as never,
        doDispatch: { dispatch: vi.fn() } as never,
        entityStore: {
          cache: {
            resolveActive: () => ({
              id: runtimeId,
              kind: "do",
              className: "EvalDO",
              source: {
                repoPath: kind === "wrong-kernel" ? "workers/forged" : "vibestudio/internal",
                effectiveVersion: "one",
              },
              contextId: "context:one",
              activeExecutionDigest: "d".repeat(64),
            }),
          },
        } as never,
      });

      const ctx = context();
      if (kind === "evaluated-code") ctx.caller.executionSession = execution();
      if (kind === "website-code")
        ctx.caller.executionAuthority = { kind: "website", website: {} } as never;
      await expect(
        service.handler(ctx, "retain", [
          kind === "wrong-run" ? "run:forged" : runId,
          "@workspace/example",
          artifact(),
        ])
      ).rejects.toMatchObject({ code: "EACCES" });
    }
  );
});
