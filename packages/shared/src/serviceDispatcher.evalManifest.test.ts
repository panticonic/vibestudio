import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createVerifiedCaller,
  ServiceDispatcher,
  type ServiceContext,
} from "./serviceDispatcher.js";
import { createTestExecutionSession, testAuthority } from "./serviceDispatcherTestUtils.js";

function setup(input: {
  mode: "adaptive" | "strict";
  approvals: "prompt" | "pregranted-only";
  requests?: Array<{ capability: string; resource: { kind: "exact"; key: string } }>;
  granted: boolean;
}) {
  const capability = "workspace.file.write";
  const resourceKey = "context:one/file.txt";
  const session = createTestExecutionSession({ runtimeId: "do:eval:one", agentBinding: null });
  session.eval.authorityManifest = {
    mode: input.mode,
    effects: "read-write",
    approvals: input.approvals,
    requests: input.requests ?? [],
    digest: "a".repeat(64),
  };
  const caller = createVerifiedCaller(
    "do:eval:one",
    "do",
    null,
    null,
    { userId: "one", handle: "one" },
    session
  );
  const dispatcher = new ServiceDispatcher();
  dispatcher.setAuthorityResolver(({ caller: resolvedCaller }) => {
    const resolved = testAuthority(resolvedCaller, capability, resourceKey);
    return { ...resolved, grants: input.granted ? resolved.grants : [] };
  });
  const request = vi.fn(() => {
    throw new Error("approval queue must not be reached");
  });
  dispatcher.setAuthorityAcquirer({
    request,
    acquire: vi.fn(),
    consume: vi.fn(),
    invalidate: vi.fn(),
  });
  const handler = vi.fn(async () => "written");
  dispatcher.registerService({
    name: "manifestTest",
    description: "manifest test",
    authority: { principals: ["session"] },
    methods: {
      write: {
        args: z.tuple([]),
        capability,
        tier: {
          tier: "gated",
          session: "family",
          rationale: "Evaluated-run authority test effect",
        },
        authority: {
          requirement: {
            kind: "capability",
            principal: "session",
            capability,
          },
          resource: { kind: "literal", key: resourceKey },
        },
        access: { sensitivity: "write" },
      },
    },
    handler,
  });
  dispatcher.markInitialized();
  const context: ServiceContext = { caller };
  return { dispatcher, context, handler, request, capability, resourceKey };
}

describe("evaluated-run authority ceiling", () => {
  it("denies strict missing coverage before a broad live grant can widen the run", async () => {
    const { dispatcher, context, handler } = setup({
      mode: "strict",
      approvals: "prompt",
      granted: true,
    });
    await expect(dispatcher.dispatch(context, "manifestTest", "write", [])).rejects.toMatchObject({
      code: "ERUNMANIFEST",
      errorData: {
        authorityFailure: { reasonCode: "run-manifest-denied" },
      },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("admits an exact strict request through the ordinary grant intersection", async () => {
    const configured = setup({
      mode: "strict",
      approvals: "prompt",
      granted: true,
      requests: [
        {
          capability: "workspace.file.write",
          resource: { kind: "exact", key: "context:one/file.txt" },
        },
      ],
    });
    await expect(
      configured.dispatcher.dispatch(configured.context, "manifestTest", "write", [])
    ).resolves.toBe("written");
  });

  it("never enqueues an approval for pregranted-only runs", async () => {
    const { dispatcher, context, request } = setup({
      mode: "adaptive",
      approvals: "pregranted-only",
      granted: false,
    });
    await expect(dispatcher.dispatch(context, "manifestTest", "write", [])).rejects.toMatchObject({
      code: "ERUNPREGRANTED",
      errorData: {
        authorityFailure: { reasonCode: "run-pregranted-only" },
      },
    });
    expect(request).not.toHaveBeenCalled();
  });
});
