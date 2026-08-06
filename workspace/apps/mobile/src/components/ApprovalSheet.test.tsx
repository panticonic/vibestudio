import React from "react";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { ApprovalSheet } from "./ApprovalSheet";
import type { PendingApproval } from "@vibestudio/shared/approvals";
import { authorityRow } from "@vibestudio/shared/authority/authorityRows";
import type {
  InstallReviewPart,
  InstallReviewRow,
} from "@vibestudio/shared/authority/unitInstallReview";

const base = {
  approvalId: "approval-1",
  callerId: "worker-abcdef123456",
  callerKind: "worker",
  repoPath: "/projects/foo",
  effectiveVersion: "v1",
  requestedAt: 1,
} as const;

const capability: PendingApproval = {
  ...base,
  kind: "capability",
  capability: "open-url",
  title: "Open URL",
  resource: { type: "url", label: "URL", value: "https://github.com/foo/bar" },
  details: [{ label: "URL", value: "https://github.com/foo/bar" }],
};

const consequentialCapability: PendingApproval = {
  ...base,
  kind: "capability",
  capability: "push.send",
  title: "Send the nightly briefing",
  resource: { type: "channel", label: "Recipient", value: "Briefings" },
  allowedDecisions: ["once", "task", "agent", "deny"],
  authorityRow: authorityRow({
    capability: "push.send",
    resource: { kind: "exact", key: "channel:briefings" },
    resourcePhrase: "Briefings",
    tier: "gated",
    statement: "prospective",
    provenance: { source: "receiver" },
  }),
  operationSubstance: {
    kind: "send",
    summary: "Send 1 briefing to Briefings",
    detail: "Subject: Overnight workspace summary",
    facts: [
      { label: "Recipient", value: "Briefings" },
      { label: "Delivery", value: "Send now" },
    ],
    digest: "prepared:briefing-1",
  },
};

const credential: PendingApproval = {
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
  oauthAudienceDomainMismatch: true,
  bindingLabel: "Calendar account for scheduling",
  grantResource: {
    bindingId: "calendar-primary",
    action: "read",
    resource: "calendar/events",
  },
};

const missionReview: PendingApproval = {
  ...base,
  kind: "mission-review",
  missionId: "mission-1",
  revision: 2,
  closureDigest: "closure-abc123",
  reviewKind: "revision",
  title: "Review morning briefing",
  taskSummary: "Prepare a morning briefing.",
  triggerSummary: "Every weekday at 08:00",
  authority: {
    rows: [],
    diff: { added: [], removed: [], unchanged: [], retiered: [] },
  },
  toolkitDomains: [],
  networkSummary: "No network access",
  lineageSummary: "Workspace content",
  charter: {
    agentBindingId: "briefing-agent",
    taskSpec: "Prepare a morning briefing.",
    harness: { unit: "workers/briefing", ev: "ev-harness-123" },
    skills: [],
    toolExposure: {
      services: [],
      userlandServices: [],
      workspaceServiceDiscovery: "bound",
      evalNetwork: "none",
      declaredOrigins: [],
    },
    model: { modelId: "openai/gpt-mobile-review", params: {} },
    declaredLineageClasses: ["none"],
    trigger: { kind: "cron", cron: "0 8 * * 1-5" },
  },
  charterChanges: [],
};

const notificationsRow = authorityRow({
  capability: "push.send",
  resource: { kind: "prefix", prefix: "" },
  tier: "gated",
  statement: "declared",
  provenance: { source: "manifest" },
});
const accountProfileRow = authorityRow({
  capability: "account.profile.read",
  resource: { kind: "prefix", prefix: "" },
  tier: "gated",
  statement: "declared",
  provenance: { source: "manifest" },
});

const clientConfig: PendingApproval = {
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
};

const credentialInput: PendingApproval = {
  ...base,
  kind: "credential-input",
  title: "Add API key",
  credentialLabel: "Acme API",
  audience: [{ match: "path-prefix", url: "https://api.acme.test/v1/projects" }],
  injection: { type: "query-param", name: "api_key" },
  accountIdentity: { providerUserId: "acme-user" },
  scopes: ["projects.read"],
  fields: [{ name: "apiKey", label: "API Key", type: "secret", required: true }],
};

const secretInput: PendingApproval = {
  ...base,
  kind: "secret-input",
  title: "Enter sudo password",
  description: "Authenticate sudo for: sudo id",
  warning: "This password is used once and is not stored.",
  details: [{ label: "Command", value: "sudo id" }],
  fields: [{ name: "password", label: "Sudo password", type: "secret", required: true }],
};

const genericApproval: PendingApproval = {
  ...base,
  kind: "capability",
  capability: "context.boundary",
  title: "Open another workspace branch",
  description: "This action affects another workspace branch.",
  resource: { type: "context", label: "Workspace branch", value: "Agent X" },
  details: [{ label: "Reason", value: "continue work" }],
};

const deviceCode: PendingApproval = {
  ...base,
  kind: "device-code",
  credentialLabel: "GitHub",
  userCode: "ABCD-1234",
  verificationUri: "https://github.com/login/device",
  verificationUriComplete: "https://github.com/login/device?user_code=ABCD-1234",
  expiresAt: Date.now() + 600_000,
  oauthTokenOrigin: "https://github.com/login/oauth/access_token",
};

const installReview: PendingApproval = {
  ...base,
  callerId: "system:workspace-startup",
  callerKind: "system",
  repoPath: "meta",
  kind: "unit-install-review",
  mode: "adopt-root",
  title: "Start this workspace?",
  description: "Vibestudio needs to run 2 programs on this computer.",
  parts: [
    {
      identityKey: "apps/mobile@ev-mobile",
      kind: "app",
      label: "Client App",
      surfaces: [],
      name: "@workspace-apps/mobile",
      title: "Mobile",
      purpose: "The mobile app itself.",
      repoPath: "apps/mobile",
      effectiveVersion: "ev-mobile",
      version: null,
      requiredUnitKeys: [],
      runsInBackground: false,
      target: "react-native",
      origin: {
        url: null,
        originKey: "vibestudio",
        registrableDomain: null,
        version: "1.4.0",
        isHostBuild: true,
        firstEncounter: false,
      },
      notableRows: [
        {
          kind: "permission",
          key: "push.send\u0000{}",
          row: notificationsRow,
          timing: "asks-every-time",
          notability: "headline",
          selectable: false,
          selectedByDefault: false,
        },
      ],
      everydayRows: [
        {
          kind: "permission",
          key: "account.profile.read\u0000{}",
          row: accountProfileRow,
          timing: "on-add",
          notability: "everyday",
          selectable: true,
          selectedByDefault: true,
        },
      ],
      change: "added",
      section: "template",
    },
    {
      identityKey: "extensions/git-tools@ev-extension",
      kind: "extension",
      label: "Extension",
      surfaces: [],
      name: "@workspace-extensions/git-tools",
      title: "Git Tools",
      purpose: "Adds Git tools to the host.",
      repoPath: "extensions/git-tools",
      effectiveVersion: "ev-extension",
      version: null,
      requiredUnitKeys: [],
      runsInBackground: false,
      target: null,
      origin: {
        url: null,
        originKey: "vibestudio",
        registrableDomain: null,
        version: "1.4.0",
        isHostBuild: true,
        firstEncounter: false,
      },
      notableRows: [],
      everydayRows: [],
      change: "added",
      section: "template",
    },
  ],
  summary: { panels: 0, agents: 0, services: 0, clientApps: 1, extensions: 1 },
  unchangedPartCount: 0,
};

/**
 * A headline row backed by the real \`push.send\` capability (action: "send a
 * notification"), distinguished by its resource phrase so several can coexist
 * in one part for split/collapse tests without inventing unregistered
 * capabilities.
 */
function headlineRow(id: string, timing: InstallReviewRow["timing"] = "on-add"): InstallReviewRow {
  return {
    kind: "permission",
    key: `push.send#${id}`,
    row: authorityRow({
      capability: "push.send",
      resource: { kind: "exact", key: id },
      resourcePhrase: id,
      tier: "gated",
      statement: "declared",
      provenance: { source: "manifest" },
    }),
    timing,
    notability: "headline",
    selectable: timing === "on-add",
    selectedByDefault: timing === "on-add",
  };
}

function reviewPart(
  overrides: Partial<InstallReviewPart> & Pick<InstallReviewPart, "identityKey" | "title">
): InstallReviewPart {
  return {
    kind: "worker",
    label: "Agent",
    surfaces: [],
    name: overrides.title,
    purpose: "Does its job.",
    repoPath: "template/part",
    effectiveVersion: "ev-part",
    version: null,
    requiredUnitKeys: [],
    runsInBackground: false,
    origin: {
      url: null,
      originKey: "vibestudio",
      registrableDomain: null,
      version: "1.4.0",
      isHostBuild: true,
      firstEncounter: false,
    },
    notableRows: [],
    everydayRows: [],
    change: "added",
    section: "template",
    ...overrides,
  };
}

const browserPermission: PendingApproval = {
  ...base,
  callerId: "panel-browser-1",
  callerKind: "panel",
  kind: "browser-permission",
  ownerUserId: "usr_owner",
  workspaceId: "workspace-1",
  environmentKey: "browser-env-1",
  panelId: "panel-browser-1",
  origin: "https://meet.example.com",
  topLevelUrl: "https://meet.example.com/room",
  capabilities: ["camera", "microphone"],
  deviceLabel: "This device",
};

function renderSheet(
  approval: PendingApproval | PendingApproval[],
  overrides: Partial<React.ComponentProps<typeof ApprovalSheet>> = {}
) {
  const props = {
    approvals: Array.isArray(approval) ? approval : [approval],
    onResolve: jest.fn(async () => undefined),
    onSubmitClientConfig: jest.fn(async () => undefined),
    onSubmitCredentialInput: jest.fn(async () => undefined),
    onSubmitSecretInput: jest.fn(async () => undefined),
    onResolveMissionReview: jest.fn(async () => undefined),
    ...overrides,
  };
  const view = render(<ApprovalSheet {...props} />);
  return { ...view, props };
}

describe("ApprovalSheet", () => {
  it("presents one accessible modal summary that remains usable with long localized copy", () => {
    const localized = {
      ...genericApproval,
      title:
        "Autoriser l’ouverture de cette adresse particulièrement longue dans le navigateur sécurisé",
      summary:
        "Cette demande particulièrement détaillée reste lisible même avec un agrandissement important du texte.",
    };
    const { getByTestId } = renderSheet(localized);
    const sheet = getByTestId("approval-sheet");

    expect(sheet.props.accessible).toBe(true);
    expect(sheet.props.accessibilityViewIsModal).toBe(true);
    expect(sheet.props.accessibilityLabel).toContain(localized.title);
    expect(sheet.props.accessibilityHint).toContain("choose an action");
  });

  it.each([
    [capability, "Open github.com/foo/..."],
    [credential, "Connect Google Calendar"],
    [clientConfig, "Set up Google Calendar"],
    [credentialInput, "Add Acme API"],
    [secretInput, "Enter sudo password"],
    [genericApproval, "Open another workspace branch"],
    [deviceCode, "Sign in to GitHub"],
    [installReview, "Start this workspace?"],
    [browserPermission, "Allow camera and microphone on https://meet.example.com?"],
    [missionReview, "Review Review morning briefing"],
  ] as const)("renders %s", (approval, title) => {
    const { getByText } = renderSheet(approval);
    expect(getByText(title)).toBeTruthy();
  });

  it("lazily renders the exact reviewed file diff and keeps full inspection available", async () => {
    const diffApproval: PendingApproval = {
      ...capability,
      diffReview: [
        {
          repoPath: "panels/chat",
          oldState: "old-state",
          newState: "new-state",
          diffStat: { filesChanged: 2, insertions: 1, deletions: 1 },
          changedFiles: [
            {
              path: "src/message.ts",
              kind: "changed",
              oldHash: "old-hash",
              newHash: "new-hash",
            },
            { path: "assets/icon.png", kind: "changed", binary: true },
          ],
        },
      ],
    };
    const content = new Map([
      ["old-hash", "one\ntwo\nthree\nfour\nfive\nold value\nseven\neight\nnine\nten"],
      ["new-hash", "one\ntwo\nthree\nfour\nfive\nnew value\nseven\neight\nnine\nten"],
    ]);
    const onFetchDiffContent = jest.fn(async (_approvalId: string, hash: string) =>
      content.get(hash)
    );
    const onOpenDiffFile = jest.fn(async () => undefined);
    const { getByTestId, getByText } = renderSheet(diffApproval, {
      onFetchDiffContent,
      onOpenDiffFile,
    });

    expect(getByText("Review changes")).toBeTruthy();
    expect(getByText("2 files · 1 repository")).toBeTruthy();
    expect(onFetchDiffContent).not.toHaveBeenCalled();

    fireEvent.press(getByTestId("approval-diff-file-src/message.ts"));
    await waitFor(() => expect(onFetchDiffContent).toHaveBeenCalledTimes(2));
    expect(onFetchDiffContent.mock.calls).toEqual(
      expect.arrayContaining([
        ["approval-1", "old-hash"],
        ["approval-1", "new-hash"],
      ])
    );
    await waitFor(() => expect(getByText("old value")).toBeTruthy());
    expect(getByText("new value")).toBeTruthy();
    expect(getByText(/unchanged context is folded/)).toBeTruthy();

    fireEvent.press(getByTestId("approval-diff-open-src/message.ts"));
    await waitFor(() =>
      expect(onOpenDiffFile).toHaveBeenCalledWith(
        diffApproval.diffReview![0]!.changedFiles[0],
        diffApproval.diffReview![0]
      )
    );
  });

  it("shows credential binding and grant scope in request details", () => {
    const { getByText } = renderSheet(credential);
    expect(getByText("Calendar account for scheduling")).toBeTruthy();
    expect(getByText("calendar-primary read calendar/events")).toBeTruthy();
  });

  it("discloses the exact mission closure, harness, and model", () => {
    const { getByTestId, getByText, queryByText } = renderSheet(missionReview);
    expect(queryByText("closure-abc123")).toBeNull();
    fireEvent.press(getByTestId("mission-developer-details"));
    expect(getByText("closure-abc123")).toBeTruthy();
    expect(getByText("workers/briefing@ev-harness-123")).toBeTruthy();
    expect(getByText("openai/gpt-mobile-review")).toBeTruthy();
  });

  it("puts what is worth knowing above the everyday fold", () => {
    const { getAllByText, getByText, getByTestId, queryByText } = renderSheet(installReview);

    // The list line states what is notable, or an honest ordinary footprint.
    expect(getByText(/Publishing & sending|send a notification/)).toBeTruthy();
    expect(queryByText("view an account profile")).toBeNull();

    fireEvent.press(getByTestId("install-review-part-apps/mobile@ev-mobile"));
    // Worth knowing is shown immediately — nothing notable is ever folded away.
    expect(getAllByText("send a notification").length).toBeGreaterThan(0);
    // The everyday row stays behind its own disclosure until asked for.
    expect(queryByText("view an account profile")).toBeNull();
    expect(getByText("Plus 1 everyday permission")).toBeTruthy();

    fireEvent.press(getByText("Plus 1 everyday permission"));
    expect(
      getByText(
        "These are the ordinary things parts do here. Ordinary doesn't mean harmless — open any one to see what it does."
      )
    ).toBeTruthy();
    expect(getByText("view an account profile")).toBeTruthy();
  });

  it("uses the desktop category order, summaries, and intelligent default folding", () => {
    const notable = headlineRow("notable");
    const groupedReview: PendingApproval = {
      ...installReview,
      parts: [
        reviewPart({
          identityKey: "panels/chat@ev",
          title: "Chat",
          kind: "panel",
          label: "Panel",
          repoPath: "panels/chat",
          notableRows: [notable],
        }),
        reviewPart({
          identityKey: "workers/researcher@ev",
          title: "Researcher",
          repoPath: "workers/researcher",
          notableRows: [notable],
        }),
        reviewPart({
          identityKey: "about/accounts@ev",
          title: "Accounts",
          kind: "panel",
          label: "Panel",
          repoPath: "about/accounts",
          purpose: "Manage workspace accounts.",
        }),
        reviewPart({
          identityKey: "workers/pubsub@ev",
          title: "Pubsub",
          label: "Service",
          repoPath: "workers/pubsub",
          purpose: "Connect workspace conversations.",
        }),
      ],
    };
    const { getAllByText, getByTestId, getByText, queryByTestId } = renderSheet(groupedReview);

    expect(
      getAllByText(/^(App panels|Agents and background tasks|System panels|Services)$/u).map(
        (node) => node.props.children
      )
    ).toEqual(["App panels", "Agents and background tasks", "System panels", "Services"]);

    const appPanels = getByTestId("install-review-group-app-panels");
    const agents = getByTestId("install-review-group-agents-and-background-tasks");
    const systemPanels = getByTestId("install-review-group-system-panels");
    const services = getByTestId("install-review-group-services");
    expect(appPanels.props.accessibilityState.expanded).toBe(true);
    expect(agents.props.accessibilityState.expanded).toBe(true);
    expect(systemPanels.props.accessibilityState.expanded).toBe(false);
    expect(services.props.accessibilityState.expanded).toBe(false);
    expect(systemPanels.props.accessibilityLabel).toContain("Accounts");
    expect(systemPanels.props.accessibilityLabel).toContain("nothing unusual");
    expect(queryByTestId("install-review-part-about/accounts@ev")).toBeNull();

    fireEvent.press(systemPanels);
    expect(getByTestId("install-review-part-about/accounts@ev")).toBeTruthy();
    expect(getByText("Manage workspace accounts.")).toBeTruthy();
  });

  it("keeps every category open when the whole workspace is routine", () => {
    const routineReview: PendingApproval = {
      ...installReview,
      parts: [
        reviewPart({
          identityKey: "panels/chat@ev",
          title: "Chat",
          kind: "panel",
          label: "Panel",
          repoPath: "panels/chat",
        }),
        reviewPart({
          identityKey: "about/accounts@ev",
          title: "Accounts",
          kind: "panel",
          label: "Panel",
          repoPath: "about/accounts",
        }),
      ],
    };
    const { getByTestId } = renderSheet(routineReview);

    expect(getByTestId("install-review-group-app-panels").props.accessibilityState.expanded).toBe(
      true
    );
    expect(
      getByTestId("install-review-group-system-panels").props.accessibilityState.expanded
    ).toBe(true);
  });

  it("searches and filters across folded categories without changing the decision", async () => {
    const parts = Array.from({ length: 13 }, (_, index) =>
      reviewPart({
        identityKey: `unit-${index}`,
        title: index === 0 ? "Chat" : `Worker ${index}`,
        kind: index === 0 ? "panel" : "worker",
        label: index === 0 ? "Panel" : "Agent",
        repoPath: index === 0 ? "panels/chat" : `workers/worker-${index}`,
        notableRows: index === 0 ? [headlineRow("chat")] : [],
      })
    );
    const onResolveInstallReview = jest.fn(async () => undefined);
    const { getByTestId, getByText, queryByTestId } = renderSheet(
      { ...installReview, parts },
      { onResolveInstallReview }
    );

    // The quiet worker category begins folded, but a search result is never
    // trapped behind it. While filtering, the category says it cannot fold.
    expect(
      getByTestId("install-review-group-agents-and-background-tasks").props.accessibilityState
        .expanded
    ).toBe(false);
    fireEvent.changeText(getByTestId("install-review-search"), "Worker 4");
    expect(getByTestId("install-review-part-unit-4")).toBeTruthy();
    expect(
      getByTestId("install-review-group-agents-and-background-tasks").props.accessibilityState
    ).toEqual(expect.objectContaining({ disabled: true, expanded: true }));
    expect(getByText(/12 parts hidden by your search/u)).toBeTruthy();

    fireEvent.changeText(getByTestId("install-review-search"), "");
    fireEvent.press(getByTestId("install-review-kind-Panel"));
    expect(getByTestId("install-review-part-unit-0")).toBeTruthy();
    expect(queryByTestId("install-review-part-unit-4")).toBeNull();
    expect(getByTestId("install-review-kind-Panel").props.accessibilityState.selected).toBe(true);

    // Filtering changes visibility only; accepting still names every part.
    fireEvent.press(getByTestId("approval-action-accept-install-review"));
    await waitFor(() => {
      const resolution = onResolveInstallReview.mock.calls[0]?.[1];
      expect(resolution).toMatchObject({ decision: "adopt-root" });
      expect(resolution?.decision === "cancel" ? [] : resolution?.allowNow).toHaveLength(13);
    });
  });

  it("collapses worth knowing past five rows, but never drops one", () => {
    const manyNotable: PendingApproval = {
      ...installReview,
      parts: [
        reviewPart({
          identityKey: "template/six@ev-six",
          title: "Six Notable",
          notableRows: ["a", "b", "c", "d", "e", "f"].map((id) => headlineRow(id)),
        }),
      ],
    };
    const { getAllByText, getByText, queryByText, getByTestId } = renderSheet(manyNotable);
    fireEvent.press(getByTestId("install-review-part-template/six@ev-six"));

    // Five shown, the sixth folded behind an honest count — nothing dropped.
    expect(getAllByText("send a notification")).toHaveLength(5);
    expect(getByText("Show all 6 notable")).toBeTruthy();

    fireEvent.press(getByText("Show all 6 notable"));
    expect(getAllByText("send a notification")).toHaveLength(6);
    expect(queryByText("Show all 6 notable")).toBeNull();
  });

  it("auto-expands worth knowing when any row always confirms", () => {
    const criticalAmongMany: PendingApproval = {
      ...installReview,
      parts: [
        reviewPart({
          identityKey: "template/critical@ev-critical",
          title: "Critical Mixed",
          notableRows: [
            ...["a", "b", "c", "d", "e"].map((id) => headlineRow(id)),
            headlineRow("f", "asks-every-time"),
          ],
        }),
      ],
    };
    const { getAllByText, queryByText, getByTestId } = renderSheet(criticalAmongMany);
    fireEvent.press(getByTestId("install-review-part-template/critical@ev-critical"));

    // The one row a person must not miss forces the whole list open by default.
    expect(queryByText("Show all 6 notable")).toBeNull();
    expect(getAllByText("send a notification")).toHaveLength(6);
  });

  it("shows agent-authored repairs in their own section, never folded away", () => {
    const withRepair: PendingApproval = {
      ...installReview,
      parts: [
        ...installReview.parts,
        reviewPart({
          identityKey: "workspace/chat@ev-chat",
          title: "Chat",
          purpose: "Fixed to work with News.",
          section: "repair",
          change: "changed",
          notableRows: [headlineRow("chat-fix")],
        }),
      ],
    };
    const { getByText, getByTestId } = renderSheet(withRepair);

    // Always shown, unconditionally — a repair touches a part the template
    // does not own, so it is never folded into or hidden behind the
    // template's own list.
    expect(getByText("Also changes 1 part already in your workspace")).toBeTruthy();
    expect(getByText("Chat · Agent")).toBeTruthy();
    fireEvent.press(getByTestId("install-review-part-workspace/chat@ev-chat"));
    // The repair's own row, identified by its distinguishing resource phrase.
    expect(getByText("chat-fix")).toBeTruthy();
  });

  it("renders the honest From line: origin URL, or an honest host-build statement, never a version or kind label alone", () => {
    const foreignOrigin: PendingApproval = {
      ...installReview,
      parts: [
        ...installReview.parts,
        reviewPart({
          identityKey: "template/news@ev-news",
          title: "News",
          version: "1.2.0",
          originallyInstalledFrom: "News 1.0.0",
          origin: {
            url: "github.com/panticonic/news",
            originKey: "panticonic/news",
            registrableDomain: "github.com",
            version: "1.2.0",
            isHostBuild: false,
            firstEncounter: true,
          },
        }),
      ],
    };
    const { getByText, getByTestId, queryByText } = renderSheet(foreignOrigin);
    fireEvent.press(getByTestId("install-review-group-directory:template"));
    fireEvent.press(getByTestId("install-review-part-template/news@ev-news"));

    // The origin URL, exactly — never "From: 1.2.0" and never "From: News".
    expect(getByText("github.com/panticonic/news")).toBeTruthy();
    expect(queryByText("1.2.0")).toBeNull();
    expect(queryByText("News")).toBeNull();
    expect(getByText("Originally installed from")).toBeTruthy();
    expect(getByText("News 1.0.0")).toBeTruthy();

    // The host's own build is named honestly rather than by a bare version.
    fireEvent.press(getByTestId("install-review-part-apps/mobile@ev-mobile"));
    expect(getByText("Vibestudio 1.4.0")).toBeTruthy();
  });

  it("emphasizes the registrable domain inside the URL, and states it in words", () => {
    // The lookalike is the whole reason the emphasis exists: a person reads
    // `github.com.attacker.net` as GitHub, and the domain that owns it is
    // `attacker.net`. The URL is never shortened to the domain, and the domain
    // is stated as well as drawn, because weight is invisible to a screen
    // reader and to a monochrome display.
    const lookalike: PendingApproval = {
      ...installReview,
      parts: [
        reviewPart({
          identityKey: "template/studio@ev-studio",
          title: "Studio",
          version: "2.1.0",
          origin: {
            url: "https://github.com.attacker.net/acme/studio",
            originKey: "github.com.attacker.net/acme",
            registrableDomain: "attacker.net",
            version: "2.1.0",
            isHostBuild: false,
            firstEncounter: true,
          },
        }),
      ],
    };
    const { getByText, getAllByText, getByTestId, queryByText } = renderSheet(lookalike);
    fireEvent.press(getByTestId("install-review-part-template/studio@ev-studio"));

    // Whole, never shortened to the domain.
    expect(getByText("https://github.com.attacker.net/acme/studio")).toBeTruthy();
    // Emphasized in place: weight and an underline, never colour alone.
    const emphasis = getAllByText("attacker.net").find((node) => {
      const style = Array.isArray(node.props.style) ? node.props.style[0] : node.props.style;
      return style?.fontWeight === "800" && style?.textDecorationLine === "underline";
    });
    expect(emphasis).toBeTruthy();
    // And said out loud, in the same words every other surface uses.
    expect(getByText("Domain")).toBeTruthy();
    expect(queryByText("github.com")).toBeNull();
  });

  it.each(["once", "session", "version", "deny"] as const)(
    "resolves standard decision %s",
    async (decision) => {
      const onResolve = jest.fn(async () => undefined);
      const { getByTestId } = renderSheet(capability, { onResolve });

      fireEvent.press(getByTestId(`approval-action-${decision}`));

      await waitFor(() => expect(onResolve).toHaveBeenCalledWith("approval-1", decision));
    }
  );

  it("shows the exact prepared effect and eligible agent scope on mobile", async () => {
    const onResolve = jest.fn(async () => undefined);
    const { getByText, getByTestId } = renderSheet(consequentialCapability, { onResolve });
    expect(getByText("Publishing & sending")).toBeTruthy();
    expect(getByText("What exactly")).toBeTruthy();
    expect(getByText("Send 1 briefing to Briefings")).toBeTruthy();
    expect(getByText("Subject: Overnight workspace summary")).toBeTruthy();
    expect(getByText("Recipient")).toBeTruthy();
    expect(getByText("Briefings")).toBeTruthy();
    expect(getByText("Delivery")).toBeTruthy();
    expect(getByText("Send now")).toBeTruthy();
    fireEvent.press(getByTestId("approval-action-agent"));
    await waitFor(() => expect(onResolve).toHaveBeenCalledWith("approval-1", "agent"));
  });

  it("renders only the credential lifetimes advertised by the host", () => {
    const { getByText, queryByTestId } = renderSheet(credential);

    expect(getByText("Connect once")).toBeTruthy();
    expect(getByText("Connect for now")).toBeTruthy();
    expect(getByText("Trust this version")).toBeTruthy();
    expect(queryByTestId("approval-action-task")).toBeNull();
    expect(queryByTestId("approval-action-agent")).toBeNull();
  });

  it.each(["once", "session", "always", "block", "dismiss"] as const)(
    "resolves browser permission decision %s",
    async (decision) => {
      const onResolve = jest.fn(async () => undefined);
      const { getByTestId, getByText } = renderSheet(browserPermission, { onResolve });

      fireEvent.press(getByText("Request details"));
      expect(getByText("camera, microphone")).toBeTruthy();
      expect(getByText("This device")).toBeTruthy();
      fireEvent.press(getByTestId(`approval-action-${decision}`));

      await waitFor(() => expect(onResolve).toHaveBeenCalledWith("approval-1", decision));
    }
  );

  it("submits client config only after required fields are filled", async () => {
    const onSubmitClientConfig = jest.fn(async () => undefined);
    const { getByTestId } = renderSheet(clientConfig, { onSubmitClientConfig });

    fireEvent.press(getByTestId("approval-submit"));
    expect(onSubmitClientConfig).not.toHaveBeenCalled();

    fireEvent.changeText(getByTestId("approval-field-clientId"), "client-id");
    fireEvent.changeText(getByTestId("approval-field-clientSecret"), "secret");
    fireEvent.press(getByTestId("approval-submit"));

    await waitFor(() =>
      expect(onSubmitClientConfig).toHaveBeenCalledWith("approval-1", {
        clientId: "client-id",
        clientSecret: "secret",
      })
    );
  });

  it("submits credential input only after required fields are filled", async () => {
    const onSubmitCredentialInput = jest.fn(async () => undefined);
    const { getByTestId } = renderSheet(credentialInput, { onSubmitCredentialInput });

    fireEvent.press(getByTestId("approval-submit"));
    expect(onSubmitCredentialInput).not.toHaveBeenCalled();

    fireEvent.changeText(getByTestId("approval-field-apiKey"), "github_pat_1");
    fireEvent.press(getByTestId("approval-submit"));

    await waitFor(() =>
      expect(onSubmitCredentialInput).toHaveBeenCalledWith("approval-1", {
        apiKey: "github_pat_1",
      })
    );
  });

  it("submits one-shot secret input only after required fields are filled", async () => {
    const onSubmitSecretInput = jest.fn(async () => undefined);
    const { getByTestId, getByText } = renderSheet(secretInput, { onSubmitSecretInput });

    expect(getByText("Continue")).toBeTruthy();
    fireEvent.press(getByTestId("approval-submit"));
    expect(onSubmitSecretInput).not.toHaveBeenCalled();

    fireEvent.changeText(getByTestId("approval-field-password"), "hunter2");
    fireEvent.press(getByTestId("approval-submit"));

    await waitFor(() =>
      expect(onSubmitSecretInput).toHaveBeenCalledWith("approval-1", {
        password: "hunter2",
      })
    );
  });

  it("renders OAuth mismatch warning conditionally", () => {
    const { getByText, queryByText, rerender } = renderSheet(credential);
    expect(
      getByText(
        "The sign-in site is different from the service's site. Make sure you recognize both."
      )
    ).toBeTruthy();

    rerender(
      <ApprovalSheet
        approvals={[{ ...credential, oauthAudienceDomainMismatch: false }]}
        onResolve={jest.fn()}
        onSubmitClientConfig={jest.fn()}
        onSubmitCredentialInput={jest.fn()}
        onSubmitSecretInput={jest.fn()}
        onResolveMissionReview={jest.fn()}
      />
    );
    expect(queryByText("The sign-in domain differs from the service domain.")).toBeNull();
  });

  it("renders the caller chip with the kind icon and label", () => {
    const titledPanel: PendingApproval = {
      ...base,
      callerKind: "panel",
      callerTitle: "My Project",
      kind: "capability",
      capability: "open-url",
      title: "Open URL",
      resource: { type: "url", label: "URL", value: "https://example.com" },
    };
    const { getByText, getByTestId } = renderSheet(titledPanel);
    expect(getByTestId("approval-caller-chip")).toBeTruthy();
    expect(getByText("My Project")).toBeTruthy();
    expect(getByText("panel")).toBeTruthy();
  });

  it("calls onNavigateToPanel when the caller is a panel and the chip is pressed", () => {
    const titledPanel: PendingApproval = {
      ...base,
      callerId: "panel:abc",
      callerKind: "panel",
      callerTitle: "Spectrolite",
      kind: "capability",
      capability: "context.boundary",
      title: "Open another workspace branch",
      resource: { type: "context", label: "Workspace branch", value: "Agent X" },
    };
    const onNavigateToPanel = jest.fn();
    const { getByTestId } = renderSheet(titledPanel, { onNavigateToPanel });
    fireEvent.press(getByTestId("approval-caller-chip"));
    expect(onNavigateToPanel).toHaveBeenCalledWith("panel:abc");
  });

  it("steps through a queue of pending approvals", () => {
    const a: PendingApproval = {
      ...base,
      approvalId: "a1",
      kind: "capability",
      capability: "context.boundary",
      title: "First request",
      resource: { type: "context", label: "Workspace branch", value: "Agent X" },
    };
    const b: PendingApproval = { ...a, approvalId: "a2", title: "Second request" };
    const c: PendingApproval = { ...a, approvalId: "a3", title: "Third request" };
    const { getByText, getByTestId } = renderSheet([a, b, c]);
    expect(getByText("First request")).toBeTruthy();
    expect(getByText("1 / 3")).toBeTruthy();
    fireEvent.press(getByTestId("approval-queue-next"));
    expect(getByText("Second request")).toBeTruthy();
    expect(getByText("2 / 3")).toBeTruthy();
    fireEvent.press(getByTestId("approval-queue-prev"));
    expect(getByText("First request")).toBeTruthy();
  });

  it("renders device-code approvals and lets the user cancel waiting", async () => {
    const onResolve = jest.fn(async () => undefined);
    const { getByText, getByTestId } = renderSheet(deviceCode, { onResolve });

    expect(getByText("ABCD-1234")).toBeTruthy();
    expect(getByText("https://github.com")).toBeTruthy();

    fireEvent.press(getByTestId("approval-action-device-cancel"));

    await waitFor(() => expect(onResolve).toHaveBeenCalledWith("approval-1", "dismiss"));
  });

  it("shows every part in plain language, with a checkbox only for what it can grant", async () => {
    const onResolveInstallReview = jest.fn(async () => undefined);
    const { getByText, getByTestId, queryByLabelText } = renderSheet(installReview, {
      onResolveInstallReview,
    });

    expect(getByText("Mobile · Client App")).toBeTruthy();
    fireEvent.press(getByTestId("install-review-group-extensions"));
    expect(getByText("Git Tools · Extension")).toBeTruthy();

    fireEvent.press(getByTestId("install-review-part-apps/mobile@ev-mobile"));
    // The contextual row is a disclosure: its timing line carries the meaning,
    // and there is no control that could promise what this decision cannot give.
    expect(getByText("Asks every time, showing exactly what.")).toBeTruthy();
    expect(queryByLabelText(`Allow ${notificationsRow.action} now`)).toBeNull();

    fireEvent.press(getByTestId("approval-action-accept-install-review"));

    await waitFor(() =>
      expect(onResolveInstallReview).toHaveBeenCalledWith("approval-1", {
        decision: "adopt-root",
        allowNow: [
          { identityKey: "apps/mobile@ev-mobile", permissions: ["account.profile.read\u0000{}"] },
          { identityKey: "extensions/git-tools@ev-extension", permissions: [] },
        ],
      })
    );
  });

  it("renders severe context-boundary approvals with danger-tone trust action", () => {
    const severeBoundary: PendingApproval = {
      ...capability,
      capability: "context.boundary",
      severity: "severe",
      title: "Act on Shell's context",
      resource: { type: "panel", label: "Panel", value: "Shell" },
      details: [{ label: "Owner", value: "Shell" }],
    };

    const { getByTestId, getByText } = renderSheet(severeBoundary);

    expect(getByText("Act on Shell's context")).toBeTruthy();
    expect(
      getByText("This can affect files and running work in a different part of your project.")
    ).toBeTruthy();
    expect(getByTestId("approval-accent-stripe").props.style).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          backgroundColor: "#ff7b72",
        }),
      ])
    );
    expect(getByTestId("approval-category-icon").props.style).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          backgroundColor: "#ff7b72",
        }),
      ])
    );
    expect(getByTestId("approval-action-version").props.accessibilityLabel).toContain(
      "Trust this version"
    );
    expect(getByTestId("approval-action-version").props.style).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          backgroundColor: "#ff7b72",
          borderColor: "#ff7b72",
        }),
      ])
    );
  });

  it("minimizes from backdrop without denying the pending request", async () => {
    const onResolve = jest.fn(async () => undefined);
    const { getByTestId, getByText } = renderSheet(genericApproval, { onResolve });

    fireEvent.press(getByTestId("approval-backdrop"));

    expect(onResolve).not.toHaveBeenCalled();
    expect(getByText("Approval waiting · Review")).toBeTruthy();
  });

  it("replaces sheet content when approval id changes", () => {
    const { getByText, rerender } = renderSheet(capability);
    expect(getByText("Open github.com/foo/...")).toBeTruthy();

    rerender(
      <ApprovalSheet
        approvals={[{ ...credentialInput, approvalId: "approval-2" }]}
        onResolve={jest.fn()}
        onSubmitClientConfig={jest.fn()}
        onSubmitCredentialInput={jest.fn()}
        onSubmitSecretInput={jest.fn()}
        onResolveMissionReview={jest.fn()}
      />
    );
    expect(getByText("Add Acme API")).toBeTruthy();
  });

  it("shows inline error when resolve fails", async () => {
    const onResolve = jest.fn(async () => {
      throw new Error("boom");
    });
    const { getByTestId, getByText } = renderSheet(capability, { onResolve });

    fireEvent.press(getByTestId("approval-action-once"));

    await waitFor(() => expect(getByText("boom")).toBeTruthy());
  });
});
