import { afterEach, expect, it, vi } from "vitest";
import { nativeInvocationId } from "@vibestudio/service-schemas/nativeInvocation";
import {
  inspectOwnedOnboardingCredentialReview,
  openOwnedOnboardingReview,
  ownedOnboardingCredentialReview,
  readOwnedOnboardingFromPanel,
} from "../scripts/lib/desktop-onboarding-reviews.mjs";

afterEach(() => vi.unstubAllGlobals());

function presentationFixture(expanded: boolean, copies = 1, pillCount = 1) {
  let visible = expanded;
  const card = { count: async () => Number(visible), isVisible: async () => visible };
  const nativePage = {
    isClosed: () => false,
    url: () => "native://owned-review",
    locator: vi.fn(() => card),
  };
  const pill = {
    count: async () => pillCount,
    click: vi.fn(async () => {
      visible = true;
    }),
  };
  const page = { locator: vi.fn(() => pill) };
  const app = {
    evaluate: vi.fn(async () => [{ id: 7, url: "native://owned-review" }]),
    context: () => ({ pages: () => Array.from({ length: copies }, () => nativePage) }),
  };
  return { app, page, card, pill, nativePage };
}

it("uses the already expanded original native card without requiring a minimized pill", async () => {
  const f = presentationFixture(true, 1, 0);
  expect(await openOwnedOnboardingReview(f.app, f.page, "owned-review", Date.now() + 1000)).toBe(
    f.card
  );
  expect(f.nativePage.locator).toHaveBeenCalledWith('[data-approval-id="owned-review"]');
  expect(f.page.locator).not.toHaveBeenCalled();
  expect(f.pill.click).not.toHaveBeenCalled();
});

it("expands the minimized native review before selecting its exact owner card", async () => {
  const f = presentationFixture(false);
  expect(await openOwnedOnboardingReview(f.app, f.page, "owned-review", Date.now() + 1000)).toBe(
    f.card
  );
  expect(f.page.locator).toHaveBeenCalledWith("[data-approval-pill]:visible");
  expect(f.pill.click).toHaveBeenCalledOnce();
});

it("refuses duplicate expanded cards before any presentation action", async () => {
  const f = presentationFixture(true, 2);
  await expect(
    openOwnedOnboardingReview(f.app, f.page, "owned-review", Date.now() + 1000)
  ).rejects.toThrow("multiple visible owner cards");
  expect(f.pill.click).not.toHaveBeenCalled();
});

it("refuses an absent or ambiguous native presentation", async () => {
  for (const count of [0, 2]) {
    const f = presentationFixture(false, 1, count);
    await expect(
      openOwnedOnboardingReview(f.app, f.page, "owned-review", Date.now() + 1000)
    ).rejects.toThrow("no unique visible native presentation");
    expect(f.pill.click).not.toHaveBeenCalled();
  }
});

it("never probes an empty or unpresented native view for an onboarding card", async () => {
  const f = presentationFixture(true);
  const hidden = {
    isClosed: () => false,
    url: () => "native://hidden",
    locator: vi.fn(() => {
      throw new Error("Unpresented document probed");
    }),
  };
  const blank = { ...hidden, url: () => "" };
  f.app.context = () => ({ pages: () => [hidden, blank, f.nativePage] });
  expect(await openOwnedOnboardingReview(f.app, f.page, "owned-review", Date.now() + 1000)).toBe(
    f.card
  );
  expect(hidden.locator).not.toHaveBeenCalled();
});

function fixture() {
  const source = {
    owner: {
      runtimeId: "do:workers/agent-worker:AiChatWorker:owned",
      authoritySessionId: "host-lifetime",
      contextId: "owned-context",
      incarnation: "owned-storage",
      channelId: "onboarding",
      source: "workers/agent-worker",
      effectiveVersion: "version",
      className: "AiChatWorker",
      objectKey: "do:workers/agent-worker:AiChatWorker:owned",
      executionDigest: "a".repeat(64),
    },
    task: { conversationId: 4, taskId: 30, kind: "pi.generation", version: 2 },
    operation: {
      kind: "model" as const,
      purpose: "generation" as const,
      attempt: 1,
      cutoff: 35,
      requestDigest: "b".repeat(64),
    },
  };
  const owned = {
    source,
    invocationId: nativeInvocationId(source),
    channelId: "onboarding",
    agentId: "do:workers/agent-worker:AiChatWorker:owned",
    originalUserParticipantId: "user:original-user",
    task: {
      id: 30,
      conversationId: 4,
      kind: "pi.generation",
      version: 2,
      abortRequested: false,
      state: {
        status: "running",
        checkpoint: {
          phase: "request",
          attempt: 1,
          cutoff: 35,
          model: { baseUrl: "https://chatgpt.com/backend-api" },
        },
      },
    },
  };
  const entry = {
    approvalId: "resolve-review",
    kind: "credential",
    lifecycle: { state: "ready" },
    callerKind: "do",
    callerId: "do:workers/agent-worker:AiChatWorker:owned",
    repoPath: "workers/agent-worker",
    effectiveVersion: "version",
    requestedByUserId: "original-user",
    requester: {
      contextId: "owned-context",
      repoPath: "workers/agent-worker",
      effectiveVersion: "version",
    },
    credentialUse: "fetch",
    credentialId: "host-selected-credential",
    allowedDecisions: ["once", "version"],
    operation: { kind: "credential", verb: "use credential" },
    audience: [{ match: "path-prefix", url: "https://chatgpt.com/backend-api" }],
    grantResource: {
      bindingId: "fetch",
      action: "use",
      resource: "https://chatgpt.com/backend-api",
    },
  };
  return { entry, owned };
}

it("keeps source-resolution and actual transport reviews as distinct exact once decisions", () => {
  const f = fixture();
  expect(ownedOnboardingCredentialReview(f.entry, f.owned)).toEqual({
    approvalId: "resolve-review",
    invocationId: f.owned.invocationId,
    credentialId: "host-selected-credential",
    callerId: "do:workers/agent-worker:AiChatWorker:owned",
    endpoint: "https://chatgpt.com/backend-api",
    taskId: 30,
  });
  expect(
    ownedOnboardingCredentialReview({ ...f.entry, approvalId: "transport-review" }, f.owned)
      ?.approvalId
  ).toBe("transport-review");
});

it("binds the raw review account to the canonical channel actor observed in retained run66832", () => {
  const f = fixture();
  const accountUserId = "usr_thQtW7-s7KrYcmMunTgd8Pw4";
  const owned = { ...f.owned, originalUserParticipantId: `user:${accountUserId}` };
  const inspected = inspectOwnedOnboardingCredentialReview(
    { ...f.entry, requestedByUserId: accountUserId },
    owned
  );
  expect(inspected.mismatchFields).toEqual([]);
  expect(inspected.match?.approvalId).toBe(f.entry.approvalId);
  expect(inspected.review.reviewAccountUserId).toBe(accountUserId);
  expect(inspected.review.reviewUserParticipantId).toBe(owned.originalUserParticipantId);
  for (const requestedByUserId of [
    "usr_foreign",
    `user:${accountUserId}`,
    `user:user:${accountUserId}`,
    "",
  ]) {
    const refused = inspectOwnedOnboardingCredentialReview(
      { ...f.entry, requestedByUserId },
      owned
    );
    expect(refused.match).toBeNull();
    expect(refused.mismatchFields).toEqual(["requestedByUserId"]);
  }
});

it("retains the exact rejected user and context facts without capturing credential material", () => {
  const f = fixture();
  const entry = {
    ...f.entry,
    requestedByUserId: "different-original-user",
    requester: { ...f.entry.requester, contextId: "different-context" },
    injection: { valueTemplate: "sensitive-injection" },
    accountIdentity: { providerUserId: "sensitive-account" },
    secret: "sensitive-value",
  };
  const inspected = inspectOwnedOnboardingCredentialReview(entry, f.owned);
  expect(inspected.match).toBeNull();
  expect(inspected.mismatchFields).toEqual(["requestedByUserId", "requesterContextId"]);
  expect(inspected.owned).toMatchObject({
    originalUserParticipantId: "user:original-user",
    contextId: "owned-context",
    invocationId: f.owned.invocationId,
    taskId: 30,
    endpoint: "https://chatgpt.com/backend-api",
  });
  expect(inspected.review).toMatchObject({
    requestedByUserId: "different-original-user",
    requesterContextId: "different-context",
  });
  expect(JSON.stringify(inspected)).not.toContain("sensitive");
  expect(ownedOnboardingCredentialReview(entry, f.owned)).toBeNull();
});

it("identifies the original audience and grant rejection while leaving a broader review untouched", () => {
  const f = fixture();
  const inspected = inspectOwnedOnboardingCredentialReview(
    {
      ...f.entry,
      audience: [{ match: "path-prefix", url: "https://chatgpt.com" }],
      grantResource: { ...f.entry.grantResource, resource: "https://other.test" },
    },
    f.owned
  );
  expect(inspected.match).toBeNull();
  expect(inspected.mismatchFields).toEqual(["audience", "grantResource"]);
  expect(inspected.review.audience).toEqual([
    { match: "path-prefix", endpoint: "https://chatgpt.com" },
  ]);
  expect(inspected.review.grantResource?.endpoint).toBe("https://other.test");
});

it.each(["callerId", "effectiveVersion", "requestedByUserId"] as const)(
  "refuses a foreign %s before any UI decision",
  (field) => {
    const f = fixture();
    expect(ownedOnboardingCredentialReview({ ...f.entry, [field]: "foreign" }, f.owned)).toBeNull();
  }
);

it("refuses a foreign context and a broader or unrelated audience", () => {
  const f = fixture();
  expect(
    ownedOnboardingCredentialReview(
      { ...f.entry, requester: { ...f.entry.requester, contextId: "foreign" } },
      f.owned
    )
  ).toBeNull();
  expect(
    ownedOnboardingCredentialReview(
      { ...f.entry, audience: [{ match: "path-prefix", url: "https://chatgpt.com" }] },
      f.owned
    )
  ).toBeNull();
  expect(
    ownedOnboardingCredentialReview(
      {
        ...f.entry,
        audience: [...f.entry.audience, { match: "path-prefix", url: "https://other.test" }],
      },
      f.owned
    )
  ).toBeNull();
});

it("refuses a retired, canceled, replacement or changed original request", () => {
  const f = fixture();
  for (const task of [
    { ...f.owned.task, id: 31 },
    { ...f.owned.task, abortRequested: true },
    { ...f.owned.task, state: { ...f.owned.task.state, status: "terminal" } },
    {
      ...f.owned.task,
      state: {
        ...f.owned.task.state,
        checkpoint: { ...f.owned.task.state.checkpoint, attempt: 2 },
      },
    },
  ])
    expect(() => ownedOnboardingCredentialReview(f.entry, { ...f.owned, task })).toThrow(
      "exact active native model invocation"
    );
  expect(() =>
    ownedOnboardingCredentialReview(f.entry, { ...f.owned, invocationId: "invented" })
  ).toThrow("exact active native model invocation");
});

it("leaves a non-ready review and a review lacking once untouched", () => {
  const f = fixture();
  expect(
    ownedOnboardingCredentialReview({ ...f.entry, lifecycle: { state: "waiting" } }, f.owned)
  ).toBeNull();
  expect(
    ownedOnboardingCredentialReview({ ...f.entry, allowedDecisions: ["version"] }, f.owned)
  ).toBeNull();
});

it("reads the exact public canonical source and actual native task without a module closure", async () => {
  const f = fixture();
  const prompt = "Original onboarding prompt";
  const inputs = [{ id: 21, type: "input", status: "placed" }];
  const start = {
    kind: "invocation.started",
    actor: { id: f.owned.agentId },
    causality: { invocationId: f.owned.invocationId },
    payload: { nativeSource: f.owned.source },
  };
  const events = [
    {
      kind: "message.completed",
      actor: { kind: "user", id: "user:original-user" },
      payload: { role: "user", blocks: [{ type: "text", content: prompt }] },
    },
    start,
  ];
  vi.stubGlobal("window", {
    __vibestudioStateArgs: { channelName: "onboarding", seed: { openingRequest: prompt } },
  });
  vi.stubGlobal("__vibestudioRequireAsync__", async (name: string) => {
    expect(name).toBe("@workspace/runtime");
    return {
      workers: { resolveService: async () => ({ targetId: "channel-owner" }) },
      rpc: {
        call: async (target: string, method: string) => {
          if (method === "getParticipants") {
            expect(target).toBe("channel-owner");
            return [{ participantId: f.owned.agentId }];
          }
          if (method === "getReplayAfter")
            return { logEvents: events.map((payload) => ({ payload })) };
          expect(target).toBe(f.owned.agentId);
          expect(method).toBe("getDebugState");
          return {
            conversations: {
              onboarding: {
                loaded: true,
                live: { run: { taskId: 30, inputs: [21] } },
                submissions: inputs,
                tasks: [{ record: f.owned.task }],
              },
            },
          };
        },
      },
    };
  });
  // The real Electron route serializes this same function into the actual panel.
  const read = new Function(`return (${readOwnedOnboardingFromPanel.toString()})();`);
  const owned = await read();
  expect(ownedOnboardingCredentialReview(f.entry, owned)?.taskId).toBe(30);
  inputs.push({ id: 22, type: "input", status: "placed" });
  events.push({
    kind: "message.completed",
    actor: { kind: "user", id: "different-user" },
    payload: { role: "user", blocks: [{ type: "text", content: prompt }] },
  });
  await expect(read()).rejects.toThrow("original user input");
});
