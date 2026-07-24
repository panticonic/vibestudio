import React from "react";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { ApprovalSheet } from "./ApprovalSheet";
import type { PendingApproval } from "@vibestudio/shared/approvals";
import { authorityRow } from "@vibestudio/shared/authority/authorityRows";

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
    digest: "prepared:briefing-1",
  },
};

const credential: PendingApproval = {
  ...base,
  kind: "credential",
  credentialId: "cred-google",
  credentialLabel: "Google Calendar",
  audience: [{ match: "origin", url: "https://calendar.google.com/" }],
  injection: { type: "header", name: "Authorization", valueTemplate: "Bearer {{token}}" },
  accountIdentity: { email: "me@example.com", providerUserId: "user-1" },
  scopes: ["calendar.readonly"],
  oauthAuthorizeOrigin: "https://accounts.google.com",
  oauthTokenOrigin: "https://oauth2.googleapis.com",
  oauthAudienceDomainMismatch: true,
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

const userland: PendingApproval = {
  ...base,
  kind: "userland",
  subject: { id: "team-x:foo", label: "Foo" },
  title: "Allow foo?",
  summary: "Team X is requesting access to foo.",
  details: [{ label: "Reason", value: "continue work" }],
  promptOptions: "choices",
  options: [
    { value: "allow", label: "Allow", tone: "primary" },
    { value: "deny", label: "Deny", tone: "danger" },
    { value: "later", label: "Later", tone: "neutral" },
  ],
};

const externalAgent: PendingApproval = {
  ...base,
  callerId: "do:workers/linked:LinkedAgentWorker:entity-1",
  callerKind: "do",
  kind: "external-agent",
  entityId: "entity-1",
  capability: "claude-code.tool",
  operationName: "Bash",
  description: "Runs a shell command in the project.",
  preview: "npm install",
  requestId: "req-1",
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

const unitBatch: PendingApproval = {
  ...base,
  callerId: "system:workspace-startup",
  callerKind: "system",
  repoPath: "/projects/foo/meta",
  kind: "unit-batch",
  trigger: "startup",
  title: "Run 2 workspace units",
  description: "Approve workspace apps and extensions declared in config.",
  units: [
    {
      unitKind: "app",
      unitName: "mobile",
      displayName: "Mobile",
      version: "0.1.0",
      target: "react-native",
      source: { kind: "workspace-repo", repo: "apps/mobile", ref: "abc123" },
      ev: "ev-mobile",
      capabilities: ["panel-hosting"],
      authority: {
        requests: [
          {
            capability: "push.send",
            resource: { kind: "prefix", prefix: "" },
            tier: "gated",
            evidence: "intentional-broad",
          },
          {
            capability: "account.profile.read",
            resource: { kind: "prefix", prefix: "" },
            tier: "gated",
            evidence: "intentional-broad",
          },
        ],
        rows: [notificationsRow, accountProfileRow],
        diff: {
          added: [{ ...notificationsRow, flags: { newInDiff: true } }],
          removed: [],
          unchanged: [accountProfileRow],
          retiered: [],
        },
      },
    },
    {
      unitKind: "extension",
      unitName: "git-tools",
      displayName: "Git Tools",
      target: "terminal",
      source: { kind: "workspace-repo", repo: "extensions/git-tools", ref: "def456" },
      ev: "ev-extension",
      capabilities: ["filesystem"],
      provider: {
        name: "provider-a",
        activeEv: "ev-provider",
        activeBuildKey: "build-provider",
        contractVersion: "1",
      },
    },
  ],
};

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
    onResolveUserland: jest.fn(async () => undefined),
    onResolveExternalAgent: jest.fn(async () => undefined),
    onResolveMissionReview: jest.fn(async () => undefined),
    ...overrides,
  };
  const view = render(<ApprovalSheet {...props} />);
  return { ...view, props };
}

describe("ApprovalSheet", () => {
  it.each([
    [capability, "Open github.com/foo/..."],
    [credential, "Connect Google Calendar"],
    [clientConfig, "Set up Google Calendar"],
    [credentialInput, "Add Acme API"],
    [secretInput, "Enter sudo password"],
    [userland, "Allow foo?"],
    [deviceCode, "Sign in to GitHub"],
    [unitBatch, "Start 1 extension and 1 app"],
    [browserPermission, "Allow camera and microphone on https://meet.example.com?"],
  ] as const)("renders %s", (approval, title) => {
    const { getByText } = renderSheet(approval);
    expect(getByText(title)).toBeTruthy();
  });

  it("shows added unit permissions before unchanged permission details", () => {
    const { getByText, getByTestId, queryByText } = renderSheet(unitBatch);
    expect(getByText("New: Publishing & sending (1)")).toBeTruthy();
    expect(queryByText("+ Publishing & sending")).toBeNull();

    fireEvent.press(getByTestId("unit-review-app-mobile"));
    expect(getByText("+ Publishing & sending")).toBeTruthy();
    expect(getByText("send notifications — anything in this workspace")).toBeTruthy();
    expect(queryByText("view your account profile — anything in this workspace")).toBeNull();

    fireEvent.press(getByText("1 unchanged permission"));
    expect(getByText("view your account profile — anything in this workspace")).toBeTruthy();
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
    fireEvent.press(getByTestId("approval-action-agent"));
    await waitFor(() => expect(onResolve).toHaveBeenCalledWith("approval-1", "agent"));
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
        onResolveUserland={jest.fn()}
        onResolveExternalAgent={jest.fn()}
        onResolveMissionReview={jest.fn()}
      />
    );
    expect(queryByText("The sign-in domain differs from the service domain.")).toBeNull();
  });

  it("resolves an external-agent tool prompt and renders its preview", async () => {
    const onResolveExternalAgent = jest.fn(async () => undefined);
    const { getByText, getByTestId } = renderSheet(externalAgent, { onResolveExternalAgent });

    expect(getByText("Bash")).toBeTruthy();
    expect(getByText("npm install")).toBeTruthy();

    fireEvent.press(getByTestId("approval-action-allow"));
    await waitFor(() => expect(onResolveExternalAgent).toHaveBeenCalledWith("approval-1", "allow"));
  });

  it("resolves userland options and renders verified issuer chrome", async () => {
    const onResolveUserland = jest.fn(async () => undefined);
    const { getByText, getByTestId } = renderSheet(userland, { onResolveUserland });

    expect(getByText("worker")).toBeTruthy();
    expect(getByText(/Remembered for worker/)).toBeTruthy();

    fireEvent.press(getByTestId("approval-userland-allow"));
    await waitFor(() => expect(onResolveUserland).toHaveBeenCalledWith("approval-1", "allow"));
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
      kind: "userland",
      subject: { id: "subj-1", label: "Foo" },
      title: "Allow foo?",
      promptOptions: "choices",
      options: [{ value: "allow", label: "Allow", tone: "primary" }],
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
      kind: "userland",
      subject: { id: "s-1" },
      title: "First request",
      promptOptions: "choices",
      options: [{ value: "ok", label: "OK", tone: "primary" }],
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

  it("uses userland tone variants", () => {
    const { getByTestId } = renderSheet(userland);

    expect(getByTestId("approval-userland-allow").props.accessibilityLabel).toContain("Allow");
    expect(getByTestId("approval-userland-deny").props.accessibilityLabel).toContain("Deny");
    expect(getByTestId("approval-userland-later").props.accessibilityLabel).toContain("Later");
  });

  it("renders device-code approvals and lets the user cancel waiting", async () => {
    const onResolve = jest.fn(async () => undefined);
    const { getByText, getByTestId } = renderSheet(deviceCode, { onResolve });

    expect(getByText("ABCD-1234")).toBeTruthy();
    expect(getByText("https://github.com")).toBeTruthy();

    fireEvent.press(getByTestId("approval-action-device-cancel"));

    await waitFor(() => expect(onResolve).toHaveBeenCalledWith("approval-1", "dismiss"));
  });

  it("renders unit-batch approvals as workspace-owned prompts", async () => {
    const onResolve = jest.fn(async () => undefined);
    const { getAllByText, getByText, getByTestId } = renderSheet(unitBatch, { onResolve });

    expect(getByText("Workspace")).toBeTruthy();
    expect(getByText("workspace")).toBeTruthy();
    expect(getByText(/Mobile/)).toBeTruthy();
    expect(getByText("Git Tools")).toBeTruthy();

    fireEvent.press(getByTestId("unit-review-app-mobile"));
    fireEvent.press(getByTestId("unit-review-extension-git-tools"));
    expect(getByText("Mobile")).toBeTruthy();
    expect(getByText("mobile")).toBeTruthy();
    expect(getByText("Terminal")).toBeTruthy();
    expect(getByText("git-tools")).toBeTruthy();
    expect(getAllByText("Host integration")).toHaveLength(2);
    expect(getByText("panel-hosting")).toBeTruthy();

    fireEvent.press(getByTestId("approval-action-once"));

    await waitFor(() => expect(onResolve).toHaveBeenCalledWith("approval-1", "once"));
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

  it("minimizes from backdrop without denying the pending userland request", async () => {
    const onResolveUserland = jest.fn(async () => undefined);
    const { getByTestId, getByText } = renderSheet(userland, { onResolveUserland });

    fireEvent.press(getByTestId("approval-backdrop"));

    expect(onResolveUserland).not.toHaveBeenCalled();
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
        onResolveUserland={jest.fn()}
        onResolveExternalAgent={jest.fn()}
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
