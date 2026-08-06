import { describe, expect, it, vi } from "vitest";
import { createApprovalQueue, type UnitInstallReviewQueueRequest } from "./approvalQueue.js";

function createQueue(overrides: Partial<Parameters<typeof createApprovalQueue>[0]> = {}) {
  const emit = vi.fn();
  const queue = createApprovalQueue({ eventService: { emit } as never, ...overrides });
  return { queue, emit };
}

function unitInstallReviewRequest(
  overrides: Partial<UnitInstallReviewQueueRequest> = {}
): UnitInstallReviewQueueRequest {
  return {
    kind: "unit-install-review" as const,
    callerId: "panel-1",
    callerKind: "panel" as const,
    repoPath: "panels/example",
    effectiveVersion: "hash-1",
    mode: "part-changed" as const,
    title: "Update trusted unit source",
    description: "Accepting this push updates trusted native extension code.",
    units: [
      {
        unitKind: "extension" as const,
        unitName: "@workspace-extensions/typecheck-service",
        displayName: "Typecheck Service",
        version: "1.0.0",
        target: null,
        source: {
          kind: "workspace-repo" as const,
          repo: "extensions/typecheck-service",
          ref: "main",
        },
        ev: "ev-typecheck",
        capabilities: ["node:fs"],
      },
    ],
    configWrite: null,
    ...overrides,
  };
}

describe("approvalQueue", () => {
  it("fails closed when a credential producer omits its decision contract", () => {
    const { queue } = createQueue();
    expect(() =>
      queue.request({
        callerId: "worker:1",
        callerKind: "worker",
        repoPath: "/repo",
        effectiveVersion: "hash-1",
        credentialId: "cred-1",
        credentialLabel: "GitHub",
        audience: [{ url: "https://api.github.com/", match: "origin" }],
        injection: {
          type: "header",
          name: "authorization",
          valueTemplate: "Bearer {token}",
        },
        accountIdentity: { providerUserId: "user-1" },
        scopes: ["repo"],
      } as never)
    ).toThrow("Credential approvals must declare their allowed decisions");
  });

  it("settles aborted requests as deny", async () => {
    const { queue } = createQueue();
    const ac = new AbortController();
    const promise = queue.request({
      callerId: "worker:1",
      callerKind: "worker",
      repoPath: "/repo",
      effectiveVersion: "hash-1",
      allowedDecisions: ["once", "session", "version", "deny"],
      credentialId: "cred-1",
      credentialLabel: "GitHub",
      audience: [{ url: "https://api.github.com/", match: "origin" }],
      injection: {
        type: "header",
        name: "authorization",
        valueTemplate: "Bearer {token}",
      },
      accountIdentity: { providerUserId: "user-1" },
      scopes: ["repo"],
      signal: ac.signal,
    });

    ac.abort();

    await expect(promise).resolves.toBe("deny");
    expect(queue.listPending()).toEqual([]);
  });

  it("includes credential audience in pending approvals", async () => {
    const { queue } = createQueue();
    const promise = queue.request({
      callerId: "worker:1",
      callerKind: "worker",
      repoPath: "/repo",
      effectiveVersion: "hash-1",
      allowedDecisions: ["once", "session", "version", "deny"],
      credentialId: "cred-1",
      credentialLabel: "GitHub",
      audience: [{ url: "https://api.github.com/", match: "origin" }],
      injection: {
        type: "header",
        name: "authorization",
        valueTemplate: "Bearer {token}",
      },
      accountIdentity: { providerUserId: "user-1" },
      scopes: ["repo"],
      bindingLabel: "GitHub repositories",
    });

    expect(queue.listPending()[0]).toMatchObject({
      kind: "credential",
      credentialLabel: "GitHub",
      bindingLabel: "GitHub repositories",
      audience: [{ url: "https://api.github.com/", match: "origin" }],
    });
    queue.resolve(queue.listPending()[0]!.approvalId, "deny");
    await expect(promise).resolves.toBe("deny");
  });

  it("rejects credential decisions outside the exact advertised lifetimes", async () => {
    const { queue } = createQueue();
    const promise = queue.request({
      callerId: "worker:1",
      callerKind: "worker",
      repoPath: "/repo",
      effectiveVersion: "hash-1",
      allowedDecisions: ["once", "session", "version", "deny"],
      credentialId: "cred-1",
      credentialLabel: "GitHub",
      audience: [{ url: "https://api.github.com/", match: "origin" }],
      injection: {
        type: "header",
        name: "authorization",
        valueTemplate: "Bearer {token}",
      },
      accountIdentity: { providerUserId: "user-1" },
      scopes: ["repo"],
    });
    const approvalId = queue.listPending()[0]!.approvalId;

    await expect(queue.resolve(approvalId, "task")).rejects.toThrow(
      "credential approval does not accept decision 'task'"
    );
    expect(queue.listPending()).toHaveLength(1);

    await queue.resolve(approvalId, "deny");
    await expect(promise).resolves.toBe("deny");
  });

  it("supports generic capability approvals", async () => {
    const { queue } = createQueue();
    const promise = queue.request({
      kind: "capability",
      callerId: "panel-1",
      callerKind: "panel",
      repoPath: "panels/example",
      effectiveVersion: "hash-1",
      capability: "external-browser-open",
      title: "Open external browser",
      resource: {
        type: "url-origin",
        label: "Origin",
        value: "https://example.com",
      },
    });

    expect(queue.listPending()[0]).toMatchObject({
      kind: "capability",
      title: "Open external browser",
      capability: "external-browser-open",
    });
    queue.resolve(queue.listPending()[0]!.approvalId, "once");
    await expect(promise).resolves.toBe("once");
  });

  it("preserves the host-verified operation substance bound to the prepared state", async () => {
    const { queue } = createQueue();
    void queue.request({
      kind: "capability",
      callerId: "agent:news",
      callerKind: "worker",
      repoPath: "workers/news-agent",
      effectiveVersion: "hash-1",
      capability: "notification.post",
      title: "Send the nightly briefing",
      resource: {
        type: "channel",
        label: "Recipient",
        value: "Briefings",
      },
      operationSubstance: {
        kind: "send",
        summary: "Send 1 briefing to Briefings",
        detail: "Subject: Overnight workspace summary",
        digest: "prepared:briefing-1",
      },
    });

    expect(queue.listPending()[0]).toMatchObject({
      kind: "capability",
      operationSubstance: {
        kind: "send",
        summary: "Send 1 briefing to Briefings",
        detail: "Subject: Overnight workspace summary",
        digest: "prepared:briefing-1",
      },
    });
    await queue.resolve(queue.listPending()[0]!.approvalId, "dismiss");
  });

  it("attaches structured requester identity from the resolver", async () => {
    const { queue } = createQueue({
      resolveRequester: (input) => ({
        id: input.callerId,
        kind: input.callerKind,
        category: "eval",
        title: "Agentic Chat",
        panel: { id: "panel:chat", title: "Agentic Chat" },
        sourcePath: input.repoPath,
        repoPath: input.repoPath,
        effectiveVersion: input.effectiveVersion,
        stableIdentityKey: input.callerId,
        ephemeralInstanceKey: input.callerId,
        eval: { ownerId: "do:workers/agent:AgentDO:session", subKey: "turn-1" },
        breadcrumbs: [
          { id: "panel:chat", kind: "panel", category: "panel", label: "Agentic Chat" },
          {
            id: input.callerId,
            kind: "do",
            category: "eval",
            label: "Eval turn-1",
          },
        ],
      }),
    });
    void queue.request({
      kind: "capability",
      callerId: "do:vibestudio/internal:EvalDO:one",
      callerKind: "do",
      repoPath: "vibestudio/internal",
      effectiveVersion: "internal",
      capability: "external-browser-open",
      title: "Open external browser",
    });

    expect(queue.listPending()[0]).toMatchObject({
      callerTitle: "Agentic Chat",
      requester: {
        category: "eval",
        panel: { title: "Agentic Chat" },
        eval: { subKey: "turn-1" },
      },
    });
    queue.resolve(queue.listPending()[0]!.approvalId, "deny");
  });

  it("coalesces only exact duplicate decision approvals", async () => {
    const { queue } = createQueue();
    const first = queue.request({
      kind: "capability",
      callerId: "panel-1",
      callerKind: "panel",
      repoPath: "panels/example",
      effectiveVersion: "hash-1",
      capability: "context.boundary",
      title: "Open panel",
      operation: {
        kind: "panel",
        verb: "openPanel",
        object: { type: "panel", label: "Panel", value: "workers/runtime-fixture" },
        groupKey: "runtime-open:ctx-1:workers/runtime-fixture",
      },
    });
    const second = queue.request({
      kind: "capability",
      callerId: "panel-1",
      callerKind: "panel",
      repoPath: "panels/example",
      effectiveVersion: "hash-1",
      capability: "context.boundary",
      title: "Open panel",
      operation: {
        kind: "panel",
        verb: "openPanel",
        object: { type: "panel", label: "Panel", value: "workers/runtime-fixture" },
        groupKey: "runtime-open:ctx-1:workers/runtime-fixture",
      },
    });

    expect(queue.listPending()).toHaveLength(1);
    queue.resolve(queue.listPending()[0]!.approvalId, "once");
    await expect(first).resolves.toBe("once");
    await expect(second).resolves.toBe("once");
  });

  it("does not let an operation group merge distinct consent facts", async () => {
    const { queue } = createQueue();
    const common = {
      callerId: "panel-1",
      callerKind: "panel" as const,
      repoPath: "panels/example",
      effectiveVersion: "hash-1",
    };
    const first = queue.request({
      ...common,
      kind: "capability",
      capability: "context.boundary",
      title: "Open panel",
      operation: {
        kind: "panel",
        verb: "openPanel",
        object: { type: "panel", label: "Panel", value: "workers/runtime-fixture" },
        groupKey: "runtime-open:ctx-1:workers/runtime-fixture",
      },
    });
    const second = queue.request({
      ...common,
      kind: "capability",
      capability: "context.boundary",
      title: "Spawn worker",
      operation: {
        kind: "worker-lifecycle",
        verb: "spawn",
        object: { type: "worker-source", label: "Worker", value: "workers/runtime-fixture" },
        groupKey: "runtime-open:ctx-1:workers/runtime-fixture",
      },
    });

    expect(queue.listPending()).toHaveLength(2);
    const [openApproval, spawnApproval] = queue.listPending();
    queue.resolve(openApproval!.approvalId, "once");
    await expect(first).resolves.toBe("once");
    expect(queue.listPending()).toEqual([spawnApproval]);
    queue.resolve(spawnApproval!.approvalId, "deny");
    await expect(second).resolves.toBe("deny");
  });

  it("preserves severe capability approval tone in pending state", async () => {
    const { queue } = createQueue();
    const promise = queue.request({
      kind: "capability",
      callerId: "panel-1",
      callerKind: "panel",
      repoPath: "panels/example",
      effectiveVersion: "hash-1",
      capability: "context.boundary",
      severity: "severe",
      title: "Act on Shell's context",
      resource: {
        type: "panel",
        label: "Panel",
        value: "Shell",
      },
    });

    expect(queue.listPending()[0]).toMatchObject({
      kind: "capability",
      capability: "context.boundary",
      severity: "severe",
      title: "Act on Shell's context",
    });
    queue.resolve(queue.listPending()[0]!.approvalId, "deny");
    await expect(promise).resolves.toBe("deny");
  });

  it("fans out pending changes to listeners and supports unsubscribe", async () => {
    const { queue } = createQueue();
    const listener = vi.fn();
    const unsubscribe = queue.onPendingChanged(listener);
    const promise = queue.request({
      kind: "capability",
      callerId: "panel-1",
      callerKind: "panel",
      repoPath: "panels/example",
      effectiveVersion: "hash-1",
      capability: "external-browser-open",
      title: "Open external browser",
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0]).toHaveLength(1);

    unsubscribe();
    queue.resolve(queue.listPending()[0]!.approvalId, "deny");

    await expect(promise).resolves.toBe("deny");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("treats double resolve as a no-op after the first settlement", async () => {
    const { queue, emit } = createQueue();
    const promise = queue.request({
      kind: "capability",
      callerId: "panel-1",
      callerKind: "panel",
      repoPath: "panels/example",
      effectiveVersion: "hash-1",
      capability: "external-browser-open",
      title: "Open external browser",
    });
    const approvalId = queue.listPending()[0]!.approvalId;

    queue.resolve(approvalId, "once");
    queue.resolve(approvalId, "deny");

    await expect(promise).resolves.toBe("once");
    expect(queue.listPending()).toEqual([]);
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it("keeps dismissal distinct from an explicit deny", async () => {
    const { queue } = createQueue();
    const decision = queue.request({
      kind: "capability",
      callerId: "panel-1",
      callerKind: "panel",
      repoPath: "panels/example",
      effectiveVersion: "hash-1",
      capability: "external-browser-open",
      title: "Open external browser",
    });
    await queue.resolve(queue.listPending()[0]!.approvalId, "dismiss");
    await expect(decision).resolves.toBe("dismiss");
  });

  it("can isolate one-shot capability approvals from concurrent waiters", async () => {
    const { queue } = createQueue();
    const first = queue.request({
      kind: "capability",
      dedupKey: null,
      callerId: "panel-1",
      callerKind: "panel",
      repoPath: "panels/example",
      effectiveVersion: "hash-1",
      capability: "workspace-main-advance",
      title: "Write project files",
      resource: {
        type: "git-repo",
        label: "Repository",
        value: "panels/target",
      },
    });
    const second = queue.request({
      kind: "capability",
      dedupKey: null,
      callerId: "panel-1",
      callerKind: "panel",
      repoPath: "panels/example",
      effectiveVersion: "hash-1",
      capability: "workspace-main-advance",
      title: "Write project files",
      resource: {
        type: "git-repo",
        label: "Repository",
        value: "panels/target",
      },
    });

    const pending = queue.listPending();
    expect(pending).toHaveLength(2);

    queue.resolve(pending[0]!.approvalId, "once");
    await expect(first).resolves.toBe("once");
    expect(queue.listPending()).toHaveLength(1);

    queue.resolve(queue.listPending()[0]!.approvalId, "deny");
    await expect(second).resolves.toBe("deny");
  });

  it("does not deduplicate capability approvals across concrete callers", async () => {
    const { queue } = createQueue();
    const first = queue.request({
      kind: "capability",
      callerId: "panel-1",
      callerKind: "panel",
      repoPath: "panels/example",
      effectiveVersion: "hash-1",
      capability: "external-browser-open",
      title: "Open external browser",
      resource: { type: "url-origin", label: "Origin", value: "https://example.com" },
    });
    const second = queue.request({
      kind: "capability",
      callerId: "panel-2",
      callerKind: "panel",
      repoPath: "panels/example",
      effectiveVersion: "hash-1",
      capability: "external-browser-open",
      title: "Open external browser",
      resource: { type: "url-origin", label: "Origin", value: "https://example.com" },
    });

    const pending = queue.listPending();
    expect(pending).toHaveLength(2);

    queue.resolve(pending[0]!.approvalId, "session");
    queue.resolve(pending[1]!.approvalId, "deny");
    await expect(first).resolves.toBe("session");
    await expect(second).resolves.toBe("deny");
  });

  it("uses a custom unit-review key only to narrow otherwise exact consent facts", async () => {
    const { queue } = createQueue();
    const first = queue.request(
      unitInstallReviewRequest({ dedupKey: "unit-source-change:extension:typecheck:main" })
    );
    const second = queue.request(
      unitInstallReviewRequest({
        dedupKey: "unit-source-change:extension:typecheck:main",
        effectiveVersion: "newer-commit",
      })
    );

    const pending = queue.listPending();
    expect(pending).toHaveLength(2);

    await queue.resolveInstallReview(pending[0]!.approvalId, {
      decision: "adopt-root",
      allowNow:
        pending[0]!.kind === "unit-install-review"
          ? pending[0]!.parts.map((part) => ({ identityKey: part.identityKey, permissions: [] }))
          : [],
    });
    await queue.resolveInstallReview(pending[1]!.approvalId, {
      decision: "adopt-root",
      allowNow:
        pending[1]!.kind === "unit-install-review"
          ? pending[1]!.parts.map((part) => ({ identityKey: part.identityKey, permissions: [] }))
          : [],
    });
    await expect(first).resolves.toBe("accepted");
    await expect(second).resolves.toBe("accepted");
  });

  it("keeps custom install-review dedup scoped to the concrete caller", async () => {
    const { queue } = createQueue();
    const first = queue.request(
      unitInstallReviewRequest({
        callerId: "panel-1",
        dedupKey: "unit-source-change:extension:typecheck:main",
      })
    );
    const second = queue.request(
      unitInstallReviewRequest({
        callerId: "panel-2",
        dedupKey: "unit-source-change:extension:typecheck:main",
      })
    );

    const pending = queue.listPending();
    expect(pending).toHaveLength(2);

    await queue.resolveInstallReview(pending[0]!.approvalId, {
      decision: "adopt-root",
      allowNow:
        pending[0]!.kind === "unit-install-review"
          ? pending[0]!.parts.map((part) => ({ identityKey: part.identityKey, permissions: [] }))
          : [],
    });
    await queue.resolveInstallReview(pending[1]!.approvalId, { decision: "cancel" });
    await expect(first).resolves.toBe("accepted");
    await expect(second).resolves.toBe("dismiss");
  });

  it("does not deduplicate credential approvals across concrete callers", async () => {
    const { queue } = createQueue();
    const request = {
      callerKind: "worker" as const,
      repoPath: "/repo",
      effectiveVersion: "hash-1",
      allowedDecisions: ["once", "session", "version", "deny"] as const,
      credentialId: "cred-1",
      credentialLabel: "GitHub",
      audience: [{ url: "https://api.github.com/", match: "origin" as const }],
      injection: {
        type: "header" as const,
        name: "authorization",
        valueTemplate: "Bearer {token}",
      },
      accountIdentity: { providerUserId: "user-1" },
      scopes: ["repo"],
    };
    const first = queue.request({ ...request, callerId: "worker:one" });
    const second = queue.request({ ...request, callerId: "worker:two" });

    const pending = queue.listPending();
    expect(pending).toHaveLength(2);

    queue.resolve(pending[0]!.approvalId, "session");
    queue.resolve(pending[1]!.approvalId, "deny");
    await expect(first).resolves.toBe("session");
    await expect(second).resolves.toBe("deny");
  });

  it("can resolve pending credential approvals that match a newly stored grant", async () => {
    const { queue } = createQueue();
    const request = {
      callerKind: "worker" as const,
      repoPath: "/repo",
      effectiveVersion: "hash-1",
      allowedDecisions: ["once", "session", "version", "deny"] as const,
      credentialId: "cred-1",
      credentialLabel: "GitHub",
      audience: [{ url: "https://api.github.com/", match: "origin" as const }],
      injection: {
        type: "header" as const,
        name: "authorization",
        valueTemplate: "Bearer {token}",
      },
      accountIdentity: { providerUserId: "user-1" },
      scopes: ["repo"],
      grantResource: {
        bindingId: "binding-1",
        resource: "https://api.github.com/",
        action: "use" as const,
      },
    };
    const first = queue.request({ ...request, callerId: "worker:one" });
    const second = queue.request({ ...request, callerId: "worker:two" });

    const pending = queue.listPending();
    queue.resolve(pending[0]!.approvalId, "version");
    await expect(first).resolves.toBe("version");

    const resolved = queue.resolveMatching(
      (approval) =>
        approval.kind === "credential" &&
        approval.credentialId === "cred-1" &&
        approval.repoPath === "/repo" &&
        approval.effectiveVersion === "hash-1" &&
        approval.grantResource?.bindingId === "binding-1" &&
        approval.grantResource.resource === "https://api.github.com/" &&
        approval.grantResource.action === "use",
      "once"
    );

    expect(resolved).toBe(1);
    await expect(second).resolves.toBe("once");
    expect(queue.listPending()).toEqual([]);
  });

  it("supports client config approvals with submitted field values", async () => {
    const { queue } = createQueue();
    const promise = queue.requestClientConfig({
      kind: "client-config",
      callerId: "panel-1",
      callerKind: "panel",
      repoPath: "panels/example",
      effectiveVersion: "hash-1",
      configId: "google-workspace",
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      title: "Configure Google Workspace OAuth",
      fields: [
        { name: "clientId", label: "Client ID", type: "text", required: true },
        { name: "clientSecret", label: "Client secret", type: "secret", required: true },
      ],
    });

    const pending = queue.listPending()[0]!;
    expect(pending).toMatchObject({
      kind: "client-config",
      configId: "google-workspace",
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      fields: [
        { name: "clientId", type: "text" },
        { name: "clientSecret", type: "secret" },
      ],
    });
    expect(JSON.stringify(pending)).not.toContain("secret-1");

    queue.submitClientConfig(pending.approvalId, {
      clientId: "client-1",
      clientSecret: "secret-1",
    });

    await expect(promise).resolves.toEqual({
      decision: "submit",
      values: {
        clientId: "client-1",
        clientSecret: "secret-1",
      },
    });
  });

  it("supports credential input approvals without exposing submitted secrets in pending state", async () => {
    const { queue } = createQueue();
    const promise = queue.requestCredentialInput({
      kind: "credential-input",
      callerId: "panel-1",
      callerKind: "panel",
      repoPath: "panels/example",
      effectiveVersion: "hash-1",
      title: "Add GitHub",
      credentialLabel: "GitHub",
      audience: [{ url: "https://api.github.com/", match: "origin" }],
      injection: {
        type: "header",
        name: "authorization",
        valueTemplate: "Bearer {token}",
      },
      accountIdentity: { providerUserId: "github-pat" },
      scopes: ["contents:read"],
      fields: [{ name: "token", label: "Fine-grained PAT", type: "secret", required: true }],
    });

    const pending = queue.listPending()[0]!;
    expect(pending).toMatchObject({
      kind: "credential-input",
      credentialLabel: "GitHub",
      fields: [{ name: "token", type: "secret" }],
    });
    expect(JSON.stringify(pending)).not.toContain("github_pat_1");

    queue.submitCredentialInput(pending.approvalId, {
      token: "github_pat_1",
    });

    await expect(promise).resolves.toEqual({
      decision: "submit",
      values: {
        token: "github_pat_1",
      },
    });
  });

  it("does not deduplicate credential input approvals", async () => {
    const { queue } = createQueue();
    const request = {
      kind: "credential-input" as const,
      callerId: "panel-1",
      callerKind: "panel" as const,
      repoPath: "panels/example",
      effectiveVersion: "hash-1",
      title: "Add GitHub",
      credentialLabel: "GitHub",
      audience: [{ url: "https://api.github.com/", match: "origin" as const }],
      injection: {
        type: "header" as const,
        name: "authorization",
        valueTemplate: "Bearer {token}",
      },
      accountIdentity: { providerUserId: "github-pat" },
      scopes: ["contents:read"],
      fields: [
        { name: "token", label: "Fine-grained PAT", type: "secret" as const, required: true },
      ],
    };
    const first = queue.requestCredentialInput(request);
    const second = queue.requestCredentialInput(request);

    const pending = queue.listPending();
    expect(pending).toHaveLength(2);

    queue.submitCredentialInput(pending[0]!.approvalId, { token: "github_pat_1" });
    await expect(first).resolves.toEqual({
      decision: "submit",
      values: { token: "github_pat_1" },
    });
    expect(queue.listPending()).toHaveLength(1);

    queue.resolve(queue.listPending()[0]!.approvalId, "deny");
    await expect(second).resolves.toEqual({ decision: "deny" });
  });

  describe("unit install reviews", () => {
    const startupInstallReviewRequest = (overrides: Record<string, unknown> = {}) => ({
      kind: "unit-install-review" as const,
      callerId: "system:extensions",
      callerKind: "system" as const,
      repoPath: "meta",
      effectiveVersion: "",
      mode: "adopt-root" as const,
      title: "Start this workspace?",
      description: "2 extensions need approval.",
      units: [
        {
          unitKind: "extension" as const,
          unitName: "@workspace-extensions/image-service",
          displayName: "Image Service",
          source: {
            kind: "workspace-repo" as const,
            repo: "extensions/image-service",
            ref: "main",
          },
          capabilities: ["node:fs"],
        },
        {
          unitKind: "extension" as const,
          unitName: "@workspace-extensions/file-tools",
          displayName: "File Tools",
          source: {
            kind: "workspace-repo" as const,
            repo: "extensions/file-tools",
            ref: "main",
          },
          capabilities: ["node:fs"],
        },
      ],
      ...overrides,
    });

    it("creates a pending install review carrying the unit list", async () => {
      const { queue } = createQueue();
      void queue.request(startupInstallReviewRequest());
      await Promise.resolve();
      const pending = queue.listPending();
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        kind: "unit-install-review",
        mode: "adopt-root",
        callerKind: "system",
        parts: [
          expect.objectContaining({
            kind: "extension",
            name: "@workspace-extensions/image-service",
          }),
          expect.objectContaining({ kind: "extension", name: "@workspace-extensions/file-tools" }),
        ],
      });
    });

    it("refuses to settle a unit review through the generic resolver", async () => {
      const { queue } = createQueue();
      const waiting = queue.request(startupInstallReviewRequest());
      await Promise.resolve();
      const approval = queue.listPending()[0]!;
      await expect(queue.resolve(approval.approvalId, "once")).rejects.toThrow(
        "resolveInstallReview"
      );
      expect(queue.listPending()).toHaveLength(1);
      await queue.resolveInstallReview(approval.approvalId, { decision: "cancel" });
      await expect(waiting).resolves.toBe("dismiss");
    });

    it("coalesces duplicate reconciles for the same trigger + set onto one prompt", async () => {
      const { queue } = createQueue();
      void queue.request(startupInstallReviewRequest());
      void queue.request(startupInstallReviewRequest());
      await Promise.resolve();
      expect(queue.listPending()).toHaveLength(1);
    });

    it("puts a repair in its own section, with its new authority unchecked", async () => {
      // §5.3: a template publication may carry agent-authored fixes to parts
      // the template does not own. The user asked for the template, not for
      // these, so they are shown separately and nothing about them is
      // pre-authorized.
      const { queue } = createQueue();
      const withAuthority = (repo: string, name: string) => ({
        unitKind: "worker" as const,
        unitName: name,
        displayName: name,
        source: { kind: "workspace-repo" as const, repo, ref: "main" },
        ev: `ev-${repo}`,
        capabilities: [],
        authority: {
          requests: [
            {
              capability: "workspace.files.write",
              resource: { kind: "prefix" as const, prefix: "" },
              tier: "gated" as const,
            },
          ],
          provides: [],
        },
      });
      void queue.request(
        startupInstallReviewRequest({
          mode: "install",
          units: [
            withAuthority("workers/news-agent", "@workspace/news-agent"),
            withAuthority("workers/chat", "@workspace/chat"),
          ],
          sections: new Map([
            ["workers/news-agent", "template"],
            ["workers/chat", "repair"],
          ]),
        })
      );
      await Promise.resolve();
      const parts = (
        queue.listPending()[0] as unknown as {
          parts: Array<{
            repoPath: string;
            section: string;
            notableRows: Array<{ selectable: boolean; selectedByDefault: boolean }>;
            everydayRows: Array<{ selectable: boolean; selectedByDefault: boolean }>;
          }>;
        }
      ).parts;
      const byRepo = new Map(parts.map((part) => [part.repoPath, part]));
      expect(byRepo.get("workers/news-agent")!.section).toBe("template");
      expect(byRepo.get("workers/chat")!.section).toBe("repair");
      const rowsOf = (repo: string) => [
        ...byRepo.get(repo)!.notableRows,
        ...byRepo.get(repo)!.everydayRows,
      ];
      expect(rowsOf("workers/chat").filter((row) => row.selectedByDefault)).toHaveLength(0);
      expect(
        rowsOf("workers/news-agent").filter((row) => row.selectable && row.selectedByDefault).length
      ).toBeGreaterThan(0);
    });

    it("resolves all waiters when the batch is approved", async () => {
      const { queue } = createQueue();
      const first = queue.request(startupInstallReviewRequest());
      const second = queue.request(startupInstallReviewRequest());
      await Promise.resolve();
      const pending = queue.listPending()[0]!;
      await queue.resolveInstallReview(pending.approvalId, {
        decision: "adopt-root",
        allowNow:
          pending.kind === "unit-install-review"
            ? pending.parts.map((part) => ({ identityKey: part.identityKey, permissions: [] }))
            : [],
      });
      await expect(first).resolves.toBe("accepted");
      await expect(second).resolves.toBe("accepted");
    });
  });

  describe("device-code approvals", () => {
    function makeDeviceCodeReq() {
      return {
        kind: "device-code" as const,
        callerId: "panel-test",
        callerKind: "panel" as const,
        repoPath: "panel-test",
        effectiveVersion: "v1",
        credentialLabel: "GitHub CLI",
        userCode: "ABCD-EFGH",
        verificationUri: "https://github.com/login/device",
        verificationUriComplete: undefined,
        expiresAt: Date.now() + 60_000,
        oauthTokenOrigin: "https://github.com",
      };
    }

    it("surfaces the user_code in the pending approvals list", () => {
      const { queue } = createQueue();
      const handle = queue.presentDeviceCode(makeDeviceCodeReq());
      const pending = queue.listPending();
      expect(pending).toHaveLength(1);
      const entry = pending[0]!;
      expect(entry.kind).toBe("device-code");
      if (entry.kind === "device-code") {
        expect(entry.userCode).toBe("ABCD-EFGH");
        expect(entry.verificationUri).toBe("https://github.com/login/device");
        expect(entry.credentialLabel).toBe("GitHub CLI");
      }
      expect(handle.cancelled.aborted).toBe(false);
      handle.dispose();
      expect(queue.listPending()).toEqual([]);
    });

    it("fires the cancellation signal when the user dismisses the entry", () => {
      const { queue } = createQueue();
      const handle = queue.presentDeviceCode(makeDeviceCodeReq());
      const fired = vi.fn();
      handle.cancelled.addEventListener("abort", fired);
      queue.resolve(handle.approvalId, "dismiss");
      expect(fired).toHaveBeenCalled();
      expect(handle.cancelled.aborted).toBe(true);
      expect(queue.listPending()).toEqual([]);
    });

    it("dispose() removes the entry without firing cancellation", () => {
      const { queue } = createQueue();
      const handle = queue.presentDeviceCode(makeDeviceCodeReq());
      const fired = vi.fn();
      handle.cancelled.addEventListener("abort", fired);
      handle.dispose();
      expect(fired).not.toHaveBeenCalled();
      expect(handle.cancelled.aborted).toBe(false);
      expect(queue.listPending()).toEqual([]);
    });

    it("dispose() is idempotent", () => {
      const { queue } = createQueue();
      const handle = queue.presentDeviceCode(makeDeviceCodeReq());
      handle.dispose();
      handle.dispose();
      expect(queue.listPending()).toEqual([]);
    });

    it("each presented device-code is independent (no dedup)", () => {
      const { queue } = createQueue();
      const h1 = queue.presentDeviceCode(makeDeviceCodeReq());
      const h2 = queue.presentDeviceCode(makeDeviceCodeReq());
      expect(queue.listPending()).toHaveLength(2);
      expect(h1.approvalId).not.toBe(h2.approvalId);
    });
  });

  describe("WP5 provenance & settlement coordinator", () => {
    function capabilityRequest(requestedByUserId?: string) {
      return {
        kind: "capability" as const,
        callerId: "panel-1",
        callerKind: "panel" as const,
        repoPath: "panels/example",
        effectiveVersion: "hash-1",
        capability: "external-browser-open",
        title: "Open external browser",
        resource: { type: "url" as const, label: "URL", value: "https://example.com" },
        ...(requestedByUserId ? { requestedByUserId } : {}),
      };
    }

    it("resolving with a resolver snapshots resolvedBy, emits resolved before removal, and records provenance", async () => {
      const recordProvenance = vi.fn();
      const { queue, emit } = createQueue({ recordProvenance });
      const promise = queue.request(capabilityRequest("usr_req"));
      const approvalId = queue.listPending()[0]!.approvalId;

      await queue.resolve(approvalId, "version", {
        subject: { userId: "usr_2", handle: "alice" },
        via: "shell",
        deviceId: "dev-1",
      });
      await expect(promise).resolves.toBe("version");

      // §6: the live `resolved` event carries `resolvedBy` — proving the snapshot
      // was taken while the entry still existed (the delete-before-emit fix).
      const resolvedEmit = emit.mock.calls.find(([name]) => name === "shell-approval:resolved");
      expect(resolvedEmit).toBeDefined();
      expect(resolvedEmit![1]).toMatchObject({
        approvalId,
        decision: "version",
        granted: true,
        resolvedBy: { userId: "usr_2", handle: "alice", deviceId: "dev-1" },
        resolvedVia: "shell",
      });
      // Neither child-owned surface carries the hub-owned workspace identity.
      expect(resolvedEmit![1]).not.toHaveProperty("workspaceId");

      // §5: one durable record, naming both parties + the resource + grant scope.
      expect(recordProvenance).toHaveBeenCalledTimes(1);
      expect(recordProvenance.mock.calls[0]![0]).toMatchObject({
        approvalKind: "capability",
        decision: "version",
        granted: true,
        resolvedBy: { userId: "usr_2", handle: "alice", deviceId: "dev-1" },
        resolvedVia: "shell",
        requestedBy: { callerId: "panel-1", callerKind: "panel", userId: "usr_req" },
        resource: { capability: "external-browser-open", value: "https://example.com" },
        grantScopeStored: "version",
      });
      expect(recordProvenance.mock.calls[0]![0]).not.toHaveProperty("workspaceId");
      // The entry is gone by the time the queue settles (no re-prompt lingering).
      expect(queue.listPending()).toEqual([]);
    });

    it("a deny records granted:false with a null grant scope", async () => {
      const recordProvenance = vi.fn();
      const { queue } = createQueue({ recordProvenance });
      const promise = queue.request(capabilityRequest());
      const approvalId = queue.listPending()[0]!.approvalId;

      await queue.resolve(approvalId, "deny", {
        subject: { userId: "usr_2", handle: "alice" },
        via: "app",
      });
      await expect(promise).resolves.toBe("deny");
      expect(recordProvenance.mock.calls[0]![0]).toMatchObject({
        decision: "deny",
        granted: false,
        grantScopeStored: null,
      });
    });

    it("a programmatic settle with no resolver records no provenance and emits no resolved event", async () => {
      const recordProvenance = vi.fn();
      const { queue, emit } = createQueue({ recordProvenance });
      const promise = queue.request(capabilityRequest());
      const approvalId = queue.listPending()[0]!.approvalId;

      await queue.resolve(approvalId, "once");
      await expect(promise).resolves.toBe("once");
      expect(recordProvenance).not.toHaveBeenCalled();
      expect(emit.mock.calls.some(([name]) => name === "shell-approval:resolved")).toBe(false);
    });

    it("keeps the approval pending and emits no success when durable provenance fails", async () => {
      const recordProvenance = vi.fn(async () => {
        throw new Error("hub unavailable");
      });
      const { queue, emit } = createQueue({ recordProvenance });
      const decision = queue.request(capabilityRequest("usr_req"));
      const approvalId = queue.listPending()[0]!.approvalId;

      await expect(
        queue.resolve(approvalId, "once", {
          subject: { userId: "usr_2", handle: "alice" },
          via: "shell",
        })
      ).rejects.toThrow("hub unavailable");

      expect(queue.listPending().map((approval) => approval.approvalId)).toEqual([approvalId]);
      expect(emit.mock.calls.some(([name]) => name === "shell-approval:resolved")).toBe(false);

      await queue.resolve(approvalId, "deny");
      await expect(decision).resolves.toBe("deny");
    });

    it("rejects a competing human verdict while one durable settlement is in flight", async () => {
      let acknowledge!: () => void;
      const recordProvenance = vi.fn(
        async () =>
          await new Promise<void>((resolve) => {
            acknowledge = resolve;
          })
      );
      const { queue, emit } = createQueue({ recordProvenance });
      const decision = queue.request(capabilityRequest("usr_req"));
      const approvalId = queue.listPending()[0]!.approvalId;
      const resolver = {
        subject: { userId: "usr_2", handle: "alice" },
        via: "shell" as const,
      };

      const first = queue.resolve(approvalId, "once", resolver);
      const second = queue.resolve(approvalId, "deny", resolver);
      const competingVerdict = expect(second).rejects.toThrow(
        `Approval ${approvalId} is already being resolved`
      );
      expect(recordProvenance).toHaveBeenCalledTimes(1);
      expect(queue.listPending()).toHaveLength(1);

      acknowledge();
      await Promise.all([first, competingVerdict]);
      await expect(decision).resolves.toBe("once");
      expect(recordProvenance).toHaveBeenCalledTimes(1);
      expect(emit.mock.calls.filter(([name]) => name === "shell-approval:resolved")).toHaveLength(
        1
      );
    });

    it("lets an in-flight human settlement win over abort and caller cleanup", async () => {
      let acknowledge!: () => void;
      const recordProvenance = vi.fn(
        async () =>
          await new Promise<void>((resolve) => {
            acknowledge = resolve;
          })
      );
      const { queue, emit } = createQueue({ recordProvenance });
      const abort = new AbortController();
      const decision = queue.request({
        ...capabilityRequest("usr_req"),
        signal: abort.signal,
      });
      const approvalId = queue.listPending()[0]!.approvalId;

      const settlement = queue.resolve(approvalId, "once", {
        subject: { userId: "usr_2", handle: "alice" },
        via: "shell",
      });
      await vi.waitFor(() => expect(recordProvenance).toHaveBeenCalledTimes(1));

      abort.abort();
      queue.cancelForCaller("panel-1");
      expect(queue.listPending().map((approval) => approval.approvalId)).toEqual([approvalId]);

      acknowledge();
      await settlement;
      await expect(decision).resolves.toBe("once");
      expect(recordProvenance).toHaveBeenCalledTimes(1);
      expect(emit.mock.calls.filter(([name]) => name === "shell-approval:resolved")).toHaveLength(
        1
      );
      expect(queue.listPending()).toEqual([]);
    });
  });
});

/**
 * The install review's two ends: where a part came from before whatever owns it
 * now (§U2, §7.7), and what answering the review actually did (§7.2).
 */
describe("install review provenance and result", () => {
  const panelUnit = (repo: string, name: string) => ({
    unitKind: "panel" as const,
    unitName: name,
    displayName: name,
    source: { kind: "workspace-repo" as const, repo, ref: "main" },
    ev: `ev-${repo}`,
    capabilities: [],
    authority: {
      requests: [
        {
          capability: "workspace.files.read",
          resource: { kind: "prefix" as const, prefix: "" },
          tier: "gated" as const,
          evidence: "exact" as const,
        },
      ],
      provides: [],
      // The review derives its own rows from `requests`; these carry the
      // producer's precomputed view, which this fixture does not exercise.
      previousProvides: [],
      rows: [],
      diff: { added: [], removed: [], unchanged: [], retiered: [] },
    },
  });

  const installRequest = (
    overrides: Partial<UnitInstallReviewQueueRequest> = {}
  ): UnitInstallReviewQueueRequest => ({
    kind: "unit-install-review",
    callerId: "system:templates",
    callerKind: "system",
    repoPath: "meta",
    effectiveVersion: "",
    mode: "install",
    title: "Add News",
    description: "Read and discuss personalized news briefings.",
    units: [panelUnit("panels/news", "News")],
    template: {
      title: "News",
      purpose: "Read and discuss personalized news briefings.",
      origin: {
        url: "https://github.com/panticonic/news",
        originKey: "github.com/panticonic",
        registrableDomain: "github.com",
        version: "v1.2.0",
        isHostBuild: false,
        firstEncounter: true,
      },
      fromVersion: null,
      toVersion: "1.2.0",
    },
    configWrite: null,
    ...overrides,
  });

  const pendingReview = async (queue: ReturnType<typeof createQueue>["queue"]) => {
    await Promise.resolve();
    const pending = queue.listPending()[0];
    if (!pending || pending.kind !== "unit-install-review") throw new Error("no review pending");
    return pending;
  };

  it("keeps a removed template's parts attributed to it on every review surface", async () => {
    const { queue } = createQueue({
      // Derived server-side from the lock and the admission ledger; a request
      // site never has to remember to carry it.
      originallyInstalledFrom: (repoPath) => (repoPath === "panels/news" ? "News 1.2.0" : null),
    });
    void queue.request(
      installRequest({ units: [panelUnit("panels/news", "News"), panelUnit("panels/own", "Own")] })
    );
    const pending = await pendingReview(queue);

    expect(pending.parts.map((part) => part.originallyInstalledFrom)).toEqual([
      "News 1.2.0",
      undefined,
    ]);
    // Never a commit id or a content digest, at any disclosure level.
    expect(JSON.stringify(pending.parts)).not.toMatch(/[0-9a-f]{40}/u);
  });

  it("does not turn missing provenance into a host-build attribution", async () => {
    const { queue } = createQueue();
    void queue.request(installRequest({ origins: undefined }));
    const pending = await pendingReview(queue);

    expect(pending.parts[0]!.origin).toMatchObject({
      url: null,
      originKey: "source unavailable",
      isHostBuild: false,
      originStatus: "unresolved",
    });
  });

  it("lets a request site that already resolved the history state it", async () => {
    const { queue } = createQueue({ originallyInstalledFrom: () => "Wrong 0.1" });
    void queue.request(
      installRequest({ originallyInstalledFrom: new Map([["panels/news", "News 1.2.0"]]) })
    );

    expect((await pendingReview(queue)).parts[0]?.originallyInstalledFrom).toBe("News 1.2.0");
  });

  it("reports an accepted decision in the present tense when nobody watched it land", async () => {
    const { queue } = createQueue();
    void queue.request(installRequest());
    const pending = await pendingReview(queue);

    const result = await queue.resolveInstallReview(pending.approvalId, {
      decision: "install",
      allowNow: [{ identityKey: pending.parts[0]!.identityKey }],
    });

    // No landing site reported, so the outcome is under way — not good.
    expect(result).toMatchObject({
      decision: "accepted",
      subject: "News",
      heading: "Adding News…",
      parts: [{ title: "news", clearance: "allowed-now" }],
      entryPoint: { repoPath: "panels/news", title: "News", kind: "panel" },
    });
    expect(result.landing).toBeUndefined();
  });

  it("says a part will ask rather than pretending it was allowed", async () => {
    const { queue } = createQueue();
    void queue.request(installRequest());
    const pending = await pendingReview(queue);

    const result = await queue.resolveInstallReview(pending.approvalId, {
      decision: "install",
      allowNow: [{ identityKey: pending.parts[0]!.identityKey, permissions: [] }],
    });

    // U5: unchecked is "ask when needed", a real decision and not a failure.
    expect(result.parts).toEqual([
      expect.objectContaining({ clearance: "asks-when-needed", title: "news" }),
    ]);
  });

  it("rejects duplicate part identities in one install decision", async () => {
    const { queue } = createQueue();
    void queue.request(installRequest());
    const pending = await pendingReview(queue);
    const identityKey = pending.parts[0]!.identityKey;

    await expect(
      queue.resolveInstallReview(pending.approvalId, {
        decision: "install",
        allowNow: [{ identityKey }, { identityKey }],
      })
    ).rejects.toThrow("repeats a part");
  });

  it("names the parts that failed, and never claims a clean slate it was not promised", async () => {
    const { queue } = createQueue();
    void queue.request(
      installRequest({
        reportsLanding: true,
        units: [panelUnit("panels/news", "News"), panelUnit("panels/reader", "Reader")],
      })
    );
    const pending = await pendingReview(queue);
    const [news, reader] = pending.parts;

    const resolved = queue.resolveInstallReview(pending.approvalId, {
      decision: "install",
      allowNow: pending.parts.map((part) => ({ identityKey: part.identityKey })),
    });
    queue.reportInstallLanding?.(pending.approvalId, {
      landed: [reader!.identityKey],
      failed: [{ identityKey: news!.identityKey, reason: "build failed" }],
    });
    const result = await resolved;

    expect(result.heading).toBe("News was only partly added");
    expect(result.landing).toEqual({
      landed: [reader!.identityKey],
      failed: [{ identityKey: news!.identityKey, title: "news", reason: "build failed" }],
      workspaceUnchanged: false,
    });
    // The reporter did not guarantee a clean unwind, so the copy does not claim
    // one — it says only what is certain.
    expect(result.detail).toBe("These parts did not arrive: news. The other part arrived.");
    expect(result.detail).not.toContain("Nothing was left behind");
    // And nothing offers to open a part that is not there.
    expect(result.entryPoint?.title).toBe("Reader");
  });

  it("says nothing was left behind only when the landing guaranteed it", async () => {
    const { queue } = createQueue();
    void queue.request(installRequest({ reportsLanding: true }));
    const pending = await pendingReview(queue);

    const resolved = queue.resolveInstallReview(pending.approvalId, {
      decision: "install",
      allowNow: [{ identityKey: pending.parts[0]!.identityKey }],
    });
    queue.reportInstallLanding?.(pending.approvalId, {
      landed: [],
      failed: [{ identityKey: pending.parts[0]!.identityKey, reason: "publication rejected" }],
      workspaceUnchanged: true,
    });
    const result = await resolved;

    expect(result.heading).toBe("News could not be added");
    expect(result.detail).toBe("These parts did not arrive: news. Nothing was left behind.");
    expect(result.entryPoint).toBeUndefined();
  });

  it("reports a landing that fully arrived in the past tense, with somewhere to go", async () => {
    const { queue } = createQueue();
    void queue.request(installRequest({ reportsLanding: true }));
    const pending = await pendingReview(queue);

    const resolved = queue.resolveInstallReview(pending.approvalId, {
      decision: "install",
      allowNow: [{ identityKey: pending.parts[0]!.identityKey }],
    });
    queue.reportInstallLanding?.(pending.approvalId, { landed: [pending.parts[0]!.identityKey] });
    const result = await resolved;

    expect(result.heading).toBe("News added");
    expect(result.detail).toBeUndefined();
    expect(result.entryPoint).toMatchObject({ title: "News", kind: "panel" });
  });

  it("reports post-settlement landing through the operation's exact token", async () => {
    const { queue } = createQueue();
    const handle = queue.requestWithHandle!(
      installRequest({ reportsLanding: true, landingToken: "publication:news" })
    );
    const pending = await pendingReview(queue);
    expect(handle.approvalId).toBe(pending.approvalId);

    const resolved = queue.resolveInstallReview(pending.approvalId, {
      decision: "install",
      allowNow: [{ identityKey: pending.parts[0]!.identityKey }],
    });
    queue.reportInstallLandingByToken?.("publication:news", {
      landed: [pending.parts[0]!.identityKey],
    });

    await expect(resolved).resolves.toMatchObject({
      decision: "accepted",
      heading: "News added",
      landing: { landed: [pending.parts[0]!.identityKey], failed: [] },
    });
    await expect(handle.decision).resolves.toBe("accepted");
  });

  it("reports a cancel as the one outcome that is provably clean", async () => {
    const { queue } = createQueue();
    void queue.request(installRequest({ reportsLanding: true }));
    const pending = await pendingReview(queue);

    // Cancel never reaches the operation, so it never waits for a landing.
    const result = await queue.resolveInstallReview(pending.approvalId, { decision: "cancel" });

    expect(result).toMatchObject({
      decision: "cancelled",
      heading: "News was not added",
      detail: "Your workspace is unchanged.",
      parts: [],
    });
    expect(queue.listPending()).toEqual([]);
  });

  it("decides nothing twice for a review that is already settled", async () => {
    const { queue } = createQueue();
    void queue.request(installRequest());
    const pending = await pendingReview(queue);
    await queue.resolveInstallReview(pending.approvalId, { decision: "cancel" });

    const second = await queue.resolveInstallReview(pending.approvalId, { decision: "cancel" });
    expect(second).toMatchObject({ heading: "This review is no longer open", parts: [] });
  });

  it("keeps the landing rendezvous alive when a stale client answers twice", async () => {
    const { queue } = createQueue();
    void queue.request(installRequest({ reportsLanding: true }));
    const pending = await pendingReview(queue);

    const first = queue.resolveInstallReview(pending.approvalId, {
      decision: "install",
      allowNow: [{ identityKey: pending.parts[0]!.identityKey }],
    });
    // Let the first resolver settle the decision and begin waiting for landing.
    await Promise.resolve();
    await Promise.resolve();

    await expect(
      queue.resolveInstallReview(pending.approvalId, { decision: "cancel" })
    ).resolves.toMatchObject({ decision: "cancelled" });
    queue.reportInstallLanding?.(pending.approvalId, {
      landed: [pending.parts[0]!.identityKey],
    });

    await expect(first).resolves.toMatchObject({ decision: "accepted" });
  });
});
