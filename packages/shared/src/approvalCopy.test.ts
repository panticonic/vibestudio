import type { PendingApproval } from "./approvals.js";
import type { InstallReviewPart } from "./authority/unitInstallReview.js";
import {
  formatAccount,
  formatGitRemoteSummary,
  formatInjection,
  formatNetworkDestination,
  formatServiceName,
  getApprovalAttribution,
  getApprovalCallerPresentation,
  getApprovalCategoryLabel,
  getApprovalCopy,
  getApprovalRiskTone,
  getRecommendedStandardDecision,
  getRequesterCategoryLabel,
  getStandardActionCopy,
  getStandardApprovalDecisionActions,
  getInstallReviewActionCopy,
  originForUrl,
  shouldOpenApprovalDetails,
} from "./approvalCopy.js";

const base = {
  approvalId: "approval-1",
  callerId: "worker-abcdef123456",
  callerKind: "worker",
  repoPath: "/projects/foo",
  effectiveVersion: "v1",
  requestedAt: 1,
} as const;

/** One part, as the server derives it for every review surface. */
function reviewPart(overrides: Record<string, unknown> = {}) {
  return {
    identityKey: "unit:1",
    kind: "panel",
    label: "Panel",
    surfaces: [],
    name: "panels/news",
    title: "News",
    purpose: "Reads your feeds and shows briefings.",
    repoPath: "panels/news",
    effectiveVersion: "ev-1",
    version: "1.2.0",
    requiredUnitKeys: [],
    runsInBackground: false,
    origin: {
      url: "https://github.com/panticonic/news",
      originKey: "github.com/panticonic",
      registrableDomain: "github.com",
      version: "v1.2.0",
      isHostBuild: false,
      firstEncounter: true,
    },
    notableRows: [],
    everydayRows: [],
    change: "added",
    section: "template",
    ...overrides,
  } as unknown as InstallReviewPart;
}

function installReview(overrides: Record<string, unknown>) {
  return {
    kind: "unit-install-review",
    mode: "install",
    title: "Add News",
    description: "Read and discuss personalized news briefings.",
    template: null,
    parts: [],
    summary: { panels: 0, agents: 0, services: 0, clientApps: 0, extensions: 0 },
    unchangedPartCount: 0,
    configWrite: null,
    ...overrides,
  } as unknown as Omit<
    Extract<PendingApproval, { kind: "unit-install-review" }>,
    keyof typeof base
  >;
}

describe("approvalCopy", () => {
  const fixtures: Array<{
    name: string;
    approval: PendingApproval;
    category: string;
    title: string;
    summaryIncludes: string;
    warning?: string;
    detailsOpen?: boolean;
    risk?: "standard" | "caution" | "danger";
  }> = [
    {
      name: "capability",
      approval: {
        ...base,
        kind: "capability",
        capability: "open-url",
        title: "Open URL",
        resource: {
          type: "url",
          label: "URL",
          value: "https://github.com/foo/bar",
        },
        details: [{ label: "URL", value: "https://github.com/foo/bar" }],
      },
      category: "Open in browser",
      title: "Open github.com/foo/...",
      summaryIncludes: "github.com/foo/...",
    },
    {
      name: "credential OAuth",
      approval: {
        ...base,
        kind: "credential",
        allowedDecisions: ["once", "session", "version", "deny"],
        credentialId: "cred-google",
        credentialLabel: "Google Calendar",
        audience: [{ match: "origin", url: "https://calendar.google.com/" }],
        injection: { type: "header", name: "Authorization", valueTemplate: "Bearer {{token}}" },
        accountIdentity: { email: "me@example.com", providerUserId: "user-1" },
        scopes: ["calendar.readonly"],
        oauthAuthorizeOrigin: "https://accounts.google.com",
        oauthTokenOrigin: "https://oauth2.googleapis.com",
      },
      category: "Connect an account",
      title: "Connect Google Calendar",
      summaryIncludes: "Connects Google Calendar",
    },
    {
      name: "credential git-write",
      approval: {
        ...base,
        kind: "credential",
        allowedDecisions: ["once", "session", "version", "deny"],
        credentialId: "cred-git",
        credentialLabel: "GitHub PAT",
        audience: [{ match: "origin", url: "https://github.com/" }],
        injection: {
          type: "basic-auth",
          usernameTemplate: "x-access-token",
          passwordTemplate: "{{token}}",
        },
        accountIdentity: { username: "octo", providerUserId: "octo" },
        scopes: ["repo"],
        credentialUse: "git-http",
        gitOperation: {
          action: "write",
          label: "push commits",
          remote: "https://github.com/acme/project.git",
          service: "github",
        },
      },
      category: "Push changes",
      title: "Push to github.com/acme/project",
      summaryIncludes: "github.com/acme/project",
    },
    {
      name: "credential unrelated force-push",
      approval: {
        ...base,
        kind: "credential",
        allowedDecisions: ["once", "deny"],
        credentialId: "cred-git",
        credentialLabel: "GitHub PAT",
        audience: [{ match: "origin", url: "https://github.com/" }],
        injection: {
          type: "basic-auth",
          usernameTemplate: "x-access-token",
          passwordTemplate: "{{token}}",
        },
        accountIdentity: { username: "octo", providerUserId: "octo" },
        scopes: ["repo"],
        credentialUse: "git-http",
        gitOperation: {
          action: "write",
          label: "force-push commits",
          remote: "https://github.com/acme/project.git",
          service: "github",
          force: true,
          overwrites: {
            relationship: "unrelated",
            count: null,
            commits: [{ sha: "abc", summary: "Remote root" }],
            truncated: false,
          },
        },
      },
      category: "Push changes",
      title: "Replace unrelated history on github.com/acme/project",
      summaryIncludes: "no common ancestor",
      warning:
        "The remote commits cannot be counted relative to the local history and may become unreachable.",
    },
    {
      name: "network egress",
      approval: {
        ...base,
        kind: "capability",
        capability: "network.response.read",
        title: "Allow network access",
        resource: {
          type: "url-origin",
          label: "Target origin",
          value: "http://localhost:42531",
        },
        operation: {
          kind: "network",
          verb: "Connect",
          object: {
            type: "url-origin",
            label: "Target origin",
            value: "http://localhost:42531",
          },
        },
      },
      category: "Internet access",
      title: "Connect to localhost:42531",
      summaryIncludes: "Sends and receives data",
    },
    {
      name: "credential repo binding",
      approval: {
        ...base,
        kind: "credential",
        allowedDecisions: ["once", "session", "version", "deny"],
        credentialId: "cred-github",
        credentialLabel: "GitHub",
        audience: [{ match: "path-prefix", url: "https://api.github.com/repos/" }],
        injection: { type: "header", name: "authorization", valueTemplate: "Bearer {token}" },
        accountIdentity: { username: "octo", providerUserId: "octo" },
        scopes: ["repo"],
        credentialUse: "fetch",
        bindingLabel: "GitHub repositories",
        grantResource: {
          bindingId: "github-repos",
          resource: "https://api.github.com/repos/acme/project/",
          action: "use",
        },
      },
      category: "Use an account",
      title: "Use GitHub repositories",
      summaryIncludes: "GitHub repositories at github.com/acme/project",
    },
    {
      name: "workspace source change",
      approval: {
        ...base,
        kind: "capability",
        capability: "workspace-main-advance",
        grantResourceKey: "workspace-source-change:panels/spectrolite:main",
        title: "Update workspace source",
        resource: {
          type: "workspace-source",
          label: "Workspace source",
          value: "panels/spectrolite",
        },
      },
      category: "Workspace update",
      title: "Update panels/spectrolite",
      summaryIncludes: "Saves changes",
    },
    {
      name: "client-config",
      approval: {
        ...base,
        kind: "client-config",
        configId: "google-calendar",
        authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        title: "Google Calendar",
        fields: [
          { name: "clientId", label: "Client ID", type: "text", required: true },
          { name: "clientSecret", label: "Client Secret", type: "secret", required: true },
        ],
      },
      category: "Set up a connection",
      title: "Set up Google Calendar",
      summaryIncludes: "Saves your connection settings",
    },
    {
      name: "credential-input",
      approval: {
        ...base,
        kind: "credential-input",
        title: "Add API key",
        credentialLabel: "Acme API",
        audience: [{ match: "path-prefix", url: "https://api.acme.test/v1/projects" }],
        injection: { type: "query-param", name: "api_key" },
        accountIdentity: { providerUserId: "acme-user" },
        scopes: ["projects.read"],
        fields: [{ name: "apiKey", label: "API Key", type: "secret", required: true }],
      },
      category: "Set up a connection",
      title: "Add Acme API",
      summaryIncludes: "api.acme.test/v1/...",
    },
    {
      name: "OAuth domain-mismatch",
      approval: {
        ...base,
        kind: "credential",
        allowedDecisions: ["once", "session", "version", "deny"],
        credentialId: "cred-mismatch",
        credentialLabel: "Google Calendar",
        audience: [{ match: "origin", url: "https://calendar.google.com/" }],
        injection: { type: "header", name: "Authorization", valueTemplate: "Bearer {{token}}" },
        accountIdentity: { email: "me@example.com", providerUserId: "user-1" },
        scopes: ["calendar.readonly"],
        oauthAuthorizeOrigin: "https://accounts.google.com",
        oauthTokenOrigin: "https://oauth2.googleapis.com",
        oauthAudienceDomainMismatch: true,
      },
      category: "Connect an account",
      title: "Connect Google Calendar",
      summaryIncludes: "calendar.google.com",
      warning:
        "The sign-in site is different from the service's site. Make sure you recognize both.",
      risk: "caution",
    },
    {
      name: "a part edited in the workspace",
      approval: {
        ...base,
        ...installReview({
          mode: "part-changed",
          title: "News changed",
          description: "Someone edited this part in your workspace.",
          parts: [reviewPart()],
          summary: { panels: 1, agents: 0, services: 0, clientApps: 0, extensions: 0 },
        }),
      },
      category: "A part changed",
      title: "News changed",
      summaryIncludes: "edited this part",
      detailsOpen: true,
      // Someone editing a panel in their own workspace is not an alarm; the
      // tone rule reserves amber for native code (§1, §7.4).
      risk: "standard",
    },
    {
      name: "a template that ships native code",
      approval: {
        ...base,
        ...installReview({
          parts: [
            reviewPart({
              identityKey: "unit:ext",
              kind: "extension",
              label: "Extension",
              title: "Feed Reader",
              name: "extensions/feed-reader",
              repoPath: "extensions/feed-reader",
            }),
          ],
          summary: { panels: 0, agents: 0, services: 0, clientApps: 0, extensions: 1 },
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
        }),
      },
      category: "Add a template",
      title: "Add News",
      summaryIncludes: "news briefings",
      warning: "Extensions run outside Vibestudio's protections, with access to this computer.",
      detailsOpen: true,
      // Native code is the one thing here worth a raised voice, and a raised
      // voice is amber — the warning above says it in full either way.
      risk: "caution",
    },
    {
      name: "context boundary",
      approval: {
        ...base,
        kind: "capability",
        capability: "context.boundary",
        title: "Retire runtime entity in another context",
        description:
          "This stops a runtime entity in the existing context owned by Agent X. It does not delete source files.",
        resource: {
          type: "context",
          label: "Workspace branch",
          value: "Agent X",
        },
        details: [
          { label: "Owner", value: "Agent X" },
          { label: "Runtime entity", value: "do:workers/agent:AgentDO:headless" },
        ],
      },
      category: "Permission request",
      title: "Retire runtime entity in another context",
      summaryIncludes: "stops a runtime entity",
      warning: "This can affect files and running work in a different part of your project.",
    },
    {
      name: "context boundary create do",
      approval: {
        ...base,
        kind: "capability",
        capability: "context.boundary",
        title: "Create do in another context",
        resource: {
          type: "context",
          label: "Workspace branch",
          value: "Agent X",
        },
        operation: {
          kind: "runtime",
          verb: "Create do",
          object: { type: "context", label: "Workspace branch", value: "Agent X" },
        },
        details: [{ label: "Owner", value: "Agent X" }],
      },
      category: "Permission request",
      title: "Launch background process in another workspace branch",
      summaryIncludes: "files and anything running",
      warning: "This can affect files and running work in a different part of your project.",
    },
  ];

  it.each(fixtures)(
    "formats $name copy",
    ({ approval, category, title, summaryIncludes, warning, detailsOpen, risk }) => {
      const copy = getApprovalCopy(approval);

      expect(getApprovalCategoryLabel(approval)).toBe(category);
      expect(copy.title).toBe(title);
      expect(copy.summary).toContain(summaryIncludes);
      expect(copy.warning).toBe(warning);
      expect(shouldOpenApprovalDetails(approval)).toBe(detailsOpen ?? false);
      expect(getApprovalRiskTone(approval)).toBe(risk ?? "standard");
    }
  );

  it("formats requester category labels", () => {
    expect(getRequesterCategoryLabel("eval")).toBe("Agent");
    expect(getRequesterCategoryLabel("worker")).toBe("Background task");
    expect(getRequesterCategoryLabel("durable-object")).toBe("Service");
    expect(getRequesterCategoryLabel("internal-service")).toBe("Built-in service");
    expect(getRequesterCategoryLabel("unknown")).toBe("Requester");
  });

  it("describes genuine cross-conversation access without exposing runtime ids", () => {
    const approval = {
      ...base,
      kind: "capability",
      capability: "workspace-service:channel",
      title: "send and receive messages in your conversations",
      callerId: "do:workers/agent-worker:AiChatWorker:ai-chat-deadbeef",
      callerKind: "do",
      callerTitle: "Workspace onboarding",
      resource: {
        type: "conversation",
        label: "Conversation",
        value: "Project planning",
      },
    } as PendingApproval;

    const copy = getApprovalCopy(approval);
    expect(copy).toEqual({
      title: "Let Workspace onboarding join Project planning?",
      summary: "Allow Workspace onboarding to read messages and send replies in Project planning.",
    });
    expect(JSON.stringify(copy)).not.toContain("ai-chat-deadbeef");
  });

  it("derives semantic attribution chips, never raw ids", () => {
    const byName = (name: string) => fixtures.find((fixture) => fixture.name === name)!.approval;
    const capability = byName("capability") as Extract<PendingApproval, { kind: "capability" }>;

    // Git uses the credential identity; non-oauth use names the audience.
    expect(getApprovalAttribution(byName("credential git-write"))).toEqual({
      relation: "using",
      target: "GitHub PAT",
    });
    // OAuth connect headlines the credential, so the chip surfaces the account.
    expect(getApprovalAttribution(byName("credential OAuth"))).toEqual({
      relation: "as",
      target: "me@example.com",
    });
    expect(getApprovalAttribution(byName("credential repo binding"))).toEqual({
      relation: "as",
      target: "octo",
    });
    // Capability requests without a target have no secondary chip.
    expect(getApprovalAttribution(capability)).toEqual({});
    expect(
      getApprovalAttribution({
        ...capability,
        target: {
          id: "panel:nav-flowboard",
          kind: "panel",
          title: "Rich Flowboard Store",
          sourcePath: "panels/flowboard",
        },
      })
    ).toEqual({ relation: "on", target: "Rich Flowboard Store" });
  });

  it("formats standard action labels by approval subtype", () => {
    const [capability, oauth, gitWrite] = fixtures.map((fixture) => fixture.approval);
    const workspaceSourceChange = fixtures.find(
      (fixture) => fixture.name === "workspace source change"
    )!.approval as Extract<PendingApproval, { kind: "capability" }>;
    const networkEgress = fixtures.find((fixture) => fixture.name === "network egress")!
      .approval as Extract<PendingApproval, { kind: "capability" }>;
    const repoBinding = fixtures.find((fixture) => fixture.name === "credential repo binding")!
      .approval as Extract<PendingApproval, { kind: "credential" }>;
    const evalCredential = {
      ...repoBinding,
      repoPath: "vibestudio/internal",
      effectiveVersion: "internal",
      requester: {
        id: "do:vibestudio/internal:EvalDO:one",
        kind: "do" as const,
        category: "eval" as const,
        title: "Agentic Chat",
        repoPath: "vibestudio/internal",
        effectiveVersion: "internal",
        stableIdentityKey: "do:vibestudio/internal:EvalDO:one",
        ephemeralInstanceKey: "do:vibestudio/internal:EvalDO:one",
        breadcrumbs: [],
      },
    };
    const evalNetworkEgress = {
      ...networkEgress,
      repoPath: "vibestudio/internal",
      effectiveVersion: "internal",
      requester: evalCredential.requester,
    };

    expect(
      getStandardActionCopy(oauth as Extract<PendingApproval, { kind: "credential" }>).once.label
    ).toBe("Connect once");
    expect(
      getStandardActionCopy(gitWrite as Extract<PendingApproval, { kind: "credential" }>).once.label
    ).toBe("Push once");
    expect(getStandardActionCopy(repoBinding).version!.description).toContain(
      "GitHub repositories at github.com/acme/project"
    );
    expect(
      getStandardActionCopy(capability as Extract<PendingApproval, { kind: "capability" }>).once
        .label
    ).toBe("Open once");
    expect(getStandardActionCopy(workspaceSourceChange).once.label).toBe("Update once");
    expect(getStandardActionCopy(workspaceSourceChange).session!.description).toContain(
      "panels/spectrolite"
    );
    expect(getStandardActionCopy(networkEgress).once.label).toBe("Connect once");
    expect(getStandardActionCopy(networkEgress).session!.label).toBe("Allow this site");
    expect(getStandardActionCopy(networkEgress).session!.description).toContain("localhost:42531");
    expect(getStandardActionCopy(networkEgress).version!.label).toBe(
      "Allow all internet access for this version"
    );
    expect(getStandardActionCopy(evalNetworkEgress).version!.label).toBe(
      "Allow all internet access for this agent"
    );
    expect(getStandardActionCopy(evalCredential).version!.label).toBe("Remember for this agent");
    expect(getStandardActionCopy(evalCredential).version!.description).toContain("this agent");
    expect(getStandardActionCopy(evalCredential).version!.description).toContain(
      "Each automated run is still reviewed before it can start"
    );
  });

  it("recommends task scope when a gated action offers it", () => {
    const capability = fixtures.find((fixture) => fixture.name === "capability")!.approval;
    const approval: Extract<PendingApproval, { kind: "capability" }> = {
      ...(capability as Extract<PendingApproval, { kind: "capability" }>),
      allowedDecisions: ["once", "task", "agent", "deny"],
    };

    expect(getRecommendedStandardDecision(approval)).toBe("task");
  });

  it("keeps runtime ids out of caller copy and standing-action labels", () => {
    const capability = fixtures.find((fixture) => fixture.name === "capability")!.approval;
    const approval: Extract<PendingApproval, { kind: "capability" }> = {
      ...(capability as Extract<PendingApproval, { kind: "capability" }>),
      callerId: "do:workers/agent-worker:AiChatWorker:ai-chat-2ec1-f7a9fd80",
      callerTitle: "Workspace maintenance agent",
      repoPath: "workers/agent-worker",
      allowedDecisions: ["agent"] as ["agent"],
      snapshot: {
        agentName: "do:workers/agent-worker:AiChatWorker:ai-chat-2ec1-f7a9fd80",
      } as NonNullable<Extract<PendingApproval, { kind: "capability" }>["snapshot"]>,
    };

    expect(getApprovalCallerPresentation(approval).label).toBe("Workspace maintenance agent");
    expect(getStandardApprovalDecisionActions(approval)).toEqual([
      expect.objectContaining({
        decision: "agent",
        label: "Always for Workspace maintenance agent",
      }),
    ]);

    const opaqueOnly = { ...approval, callerTitle: undefined };
    expect(getStandardApprovalDecisionActions(opaqueOnly)).toEqual([
      expect.objectContaining({ decision: "agent", label: "Always for this agent" }),
    ]);
    expect(getStandardApprovalDecisionActions(opaqueOnly)[0]?.label).not.toContain("do:workers/");
  });

  it("offers two actions, and no 'not now' on the review a workspace cannot decline", () => {
    const install = installReview({ parts: [reviewPart()] }) as Extract<
      PendingApproval,
      { kind: "unit-install-review" }
    >;
    expect(getInstallReviewActionCopy({ ...base, ...install })).toMatchObject({
      accept: { label: "Add template" },
      decline: { label: "Not now" },
    });

    // §7.1: the workspace is already created, so the equivalent escape is
    // deselecting everything rather than a button that undoes nothing.
    const creation = installReview({ mode: "adopt-root", parts: [reviewPart()] }) as Extract<
      PendingApproval,
      { kind: "unit-install-review" }
    >;
    const creationCopy = getInstallReviewActionCopy({ ...base, ...creation });
    expect(creationCopy.accept.label).toBe("Add to workspace");
    expect(creationCopy.decline).toBeUndefined();

    const edited = installReview({
      mode: "part-changed",
      parts: [reviewPart({ change: "changed" })],
    }) as Extract<PendingApproval, { kind: "unit-install-review" }>;
    expect(getInstallReviewActionCopy({ ...base, ...edited })).toMatchObject({
      accept: { label: "Use the new version" },
      decline: { label: "Keep the old version" },
    });

    const added = installReview({ mode: "part-changed", parts: [reviewPart()] }) as Extract<
      PendingApproval,
      { kind: "unit-install-review" }
    >;
    expect(getInstallReviewActionCopy({ ...base, ...added })).toMatchObject({
      accept: { label: "Add to workspace" },
      decline: { label: "Not now" },
    });
  });

  it("keeps the producer's aggregate change heading instead of naming its first part", () => {
    const edited = installReview({
      mode: "part-changed",
      title: "18 parts changed",
      description: "Someone edited these parts in your workspace.",
      parts: [
        reviewPart({ title: "Git Bridge", kind: "extension", label: "Extension" }),
        reviewPart({ identityKey: "unit:2", title: "Task Board" }),
      ],
    }) as Extract<PendingApproval, { kind: "unit-install-review" }>;

    expect(getApprovalCopy({ ...base, ...edited })).toMatchObject({
      title: "18 parts changed",
      summary: "Someone edited these parts in your workspace.",
    });
  });

  it("says an upgrade that changes nothing in one line, never as a list", () => {
    const upgrade = installReview({
      mode: "update",
      parts: [],
      unchangedPartCount: 12,
      template: {
        title: "News",
        purpose: "Read and discuss personalized news briefings.",
        origin: {
          url: "https://github.com/panticonic/news",
          originKey: "github.com/panticonic",
          registrableDomain: "github.com",
          version: "v1.4.0",
          isHostBuild: false,
          firstEncounter: false,
        },
        fromVersion: "1.2.0",
        toVersion: "1.4.0",
      },
    }) as Extract<PendingApproval, { kind: "unit-install-review" }>;

    expect(getApprovalCopy({ ...base, ...upgrade })).toMatchObject({
      title: "Update News",
      summary: "Updates 12 parts. No permission changes.",
    });
  });

  // A template may omit its description, and a hostile one may supply a
  // description sanitization strips to nothing. `??` catches neither, and both
  // used to render the card's summary as an empty line — the one outcome a copy
  // layer exists to prevent, handed to an attacker for writing something we
  // refuse to print.
  it("never renders a blank summary for a template that stated no purpose", () => {
    const template = (purpose: string) => ({
      title: "News",
      purpose,
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
    });

    const empty = installReview({
      template: template(""),
      description: "Read and discuss personalized news briefings.",
      parts: [reviewPart()],
      summary: { panels: 1, agents: 0, services: 0, clientApps: 0, extensions: 0 },
    }) as Extract<PendingApproval, { kind: "unit-install-review" }>;
    expect(getApprovalCopy({ ...base, ...empty })).toMatchObject({
      title: "Add News",
      summary: "Read and discuss personalized news briefings.",
    });

    // Whitespace is nothing, for the same reason.
    const blank = installReview({
      template: template("   \n "),
      description: "  ",
      parts: [reviewPart()],
      summary: { panels: 1, agents: 0, services: 0, clientApps: 0, extensions: 0 },
    }) as Extract<PendingApproval, { kind: "unit-install-review" }>;
    // Nothing printable was supplied at all, so the platform's own count of
    // what is arriving stands in — never an empty line.
    expect(getApprovalCopy({ ...base, ...blank })).toMatchObject({
      title: "Add News",
      summary: "Adds 1 panel",
    });
  });

  it("never speaks the runtime's vocabulary on the review a person reads", () => {
    const review = installReview({
      parts: [reviewPart(), reviewPart({ identityKey: "unit:2", kind: "worker", label: "Agent" })],
    }) as Extract<PendingApproval, { kind: "unit-install-review" }>;
    const copy = getApprovalCopy({ ...base, ...review });
    const actions = getInstallReviewActionCopy({ ...base, ...review });

    expect(
      [copy.title, copy.summary, actions.accept.description, actions.decline?.description]
        .filter(Boolean)
        .join(" ")
    ).not.toMatch(/\bunits?\b|\bmanifest\b|\bcapabilit/iu);
  });

  it("formats low-level detail helpers", () => {
    const credential = fixtures.find((fixture) => fixture.name === "credential OAuth")!
      .approval as Extract<PendingApproval, { kind: "credential" }>;
    const credentialInput = fixtures.find((fixture) => fixture.name === "credential-input")!
      .approval as Extract<PendingApproval, { kind: "credential-input" }>;

    expect(formatAccount(credential)).toBe("me@example.com");
    expect(formatInjection(credential)).toBe("header Authorization");
    expect(formatInjection(credentialInput)).toBe("query api_key");
    expect(formatGitRemoteSummary("https://github.com/acme/project.git")).toBe(
      "github.com/acme/project"
    );
    expect(formatNetworkDestination("http://localhost:42531")).toBe("localhost:42531");
    expect(originForUrl("https://accounts.google.com/o/oauth2/v2/auth")).toBe(
      "https://accounts.google.com"
    );
    expect(formatServiceName("google-calendar")).toBe("Google Calendar");
  });
});
