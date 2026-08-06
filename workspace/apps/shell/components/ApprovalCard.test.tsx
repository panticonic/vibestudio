// @vitest-environment jsdom

import { fireEvent, render, screen, within } from "@testing-library/react";
import { Theme } from "@radix-ui/themes";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  PendingCapabilityApproval,
  PendingClientConfigApproval,
  PendingCredentialApproval,
  PendingUnitInstallReviewApproval,
} from "@vibestudio/shared/approvals";
import type {
  InstallReviewPart,
  InstallReviewRow,
} from "@vibestudio/shared/authority/unitInstallReview";
import { authorityRow } from "@vibestudio/shared/authority/authorityRows";
import { installRowHeadline } from "@vibestudio/shared/authority/unitInstallReview";
import { ApprovalCard } from "./ApprovalCard";
import { resolveCallerInfo, type ApprovalCardIntent } from "./approvalCardModel";
import { ApprovalCardSurface } from "../overlay/ApprovalCardSurface";

function capabilityApproval(
  partial: Partial<PendingCapabilityApproval> & { approvalId: string; title: string }
): PendingCapabilityApproval {
  return {
    kind: "capability",
    callerId: partial.callerId ?? `panel:${partial.approvalId}`,
    callerKind: partial.callerKind ?? "panel",
    repoPath: partial.repoPath ?? "panels/test",
    effectiveVersion: partial.effectiveVersion ?? "ev",
    requestedAt: partial.requestedAt ?? Date.now(),
    capability: partial.capability ?? "context.boundary",
    severity: partial.severity,
    title: partial.title,
    description: partial.description,
    resource: partial.resource ?? { type: "panel", label: "Panel", value: "Shell" },
    grantResourceKey: partial.grantResourceKey,
    details: partial.details,
    operation: partial.operation,
    snapshot: partial.snapshot,
    cardType: partial.cardType,
    allowedDecisions: partial.allowedDecisions,
    authorityRow: partial.authorityRow,
    operationSubstance: partial.operationSubstance,
    approvalId: partial.approvalId,
  };
}

/**
 * A review as the server derives it: parts with plain-language rows, each row
 * already carrying its timing, its notability, and whether this decision can
 * grant it at all.
 */
function reviewRow(
  capability: string,
  overrides: Partial<InstallReviewRow> = {}
): InstallReviewRow {
  return {
    kind: "permission",
    key: `${capability}\u0000{}`,
    row: authorityRow({
      capability,
      resource: { kind: "prefix", prefix: "" },
      tier: "gated",
      statement: "declared",
      provenance: { source: "manifest" },
    }),
    timing: "on-add",
    notability: "everyday",
    selectable: true,
    selectedByDefault: true,
    ...overrides,
  } as InstallReviewRow;
}

function installReviewPart(
  overrides: Partial<InstallReviewPart> & { identityKey: string }
): InstallReviewPart {
  return {
    kind: "extension",
    label: "Extension",
    surfaces: [],
    name: "@workspace-extensions/ext",
    title: "Extension 1",
    purpose: "Adds an ability to the host.",
    repoPath: "extensions/ext",
    effectiveVersion: "ev-1",
    version: "0.1.0",
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

function installReviewApproval(
  partial: Partial<PendingUnitInstallReviewApproval> & { approvalId: string }
): PendingUnitInstallReviewApproval {
  const parts = partial.parts ?? [
    installReviewPart({ identityKey: "ext-1" }),
    installReviewPart({
      identityKey: "ext-2",
      title: "Extension 2",
      repoPath: "extensions/ext-2",
    }),
  ];
  return {
    kind: "unit-install-review",
    mode: partial.mode ?? "install",
    callerId: partial.callerId ?? "system:units",
    callerKind: partial.callerKind ?? "system",
    repoPath: partial.repoPath ?? "meta",
    effectiveVersion: partial.effectiveVersion ?? "",
    requestedAt: partial.requestedAt ?? Date.now(),
    title: partial.title ?? "Add News",
    description: partial.description ?? "Read and discuss personalized news briefings.",
    approvalId: partial.approvalId,
    parts,
    summary: partial.summary ?? {
      panels: 0,
      agents: 0,
      services: 0,
      clientApps: 0,
      extensions: parts.length,
    },
    unchangedPartCount: partial.unchangedPartCount ?? 0,
  };
}

function clientConfigApproval(
  partial: Partial<PendingClientConfigApproval> & { approvalId: string; configId: string }
): PendingClientConfigApproval {
  return {
    kind: "client-config",
    callerId: partial.callerId ?? `panel:${partial.approvalId}`,
    callerKind: partial.callerKind ?? "panel",
    repoPath: partial.repoPath ?? "panels/test",
    effectiveVersion: partial.effectiveVersion ?? "ev",
    requestedAt: partial.requestedAt ?? Date.now(),
    approvalId: partial.approvalId,
    configId: partial.configId,
    authorizeUrl: partial.authorizeUrl ?? "https://accounts.example.test/oauth/authorize",
    tokenUrl: partial.tokenUrl ?? "https://accounts.example.test/oauth/token",
    title: partial.title ?? partial.configId,
    description: partial.description,
    fields: partial.fields ?? [
      { name: "clientSecret", label: "Client Secret", type: "secret", required: true },
    ],
  };
}

/**
 * jsdom lays nothing out, so the two-pane decision — which reads the window
 * through `matchMedia` the way the panel chrome does — has to be stated by the
 * test. `wide` is a window at or above the §7.2 threshold; anything else is the
 * collapsed list/detail model.
 */
function stubWindowWidth(wide: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("min-width") ? wide : !wide,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
}

function renderCard(
  approval: Parameters<typeof resolveCallerInfo>[0],
  opts: {
    queue?: Parameters<typeof ApprovalCard>[0]["queue"];
    decisionError?: string | null;
    fetchContent?: Parameters<typeof ApprovalCard>[0]["fetchContent"];
    actionPending?: boolean;
    layout?: Parameters<typeof ApprovalCard>[0]["layout"];
  } = {}
) {
  const emit = vi.fn<(intent: ApprovalCardIntent) => void>();
  const tree = (next: typeof approval) => (
    <Theme>
      <ApprovalCard
        approval={next}
        caller={resolveCallerInfo(next)}
        queue={opts.queue ?? null}
        decisionError={opts.decisionError ?? null}
        fetchContent={opts.fetchContent}
        actionPending={opts.actionPending ?? false}
        layout={opts.layout ?? "card"}
        emit={emit}
      />
    </Theme>
  );
  const { rerender } = render(tree(approval));
  // A pending review can be re-derived by the server while the card is open, so
  // tests need to hand the same card a fresh snapshot the way the shell does.
  return { emit, refresh: (next: typeof approval) => rerender(tree(next)) };
}

describe("ApprovalCard", () => {
  it("exposes a labelled, described dialog and assertive decision errors with long copy", () => {
    const title =
      "Autoriser la publication de cette très longue synthèse dans l’espace de travail partagé";
    const description =
      "Cette action partage le compte rendu complet avec toutes les personnes actuellement présentes.";
    renderCard(
      capabilityApproval({
        approvalId: "localized-long-copy",
        title,
        description,
      }),
      { decisionError: "La décision n’a pas pu être enregistrée." }
    );

    const dialog = screen.getByRole("dialog", { name: title });
    expect(dialog.getAttribute("aria-describedby")).toBe("approval-summary-localized-long-copy");
    expect(screen.getByText(description)).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(
      "La décision n’a pas pu être enregistrée."
    );
  });

  it("renders a severe capability with a danger tone and emits a version decision", () => {
    const { emit } = renderCard(
      capabilityApproval({
        approvalId: "cap-severe",
        title: "Act on Shell's context",
        severity: "severe",
      })
    );
    const card = screen
      .getByText("Act on Shell's context")
      .closest(".approval-card") as HTMLElement;
    expect(card.getAttribute("data-approval-tone")).toBe("red");

    const trustButton = screen.getByText("Trust this version").closest("button");
    expect(trustButton?.getAttribute("data-accent-color")).toBe("red");
    expect(
      screen.getByText("Allow once").closest("button")?.getAttribute("data-accent-color")
    ).toBe("");
    fireEvent.click(trustButton as HTMLButtonElement);
    expect(emit).toHaveBeenCalledWith({
      type: "decide",
      decision: "version",
      approvalId: "cap-severe",
    });
  });

  it("shows the exact prepared effect and the eligible task and agent scope ladder", () => {
    const row = authorityRow({
      capability: "push.send",
      resource: { kind: "exact", key: "channel:briefings" },
      resourcePhrase: "Briefings",
      tier: "gated",
      statement: "prospective",
      provenance: { source: "receiver" },
    });
    const { emit } = renderCard(
      capabilityApproval({
        approvalId: "cap-substance",
        title: "Send the nightly briefing",
        callerTitle: "News",
        snapshot: {
          v: 2,
          service: "push",
          method: "send",
          capability: "push.send",
          capabilityDefinitionDigest: "-",
          resourceType: "publishing",
          provider: "-",
          providerExecutionDigest: "-",
          resourceKey: "channel:briefings",
          argsDigest: "args:briefing-1",
          preparedStateDigest: "prepared:briefing-1",
          callerPrincipal: "code:news",
          sessionId: "session:news",
          taskRef: "task:nightly-briefing",
          agentBindingId: "binding:news",
          agentName: "News",
          agentScopeEligible: true,
          reviewedClosureSubject: "-",
          snippetDigest: "snippet:news",
          codeLineage: { class: "internal", chain: ["code:news"] },
          contextLineage: null,
          initiatorChain: ["user:alice"],
          at: 1,
        },
        authorityRow: row,
        allowedDecisions: ["once", "task", "agent", "deny", "lock"],
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
      })
    );

    expect(screen.getByText("Publishing & sending")).toBeTruthy();
    expect(screen.getByText("What exactly")).toBeTruthy();
    expect(screen.getByText("Send 1 briefing to Briefings")).toBeTruthy();
    expect(screen.getByText("Subject: Overnight workspace summary")).toBeTruthy();
    expect(screen.getByText("Recipient")).toBeTruthy();
    expect(screen.getByText("Briefings")).toBeTruthy();
    expect(screen.getByText("Delivery")).toBeTruthy();
    expect(screen.getByText("Send now")).toBeTruthy();
    fireEvent.click(screen.getByText("Allow for this task"));
    expect(emit).toHaveBeenCalledWith({
      type: "decide",
      decision: "task",
      approvalId: "cap-substance",
    });
    expect(screen.getByText("Always for News")).toBeTruthy();
  });

  it("makes task scope the primary and keyboard-default action when offered", () => {
    const { emit } = renderCard(
      capabilityApproval({
        approvalId: "task-default",
        title: "Manage running workspace services",
        allowedDecisions: ["once", "session", "task", "deny"],
      })
    );

    expect(
      screen.getByText("Allow for this task").closest("button")?.getAttribute("data-accent-color")
    ).toBe("sky");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });
    expect(emit).toHaveBeenCalledWith({
      type: "decide",
      decision: "task",
      approvalId: "task-default",
    });
  });

  it("recommends the durable version grant and uses it for keyboard confirmation", () => {
    const credential = {
      ...capabilityApproval({ approvalId: "credential", title: "Use model credential" }),
      kind: "credential" as const,
      credentialId: "openai-codex",
      credentialLabel: "ChatGPT Codex model credential",
      audience: [{ match: "path-prefix" as const, url: "https://chatgpt.com/backend-api" }],
      injection: {
        type: "header" as const,
        name: "Authorization",
        valueTemplate: "Bearer {{token}}",
      },
      accountIdentity: { providerUserId: "account" },
      scopes: [],
      credentialUse: "fetch" as const,
      allowedDecisions: ["once", "session", "version", "deny"] as const,
    };
    const { emit } = renderCard(credential);

    expect(
      screen.getByText("Trust this version").closest("button")?.getAttribute("data-accent-color")
    ).toBe("sky");
    expect(screen.getByText("Use once").closest("button")?.getAttribute("data-accent-color")).toBe(
      ""
    );

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });
    expect(emit).toHaveBeenCalledWith({
      type: "decide",
      decision: "version",
      approvalId: "credential",
    });
  });

  it("describes extension credential access without unknown-requester sentence fragments", () => {
    const credential: PendingCredentialApproval = {
      ...capabilityApproval({ approvalId: "github-user", title: "Use GitHub account" }),
      kind: "credential",
      callerId: "extension:@workspace-extensions/git-bridge",
      callerKind: "extension",
      repoPath: "extensions/git-bridge",
      credentialId: "github",
      credentialLabel: "GitHub",
      audience: [{ match: "path-prefix", url: "https://api.github.com/user/" }],
      injection: {
        type: "header",
        name: "Authorization",
        valueTemplate: "Bearer {{token}}",
      },
      accountIdentity: { providerUserId: "octocat" },
      scopes: [],
      credentialUse: "fetch",
      allowedDecisions: ["once", "session", "version", "deny"],
      bindingLabel: "GitHub profile and repositories",
      grantResource: {
        bindingId: "github-user",
        resource: "https://api.github.com/user/",
        action: "use",
      },
      requester: {
        id: "extension:@workspace-extensions/git-bridge",
        kind: "extension",
        category: "extension",
        title: "@workspace-extensions/git-bridge",
        repoPath: "extensions/git-bridge",
        effectiveVersion: "ev",
        stableIdentityKey: "ev",
        ephemeralInstanceKey: "extension:@workspace-extensions/git-bridge",
        breadcrumbs: [],
      },
    };

    renderCard(credential);

    expect(screen.getByText("extension")).toBeTruthy();
    expect(screen.getByText("as")).toBeTruthy();
    expect(screen.getAllByText("octocat").length).toBeGreaterThan(0);
    expect(
      screen.getByText(
        "Uses GitHub to access GitHub profile and repositories at api.github.com/user."
      )
    ).toBeTruthy();
    expect(screen.queryByText(/something in your workspace/iu)).toBeNull();
    expect(screen.queryByText("Allow for this task")).toBeNull();
    expect(screen.queryByText(/Always for/iu)).toBeNull();
  });

  it("shows the queue navigator and emits browse intents", () => {
    const { emit } = renderCard(capabilityApproval({ approvalId: "a1", title: "First approval" }), {
      queue: { index: 0, total: 3, canPrev: false, canNext: true },
    });
    expect(screen.getByText("1 / 3")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Next approval"));
    expect(emit).toHaveBeenCalledWith({ type: "browse", dir: "next", approvalId: "a1" });
  });

  it("omits the navigator for a single approval", () => {
    renderCard(capabilityApproval({ approvalId: "solo", title: "Lonely approval" }), {
      queue: null,
    });
    expect(screen.queryByLabelText("Next approval")).toBeNull();
  });

  it("surfaces a decision error", () => {
    renderCard(capabilityApproval({ approvalId: "err", title: "Boom" }), {
      decisionError: "resolve blocked",
    });
    expect(screen.getByText("Approval action failed: resolve blocked")).toBeTruthy();
  });

  it("accepts the complete slate in one click, and cancels without touching anything", () => {
    const { emit } = renderCard(installReviewApproval({ approvalId: "news" }));

    fireEvent.click(screen.getByText("Add template"));
    expect(emit).toHaveBeenCalledWith({
      type: "resolve-install-review",
      approvalId: "news",
      resolution: {
        decision: "install",
        allowNow: [
          { identityKey: "ext-1", permissions: [] },
          { identityKey: "ext-2", permissions: [] },
        ],
      },
    });

    fireEvent.click(screen.getByText("Not now"));
    expect(emit).toHaveBeenCalledWith({
      type: "resolve-install-review",
      approvalId: "news",
      resolution: { decision: "cancel" },
    });
  });

  it("names a lone arriving part and its kind in the action footer", () => {
    renderCard(
      installReviewApproval({
        approvalId: "one-part",
        parts: [
          installReviewPart({
            identityKey: "worker-1",
            kind: "worker",
            label: "Agent",
            title: "Task Board Store",
            repoPath: "workers/task-board-store",
          }),
        ],
      })
    );

    expect(screen.getByText(/Task Board Store · Agent · everything allowed now/u)).toBeTruthy();
  });

  it("offers a checkbox only for what this decision can actually grant", () => {
    const cleared = reviewRow("workspace.files.write");
    const asks = reviewRow("credential.use", {
      timing: "asks-when-needed",
      notability: "headline",
      selectable: false,
      selectedByDefault: false,
    });
    const { emit } = renderCard(
      installReviewApproval({
        approvalId: "selection",
        parts: [
          installReviewPart({
            identityKey: "ext-1",
            notableRows: [asks],
            everydayRows: [cleared],
          }),
        ],
      })
    );

    // Everything clearable is checked by default: one click adds the complete
    // slate with everything allowed.
    fireEvent.click(screen.getByText("Add template"));
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        resolution: {
          decision: "install",
          allowNow: [{ identityKey: "ext-1", permissions: [cleared.key] }],
        },
      })
    );

    // Unchecking the part withholds the grant — the part still arrives.
    fireEvent.click(screen.getByLabelText("Allow Extension 1 now"));
    fireEvent.click(screen.getByText("Add template"));
    expect(emit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        resolution: {
          decision: "install",
          allowNow: [{ identityKey: "ext-1", permissions: [] }],
        },
      })
    );
  });

  it("accepts by keyboard exactly what is on screen, and declines by keyboard", () => {
    const cleared = reviewRow("workspace.files.write");
    const { emit } = renderCard(
      installReviewApproval({
        approvalId: "keys",
        parts: [installReviewPart({ identityKey: "ext-1", everydayRows: [cleared] })],
      })
    );
    const card = screen.getByRole("dialog");

    // Enter reads the live selection, not the default slate: a permission the
    // user unchecked stays unchecked.
    fireEvent.click(screen.getByLabelText("Allow Extension 1 now"));
    fireEvent.keyDown(card, { key: "Enter" });
    expect(emit).toHaveBeenLastCalledWith({
      type: "resolve-install-review",
      approvalId: "keys",
      resolution: { decision: "install", allowNow: [{ identityKey: "ext-1", permissions: [] }] },
    });

    // D is the decline key everywhere else and means the same here. It must
    // never be a second way to install.
    fireEvent.keyDown(card, { key: "d" });
    expect(emit).toHaveBeenLastCalledWith({
      type: "resolve-install-review",
      approvalId: "keys",
      resolution: { decision: "cancel" },
    });
  });

  it("disables the install review's own actions while a decision is in flight", () => {
    renderCard(installReviewApproval({ approvalId: "pending" }), { actionPending: true });
    expect(screen.getByText("Add template").closest("button")?.disabled).toBe(true);
    expect(screen.getByText("Not now").closest("button")?.disabled).toBe(true);
  });

  it("says an upgrade that changes nothing in one line, never as a list", () => {
    renderCard(
      installReviewApproval({
        approvalId: "upgrade",
        mode: "update",
        parts: [],
        unchangedPartCount: 12,
      })
    );
    expect(screen.getByText("Updates 12 parts. No permission changes.")).toBeTruthy();
    expect(screen.queryByText("Extension 1")).toBeNull();
    expect(screen.getByText("Update")).toBeTruthy();
  });

  it("opens a part from the keyboard without swallowing its checkbox or accepting the review", () => {
    const cleared = reviewRow("workspace.files.write");
    const { emit } = renderCard(
      installReviewApproval({
        approvalId: "keyboard-expand",
        parts: [installReviewPart({ identityKey: "ext-1", everydayRows: [cleared] })],
      })
    );

    // The expander is a real button: focusable, Enter/Space activated by the
    // browser itself, and it says what it controls.
    const expander = screen.getByRole("button", { expanded: false });
    expect(expander.tagName).toBe("BUTTON");
    expect(expander.getAttribute("tabindex")).toBeNull();
    const detailId = expander.getAttribute("aria-controls");
    expect(detailId).toBeTruthy();

    // The checkbox is its own control, outside the expander: looking at a part
    // and allowing it are different decisions.
    const checkbox = screen.getByLabelText("Allow Extension 1 now");
    expect(expander.contains(checkbox)).toBe(false);

    fireEvent.click(expander);
    expect(expander.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(detailId as string)).toBeTruthy();

    // Enter on the expander opens the row. It must not also accept the review.
    fireEvent.keyDown(expander, { key: "Enter", bubbles: true });
    expect(emit).not.toHaveBeenCalled();
  });

  it("shows a diff when the review carries changed rows, whatever the mode is called", () => {
    const added = reviewRow("network.fetch", {
      key: "added-{}",
      notability: "headline",
      change: "added",
    });
    const part = installReviewPart({
      identityKey: "ext-1",
      notableRows: [added],
      change: "changed",
    });
    renderCard(
      installReviewApproval({ approvalId: "part-changed", mode: "part-changed", parts: [part] })
    );

    // §7.4 shows a diff line, not a footprint — the change marks are the signal,
    // not the mode string.
    expect(screen.getByText(`+ ${installRowHeadline(added)}`)).toBeTruthy();
  });

  it("distinguishes new, updated, and removed parts in a change review", () => {
    renderCard(
      installReviewApproval({
        approvalId: "mixed-change",
        mode: "part-changed",
        parts: [
          installReviewPart({
            identityKey: "panel-new",
            kind: "panel",
            label: "Panel",
            title: "Task Board",
            change: "added",
          }),
          installReviewPart({
            identityKey: "extension-updated",
            title: "Git Bridge",
            change: "changed",
          }),
          installReviewPart({
            identityKey: "extension-removed",
            title: "Old Bridge",
            change: "removed",
          }),
        ],
      })
    );

    expect(
      screen.getByText("Adds 1 panel · Updates 1 extension · Removes 1 extension")
    ).toBeTruthy();
  });

  it("counts the changes a differential line cannot fit instead of stopping at three", () => {
    const changed = ["a", "b", "c", "d"].map((suffix) =>
      reviewRow(`workspace.files.write`, {
        key: `${suffix}-{}`,
        notability: "headline",
        change: "added",
      })
    );
    renderCard(
      installReviewApproval({
        approvalId: "many-changes",
        mode: "part-changed",
        parts: [
          installReviewPart({ identityKey: "ext-1", notableRows: changed, change: "changed" }),
        ],
      })
    );
    expect(screen.getByText(/·\s\+1 more$/u)).toBeTruthy();
  });

  it("states a part's own surfaces and its dependencies under their own labels", () => {
    const dependency = installReviewPart({
      identityKey: "ext-2",
      name: "@workspace-workers/feeds",
      title: "Feed Service",
    });
    const part = installReviewPart({
      identityKey: "ext-1",
      surfaces: [{ kind: "service", name: "News Feed" }],
      requiredUnitKeys: ["@workspace-workers/feeds"],
    });
    renderCard(installReviewApproval({ approvalId: "shape", parts: [part, dependency] }));

    fireEvent.click(screen.getAllByRole("button", { expanded: false })[0] as HTMLElement);

    // What it hosts and what it needs are opposite facts. The hosted surface must
    // never appear under the "needs" label again.
    expect(
      screen.getByText("What the rest of your workspace can use it for: News Feed")
    ).toBeTruthy();
    expect(
      screen.getByText("What it needs from the rest of your workspace: Feed Service")
    ).toBeTruthy();
  });

  it("keeps the user's choices when the pending review is refreshed underneath the card", () => {
    const cleared = reviewRow("workspace.files.write");
    const kept = () =>
      installReviewPart({
        identityKey: "ext-1",
        everydayRows: [reviewRow("workspace.files.write")],
      });
    const { emit, refresh } = renderCard(
      installReviewApproval({
        approvalId: "refresh",
        parts: [kept(), installReviewPart({ identityKey: "ext-2", title: "Extension 2" })],
      })
    );

    fireEvent.click(screen.getByLabelText("Allow Extension 1 now"));

    // The server re-derives the snapshot: same part by identity, new objects, and
    // one part swapped for another.
    refresh(
      installReviewApproval({
        approvalId: "refresh",
        parts: [kept(), installReviewPart({ identityKey: "ext-3", title: "Extension 3" })],
      })
    );

    fireEvent.click(screen.getByText("Add template"));
    expect(emit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        resolution: {
          decision: "install",
          // The deselection survived, the vanished part is not named at all, and
          // the newly arrived part takes the default slate.
          allowNow: [
            { identityKey: "ext-1", permissions: [] },
            { identityKey: "ext-3", permissions: [] },
          ],
        },
      })
    );
    expect(JSON.stringify(emit.mock.calls)).not.toContain("ext-2");
    expect(cleared.key).toBeTruthy();
  });

  it("says how many parts a filter is hiding, and keeps hiding nothing from the decision", () => {
    const parts = Array.from({ length: 13 }, (_, index) =>
      installReviewPart({
        identityKey: `ext-${index}`,
        title: index === 0 ? "Feed Importer" : `Extension ${index}`,
        kind: index === 0 ? "panel" : "extension",
        label: index === 0 ? "Panel" : "Extension",
        everydayRows: [reviewRow("workspace.files.write")],
      })
    );
    const { emit } = renderCard(installReviewApproval({ approvalId: "filters", parts }));

    fireEvent.change(screen.getByLabelText("Search parts"), { target: { value: "Feed" } });
    expect(screen.getByText(/12 parts hidden by your search/u)).toBeTruthy();
    expect(screen.getByText(/12 still allowed now/u)).toBeTruthy();

    // The kind filter is the other half of §7.2, on the same threshold.
    fireEvent.change(screen.getByLabelText("Search parts"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Filter by kind"), { target: { value: "Panel" } });
    expect(screen.getByText("Feed Importer")).toBeTruthy();
    expect(screen.queryByText("Extension 5")).toBeNull();
    expect(screen.getByText(/12 parts hidden by your search/u)).toBeTruthy();

    // Hiding is not withholding: every part is still in the acceptance.
    fireEvent.click(screen.getByText("Add template"));
    const intent = emit.mock.calls[0]?.[0] as {
      resolution: { allowNow: Array<{ identityKey: string }> };
    };
    expect(intent.resolution.allowNow).toHaveLength(13);
  });

  it("groups the initial workspace by its useful directories and folds quiet groups", () => {
    const notable = reviewRow("network.fetch", { notability: "headline" });
    const parts = [
      installReviewPart({
        identityKey: "app-panel",
        kind: "panel",
        label: "Panel",
        repoPath: "panels/chat",
        title: "Chat",
        notableRows: [notable],
      }),
      installReviewPart({
        identityKey: "agent",
        kind: "worker",
        label: "Agent",
        repoPath: "workers/researcher",
        title: "Researcher",
        notableRows: [notable],
      }),
      installReviewPart({
        identityKey: "system-panel",
        kind: "panel",
        label: "Panel",
        repoPath: "about/accounts",
        title: "Accounts",
        purpose: "Manage workspace accounts.",
      }),
      installReviewPart({
        identityKey: "service",
        kind: "worker",
        label: "Service",
        repoPath: "workers/pubsub",
        title: "Pubsub",
        purpose: "Connect workspace conversations.",
      }),
    ];
    renderCard(
      installReviewApproval({ approvalId: "grouped-workspace", mode: "adopt-root", parts })
    );

    const headings = [
      screen.getByRole("button", { name: /^App panels/u }),
      screen.getByRole("button", { name: /^Agents and background tasks/u }),
      screen.getByRole("button", { name: /^System panels/u }),
      screen.getByRole("button", { name: /^Services/u }),
    ];
    expect(
      [...document.querySelectorAll(".install-review-group-toggle")].map((button) =>
        button.textContent?.trim()
      )
    ).toEqual(headings.map((button) => button.textContent?.trim()));
    expect(headings.map((heading) => heading.getAttribute("aria-expanded"))).toEqual([
      "true",
      "true",
      "false",
      "false",
    ]);
    expect(
      [...document.querySelectorAll(".install-review-group-count")].every((count) =>
        count.parentElement?.classList.contains("install-review-group-title")
      )
    ).toBe(true);

    // A folded heading still tells the reviewer what is inside and why it was
    // folded; opening it reveals the ordinary part without changing selection.
    expect(headings[2]?.textContent).toContain("Accounts");
    expect(headings[2]?.textContent).toContain("nothing unusual");
    expect(screen.queryByText("Manage workspace accounts.")).toBeNull();
    fireEvent.click(headings[2] as HTMLElement);
    expect(screen.getByText("Manage workspace accounts.")).toBeTruthy();
  });

  it("leaves every category open when nothing in the workspace is notable", () => {
    renderCard(
      installReviewApproval({
        approvalId: "routine-workspace",
        mode: "adopt-root",
        parts: [
          installReviewPart({
            identityKey: "panel",
            kind: "panel",
            label: "Panel",
            repoPath: "panels/chat",
            title: "Chat",
          }),
          installReviewPart({
            identityKey: "about",
            kind: "panel",
            label: "Panel",
            repoPath: "about/accounts",
            title: "Accounts",
          }),
        ],
      })
    );

    expect(
      [...document.querySelectorAll(".install-review-group-toggle")].map((heading) =>
        heading.getAttribute("aria-expanded")
      )
    ).toEqual(["true", "true"]);
  });

  it("restores the rows a user had opted into when they re-check a part", () => {
    const byDefault = reviewRow("workspace.files.write", { key: "default-{}" });
    const optIn = reviewRow("network.fetch", {
      key: "opt-in-{}",
      selectedByDefault: false,
    });
    const { emit } = renderCard(
      installReviewApproval({
        approvalId: "memory",
        parts: [installReviewPart({ identityKey: "ext-1", everydayRows: [byDefault, optIn] })],
      })
    );

    fireEvent.click(screen.getAllByRole("button", { expanded: false })[0] as HTMLElement);
    fireEvent.click(screen.getByText("Plus 2 everyday permissions"));
    fireEvent.click(screen.getByLabelText(`Allow ${installRowHeadline(optIn)} now`));
    fireEvent.click(screen.getByLabelText("Allow Extension 1 now"));
    fireEvent.click(screen.getByLabelText("Allow Extension 1 now"));
    fireEvent.click(screen.getByText("Add template"));

    expect(emit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        resolution: {
          decision: "install",
          allowNow: [{ identityKey: "ext-1", permissions: [byDefault.key, optIn.key] }],
        },
      })
    );
  });

  it("says what did not happen when an install is refused, in the review's own words", () => {
    renderCard(installReviewApproval({ approvalId: "failed" }), {
      decisionError: "unit extensions/ext is not in this review",
    });
    expect(screen.getByText("Couldn't add these parts")).toBeTruthy();
    expect(screen.getByText("unit extensions/ext is not in this review")).toBeTruthy();
    expect(screen.getByText(/Your selection is still here/u)).toBeTruthy();
    expect(screen.queryByText(/Approval action failed/u)).toBeNull();
  });

  /**
   * The full surface (§7.2, §7.8). The card mode above is the same review in the
   * floating overlay; these are the things only the dialog does.
   */
  describe("in the full-surface dialog", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    /** Two parts, each with one thing this decision can actually grant. */
    const pairedParts = () => {
      const first = reviewRow("workspace.files.write", { key: "row-one-{}" });
      const second = reviewRow("network.fetch", { key: "row-two-{}" });
      return {
        first,
        second,
        parts: [
          installReviewPart({ identityKey: "ext-1", everydayRows: [first] }),
          installReviewPart({
            identityKey: "ext-2",
            title: "Extension 2",
            everydayRows: [second],
          }),
        ],
      };
    };

    it("stands the detail pane beside the list on a wide window", () => {
      stubWindowWidth(true);
      renderCard(installReviewApproval({ approvalId: "wide" }), { layout: "dialog" });

      // The pane is a labelled region, open on the first part without anyone
      // asking: a two-pane review whose second pane starts empty is one pane.
      const pane = screen.getByRole("region", { name: "Extension 1" });
      expect(within(pane).getByText(/Version 0\.1\.0/u)).toBeTruthy();

      // And the list is still whole beside it — the pane is not a level the user
      // navigated INTO, it is a sibling of the list they are reading.
      expect(screen.getByText("Extension 2")).toBeTruthy();
      // The selected row drives the pane and says so; it is not a disclosure.
      const row = screen.getByRole("button", { current: true });
      expect(row.getAttribute("aria-controls")).toBe(pane.id);
      expect(row.getAttribute("aria-expanded")).toBeNull();
    });

    it("collapses to the list/detail model in place below the threshold", () => {
      stubWindowWidth(false);
      renderCard(installReviewApproval({ approvalId: "narrow" }), { layout: "dialog" });

      // No second column at this size — and no clipped one either. The row is a
      // disclosure again and its detail opens under it, one scroll, one column.
      expect(screen.queryByRole("region", { name: "Extension 1" })).toBeNull();
      const expander = screen.getAllByRole("button", { expanded: false })[0] as HTMLElement;
      fireEvent.click(expander);
      expect(expander.getAttribute("aria-expanded")).toBe("true");
      expect(
        document.getElementById(expander.getAttribute("aria-controls") as string)
      ).toBeTruthy();
    });

    it("keeps what each part had checked while the pane moves between parts", () => {
      stubWindowWidth(true);
      const { first, second, parts } = pairedParts();
      const { emit } = renderCard(installReviewApproval({ approvalId: "switch", parts }), {
        layout: "dialog",
      });

      // Withhold one row of the first part, in the pane.
      fireEvent.click(screen.getByText("Plus 1 everyday permission"));
      fireEvent.click(screen.getByLabelText(`Allow ${installRowHeadline(first)} now`));

      // Read the second part, then come back. Moving the pane is looking, never
      // deciding: what was unchecked is still unchecked on return.
      fireEvent.click(screen.getByText("Extension 2"));
      expect(screen.getByRole("region", { name: "Extension 2" })).toBeTruthy();
      fireEvent.click(screen.getByText("Extension 1"));
      expect(screen.getByRole("region", { name: "Extension 1" })).toBeTruthy();
      fireEvent.click(screen.getByText("Plus 1 everyday permission"));
      expect(
        (
          screen.getByLabelText(`Allow ${installRowHeadline(first)} now`) as HTMLElement
        ).getAttribute("aria-checked")
      ).toBe("false");

      fireEvent.click(screen.getByText("Add template"));
      expect(emit).toHaveBeenLastCalledWith(
        expect.objectContaining({
          resolution: {
            decision: "install",
            allowNow: [
              { identityKey: "ext-1", permissions: [] },
              { identityKey: "ext-2", permissions: [second.key] },
            ],
          },
        })
      );
    });

    it("walks the list from the keyboard and takes the pane with it", () => {
      stubWindowWidth(true);
      const { parts } = pairedParts();
      renderCard(installReviewApproval({ approvalId: "keys-two-pane", parts }), {
        layout: "dialog",
      });

      const rows = [...document.querySelectorAll<HTMLButtonElement>("button[data-part-row]")];
      expect(rows).toHaveLength(2);
      // Only the current row is a tab stop, so one Tab out of a fifty-three part
      // list lands in the detail pane rather than in part two.
      expect(rows[0]?.tabIndex).toBe(0);
      expect(rows[1]?.tabIndex).toBe(-1);

      rows[0]?.focus();
      fireEvent.keyDown(rows[0] as HTMLElement, { key: "ArrowDown", bubbles: true });
      expect(screen.getByRole("region", { name: "Extension 2" })).toBeTruthy();
      expect(document.activeElement).toBe(rows[1]);

      fireEvent.keyDown(rows[1] as HTMLElement, { key: "ArrowUp", bubbles: true });
      expect(screen.getByRole("region", { name: "Extension 1" })).toBeTruthy();
    });

    it("keeps the card's own keyboard contract inside the dialog", () => {
      stubWindowWidth(true);
      const { emit } = renderCard(installReviewApproval({ approvalId: "shortcuts" }), {
        layout: "dialog",
      });
      const card = document.querySelector("[data-approval-card]") as HTMLElement;
      // The surrounding dialog owns `role="dialog"`; the card does not announce a
      // second one, but it still owns Enter and D.
      expect(card.getAttribute("role")).toBe("group");

      fireEvent.keyDown(card, { key: "Enter" });
      expect(emit).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: "resolve-install-review" })
      );
      fireEvent.keyDown(card, { key: "d" });
      expect(emit).toHaveBeenLastCalledWith(
        expect.objectContaining({ resolution: { decision: "cancel" } })
      );
    });

    it("still opens a floating card for every other kind of approval", () => {
      stubWindowWidth(true);
      renderCard(capabilityApproval({ approvalId: "plain", title: "Open a URL" }));
      expect(screen.getByRole("dialog")).toBeTruthy();
      expect(screen.queryByRole("region", { name: "Extension 1" })).toBeNull();
    });
  });

  it("emits a minimize intent from the header control", () => {
    const { emit } = renderCard(capabilityApproval({ approvalId: "m", title: "Minimizable" }));
    fireEvent.click(screen.getByLabelText("Minimize approval"));
    expect(emit).toHaveBeenCalledWith({ type: "minimize", approvalId: "m" });
  });

  it("remounts the overlay card when the approval changes so secret inputs reset", () => {
    const first = clientConfigApproval({ approvalId: "setup-a", configId: "service-a" });
    const second = clientConfigApproval({ approvalId: "setup-b", configId: "service-b" });
    const emitIntent = vi.fn<(intent: unknown) => void>();
    const { rerender } = render(
      <Theme>
        <ApprovalCardSurface
          props={{ approval: first, queue: null, decisionError: null }}
          emitIntent={emitIntent}
        />
      </Theme>
    );

    const firstInput = screen.getByPlaceholderText("Client Secret") as HTMLInputElement;
    fireEvent.change(firstInput, { target: { value: "first-secret" } });
    expect(firstInput.value).toBe("first-secret");

    rerender(
      <Theme>
        <ApprovalCardSurface
          props={{ approval: second, queue: null, decisionError: null }}
          emitIntent={emitIntent}
        />
      </Theme>
    );

    expect((screen.getByPlaceholderText("Client Secret") as HTMLInputElement).value).toBe("");
  });
});
