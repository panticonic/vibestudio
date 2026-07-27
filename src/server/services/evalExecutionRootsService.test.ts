import { describe, expect, it, vi } from "vitest";
import type { AgentExecutionSessionFact } from "@vibestudio/rpc";
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

function execution(): AgentExecutionSessionFact {
  return {
    v: 1,
    authoritySessionId: "authority:one",
    authoritySessionVersion: 1,
    mode: "interactive",
    ownerUser: "user:one",
    workspaceId: "workspace:one",
    contextId: "context:one",
    agentBinding: null,
    taskRef: "task:one",
    harness: {
      principal: `code:vibestudio/internal@${"d".repeat(64)}`,
      repoPath: "vibestudio/internal",
      effectiveVersion: "one",
    },
    eval: {
      runtimeId,
      runId,
      authorityManifest: {
        mode: "adaptive",
        effects: "mutable",
        approvals: "prompt",
        requests: [],
        digest: "f".repeat(64),
      },
    },
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
      executionSession: execution(),
      subject: { userId: "one", handle: "one" },
    },
  };
}

describe("eval execution root publication ingress", () => {
  it("journals the exact artifact around the authenticated EvalDO durable write", async () => {
    const reserve = vi.fn(() => ({ reservationId: "reservation:one", epoch: 1 }));
    const finalize = vi.fn();
    const dispatch = vi.fn(async () => undefined);
    const service = createEvalExecutionRootsService({
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
          }),
        },
      } as never,
    });
    const ref = artifact();

    await expect(
      service.handler(context(), "retain", [runId, "@workspace/example", ref])
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
  });

  it("refuses a run that is not the authenticated execution session", async () => {
    const service = createEvalExecutionRootsService({
      publicationPort: { reserve: vi.fn(), finalize: vi.fn() } as never,
      doDispatch: { dispatch: vi.fn() } as never,
      entityStore: {
        cache: {
          resolveActive: () => ({
            id: runtimeId,
            kind: "do",
            className: "EvalDO",
            source: { repoPath: "vibestudio/internal", effectiveVersion: "one" },
            contextId: "context:one",
          }),
        },
      } as never,
    });

    await expect(
      service.handler(context(), "retain", ["run:forged", "@workspace/example", artifact()])
    ).rejects.toMatchObject({ code: "EACCES" });
  });
});
