// @vitest-environment jsdom

import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Theme } from "@radix-ui/themes";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PendingCapabilityApproval,
  PendingUnitInstallReviewApproval,
} from "@vibestudio/shared/approvals";
import type { ApprovalCardIntent } from "./approvalCardModel";

type ListPendingFn = () => Promise<unknown[]>;
type GetTreePageFn = () => Promise<{
  revision: number;
  nodes: Array<{ slotId: string }>;
  nextCursor: string | null;
}>;
const shellClient = vi.hoisted(() => ({
  heartbeat: vi.fn(() => Promise.resolve()),
  listPending: vi.fn<ListPendingFn>(() => Promise.resolve([])),
  resolve: vi.fn(() => Promise.resolve()),
  submitClientConfig: vi.fn(() => Promise.resolve()),
  submitCredentialInput: vi.fn(() => Promise.resolve()),
  resolveInstallReview: vi.fn(() => Promise.resolve()),
  subscribe: vi.fn(() => Promise.resolve()),
  unsubscribe: vi.fn(() => Promise.resolve()),
  onEvent: vi.fn((_event: string, _listener: (payload: unknown) => void) => () => {}),
  getText: vi.fn<(hash: string) => Promise<string | null>>(() => Promise.resolve("blob-text")),
  getProfile: vi.fn(() =>
    Promise.resolve({ userId: "alice", handle: "alice", displayName: "Alice", role: "member" })
  ),
  getTreePage: vi.fn<GetTreePageFn>(() =>
    Promise.resolve({ revision: 1, nodes: [], nextCursor: null })
  ),
  observe: vi.fn((slotId: string) =>
    Promise.resolve({ slotId, source: slotId === "gadb" ? "panels/gad-browser" : "panels/chat" })
  ),
  navigate: vi.fn(() => Promise.resolve(null)),
  createPanel: vi.fn(() => Promise.resolve(null)),
  navigateToId: vi.fn(),
}));

// Capture what the coordinator drives the content overlay with, and the intent
// callback, so tests can assert props and simulate the card emitting intents.
const overlay = vi.hoisted(() => ({
  options: null as {
    open?: boolean;
    props?: { approval?: { approvalId?: string }; queue?: unknown; decisionError?: unknown };
  } | null,
  onIntent: null as ((payload: unknown) => void) | null,
}));

vi.mock("../shell/client", () => ({
  shellApproval: {
    listPending: shellClient.listPending,
    resolve: shellClient.resolve,
    submitClientConfig: shellClient.submitClientConfig,
    submitCredentialInput: shellClient.submitCredentialInput,
    resolveInstallReview: shellClient.resolveInstallReview,
  },
  shellPresence: { heartbeat: shellClient.heartbeat },
  events: {
    subscribe: shellClient.subscribe,
    unsubscribe: shellClient.unsubscribe,
    on: shellClient.onEvent,
  },
  blobstore: { getText: shellClient.getText },
  account: { getProfile: shellClient.getProfile },
  panel: {
    getTreePage: shellClient.getTreePage,
    observe: shellClient.observe,
    navigate: shellClient.navigate,
    createPanel: shellClient.createPanel,
  },
}));

vi.mock("../shell/useShellContentOverlay", () => ({
  useShellContentOverlay: (options: unknown, onIntent: (payload: unknown) => void) => {
    overlay.options = options as typeof overlay.options;
    overlay.onIntent = onIntent;
  },
}));

vi.mock("../state/themeAtoms", async () => {
  const { atom } = await import("jotai");
  return {
    effectiveThemeAtom: atom("light"),
    themeConfigAtom: atom({
      accentColor: "amber",
      grayColor: "slate",
      radius: "medium",
      scaling: "100%",
      panelBackground: "translucent",
    }),
  };
});

vi.mock("./NavigationContext", () => ({
  useNavigationActions: () => ({ navigateToId: shellClient.navigateToId }),
}));

/**
 * The full surface stands in for its Radix dialog here.
 *
 * Not because it cannot be mounted — it can, and ApprovalFullSurface.test.tsx
 * mounts it for real, dialog and all. It stands in because what the coordinator
 * owes is the *routing*: which approvals go to the full surface, which keep the
 * floating card, what happens when one closes without deciding, and what it does
 * with the resolution the server hands back. The stub records exactly the props
 * and callbacks that traffic runs through, and asserting on them beats digging
 * the same values back out of a rendered dialog.
 *
 * Everything the stub stands in for is covered against the real thing elsewhere:
 * the dialog, its focus behaviour and its Escape handling in
 * ApprovalFullSurface.test.tsx, and the card inside it — layout, panes,
 * keyboard, selection — in ApprovalCard.test.tsx.
 */
const fullSurface = vi.hoisted(() => ({
  props: null as {
    approval?: { approvalId?: string };
    actionPending?: boolean;
    decisionError?: string | null;
    emit?: (intent: unknown) => void;
    onClose?: () => void;
  } | null,
}));
vi.mock("./ApprovalFullSurface", () => ({
  ApprovalFullSurface: (props: { approval: { approvalId: string }; onClose: () => void }) => {
    fullSurface.props = props;
    return React.createElement("div", { "data-testid": "full-surface" }, props.approval.approvalId);
  },
}));

import { ConsentApprovalBar } from "./ConsentApprovalBar";

function emit(intent: ApprovalCardIntent): void {
  act(() => {
    overlay.onIntent?.(intent);
  });
}

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
    attention: partial.attention,
    callerTitle: partial.callerTitle,
    capability: partial.capability ?? "context.boundary",
    title: partial.title,
    description: partial.description,
    resource: partial.resource,
    details: partial.details,
    diffReview: partial.diffReview,
    lifecycle: partial.lifecycle,
    approvalId: partial.approvalId,
  };
}

function hostAppStartupApproval(approvalId: string): PendingUnitInstallReviewApproval {
  return {
    kind: "unit-install-review",
    mode: "adopt-root",
    callerId: "system:units",
    callerKind: "system",
    repoPath: "meta",
    effectiveVersion: "",
    requestedAt: Date.now(),
    title: "Start this workspace?",
    description: "Vibestudio needs to run 1 program on this computer.",
    approvalId,
    parts: [
      {
        identityKey: "apps/shell@ev-shell",
        kind: "app",
        label: "Client App",
        surfaces: [],
        name: "@workspace-apps/shell",
        title: "Shell",
        purpose: "The desktop app itself.",
        repoPath: "apps/shell",
        effectiveVersion: "ev-shell",
        version: null,
        requiredUnitKeys: [],
        runsInBackground: false,
        target: "electron",
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
    summary: { panels: 0, agents: 0, services: 0, clientApps: 1, extensions: 0 },
    unchangedPartCount: 0,
  };
}

/**
 * A review of ordinary workspace parts — panels, not client apps, so the launch
 * gate does not own it and it lands in this queue like any other approval.
 */
function installReviewApproval(approvalId: string): PendingUnitInstallReviewApproval {
  return {
    ...hostAppStartupApproval(approvalId),
    mode: "install",
    title: "Add News",
    description: "Read and discuss personalized news briefings.",
    parts: [
      {
        ...(hostAppStartupApproval(approvalId)
          .parts[0] as PendingUnitInstallReviewApproval["parts"][number]),
        identityKey: "panels/news@ev-news",
        kind: "panel",
        label: "Panel",
        name: "@workspace-panels/news",
        title: "News",
        purpose: "Reads your feeds and shows briefings.",
        repoPath: "panels/news",
      },
    ],
    summary: { panels: 1, agents: 0, services: 0, clientApps: 0, extensions: 0 },
  };
}

function mountBar() {
  // jsdom doesn't lay out, so stub the anchor host's rect to a real size — the
  // coordinator only opens the overlay once it has a non-empty anchor.
  const host = document.createElement("div");
  host.id = "app-approval-host";
  host.getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 800,
      bottom: 600,
      width: 800,
      height: 600,
      toJSON() {},
    }) as DOMRect;
  document.body.appendChild(host);
  return render(
    <Theme>
      <ConsentApprovalBar />
    </Theme>
  );
}

describe("ConsentApprovalBar coordinator", () => {
  beforeEach(() => {
    overlay.options = null;
    overlay.onIntent = null;
    for (const fn of Object.values(shellClient)) fn.mockClear();
    shellClient.listPending.mockResolvedValue([]);
    shellClient.resolve.mockImplementation(() => Promise.resolve());
    shellClient.getText.mockResolvedValue("blob-text");
    shellClient.getProfile.mockResolvedValue({
      userId: "alice",
      handle: "alice",
      displayName: "Alice",
      role: "member",
    });
  });

  afterEach(() => {
    document.getElementById("app-approval-host")?.remove();
  });

  it("sends a heartbeat and lists pending while mounted", async () => {
    vi.useFakeTimers();
    try {
      render(React.createElement(ConsentApprovalBar));
      expect(shellClient.heartbeat).toHaveBeenCalledTimes(1);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(shellClient.listPending).toHaveBeenCalledTimes(1);
      await act(async () => {
        vi.advanceTimersByTime(5_000);
      });
      expect(shellClient.heartbeat).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drives the overlay with the active approval and queue length", async () => {
    shellClient.listPending.mockResolvedValueOnce([
      capabilityApproval({ approvalId: "a1", title: "First" }),
      capabilityApproval({ approvalId: "a2", title: "Second" }),
      capabilityApproval({ approvalId: "a3", title: "Third" }),
    ]);
    mountBar();
    await waitFor(() => {
      expect(overlay.options?.open).toBe(true);
      expect(overlay.options?.props?.approval?.approvalId).toBe("a1");
    });
    expect((overlay.options?.props?.queue as { total: number }).total).toBe(3);
  });

  it("excludes host-app startup approvals from the runtime overlay", async () => {
    shellClient.listPending.mockResolvedValueOnce([
      hostAppStartupApproval("app-startup"),
      capabilityApproval({ approvalId: "runtime", title: "Runtime approval" }),
    ]);
    mountBar();
    await waitFor(() => {
      expect(overlay.options?.props?.approval?.approvalId).toBe("runtime");
    });
    // Only one runtime approval remains → no queue navigator.
    expect(overlay.options?.props?.queue).toBeNull();
  });

  it("minimizes to a pill on a minimize intent and reopens on click", async () => {
    shellClient.listPending.mockResolvedValueOnce([
      capabilityApproval({ approvalId: "solo", title: "Lonely", callerTitle: "Chat A" }),
    ]);
    mountBar();
    await waitFor(() => expect(overlay.options?.open).toBe(true));

    emit({ type: "minimize", approvalId: "solo" });
    const pill = await screen.findByRole("button", { name: "Review approval: Lonely" });
    expect(pill).toBeTruthy();
    expect(overlay.options).toBeNull();

    fireEvent.click(pill);
    await waitFor(() => expect(overlay.options?.open).toBe(true));
    expect(screen.queryByRole("button", { name: "Review approval: Lonely" })).toBeNull();
  });

  it("keeps queued attention in the pill until the user chooses to review it", async () => {
    shellClient.listPending.mockResolvedValueOnce([
      capabilityApproval({
        approvalId: "queued",
        title: "Queued approval",
        callerTitle: "Chat A",
        attention: "queue",
      }),
    ]);
    mountBar();

    const pill = await screen.findByRole("button", { name: "Review approval: Queued approval" });
    expect(overlay.options).toBeNull();
    fireEvent.click(pill);
    await waitFor(() => expect(overlay.options?.props?.approval?.approvalId).toBe("queued"));
  });

  it("keeps publication preparation non-blocking until its review is ready", async () => {
    shellClient.listPending.mockResolvedValueOnce([
      capabilityApproval({
        approvalId: "preparing",
        title: "Preparing workspace update…",
        attention: "queue",
        lifecycle: { state: "preparing" },
      }),
    ]);
    mountBar();

    await screen.findByRole("button", { name: "Review approval: Preparing workspace update…" });
    expect(overlay.options).toBeNull();
  });

  it("shows an interrupting approval ahead of earlier queued attention", async () => {
    shellClient.listPending.mockResolvedValueOnce([
      capabilityApproval({ approvalId: "queued", title: "Queued", attention: "queue" }),
      capabilityApproval({ approvalId: "interrupt", title: "Interrupt", attention: "interrupt" }),
    ]);
    mountBar();
    await waitFor(() => {
      expect(overlay.options?.props?.approval?.approvalId).toBe("interrupt");
    });
  });

  it("keeps an active review open when the next approval was queued", async () => {
    shellClient.resolve.mockImplementation(() => new Promise(() => undefined));
    shellClient.listPending.mockResolvedValueOnce([
      capabilityApproval({
        approvalId: "queued",
        title: "Queued",
        callerId: "extension:publisher",
        attention: "queue",
      }),
      capabilityApproval({
        approvalId: "interrupt",
        title: "Interrupt",
        callerId: "extension:publisher",
        attention: "interrupt",
      }),
    ]);
    mountBar();
    await waitFor(() => {
      expect(overlay.options?.props?.approval?.approvalId).toBe("interrupt");
    });

    emit({ type: "decide", decision: "once", approvalId: "interrupt" });

    await waitFor(() => {
      expect(overlay.options?.open).toBe(true);
      expect(overlay.options?.props?.approval?.approvalId).toBe("queued");
    });
    expect(screen.queryByRole("button", { name: "Review approval: Queued" })).toBeNull();
  });

  it("minimizes queued preparation from a different requester after an interrupt resolves", async () => {
    shellClient.resolve.mockImplementation(() => new Promise(() => undefined));
    shellClient.listPending.mockResolvedValueOnce([
      capabilityApproval({
        approvalId: "preparing-template",
        title: "Update meta main",
        callerId: "@workspace-extensions/template-composer",
        attention: "queue",
        lifecycle: { state: "preparing" },
      }),
      capabilityApproval({
        approvalId: "conversation-permission",
        title: "Join this conversation",
        callerId: "do:workers/pubsub-channel:chat",
        attention: "interrupt",
      }),
    ]);
    mountBar();
    await waitFor(() => {
      expect(overlay.options?.props?.approval?.approvalId).toBe("conversation-permission");
    });

    emit({ type: "decide", decision: "once", approvalId: "conversation-permission" });

    await screen.findByRole("button", { name: "Review approval: Update meta main" });
    expect(overlay.options).toBeNull();
  });

  it("resolves and removes an approval on a decide intent", async () => {
    shellClient.resolve.mockImplementation(() => new Promise(() => undefined));
    shellClient.listPending.mockResolvedValueOnce([
      capabilityApproval({ approvalId: "solo", title: "Lonely" }),
    ]);
    mountBar();
    await waitFor(() => expect(overlay.options?.open).toBe(true));

    emit({ type: "decide", decision: "once", approvalId: "solo" });
    expect(shellClient.resolve).toHaveBeenCalledWith("solo", "once");
    await waitFor(() => expect(overlay.options).toBeNull());
  });

  it("ignores stale overlay intents for a previously rendered approval", async () => {
    shellClient.listPending.mockResolvedValueOnce([
      capabilityApproval({ approvalId: "current", title: "Current" }),
    ]);
    mountBar();
    await waitFor(() => expect(overlay.options?.open).toBe(true));

    emit({ type: "decide", decision: "once", approvalId: "stale" });

    expect(shellClient.resolve).not.toHaveBeenCalled();
    expect(overlay.options?.props?.approval?.approvalId).toBe("current");
  });

  function diffApproval(approvalId: string): PendingCapabilityApproval & { diffReview: unknown } {
    return {
      ...capabilityApproval({ approvalId, title: "Publish changes" }),
      diffReview: [
        {
          repoPath: "packages/demo",
          oldState: "state:a",
          newState: "state:b",
          diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
          changedFiles: [{ path: "src/a.ts", kind: "changed", oldHash: "h-old", newHash: "h-new" }],
        },
      ],
    };
  }

  it("passes the diff-review payload and appearance through to the overlay", async () => {
    shellClient.listPending.mockResolvedValueOnce([diffApproval("d1")]);
    mountBar();
    await waitFor(() => expect(overlay.options?.open).toBe(true));
    const props = overlay.options?.props as {
      diffReview?: unknown[];
      appearance?: string;
      blobResults?: unknown;
    };
    expect(Array.isArray(props.diffReview)).toBe(true);
    expect(props.appearance).toBe("light");
    expect(props.blobResults).toEqual({});
  });

  it("renders as today (no diffReview) when the approval carries no diff payload", async () => {
    shellClient.listPending.mockResolvedValueOnce([
      capabilityApproval({ approvalId: "plain", title: "Plain" }),
    ]);
    mountBar();
    await waitFor(() => expect(overlay.options?.open).toBe(true));
    const props = overlay.options?.props as { diffReview?: unknown };
    expect(props.diffReview ?? null).toBeNull();
  });

  it("fetches only payload hashes on a fetch-blob intent and pushes the result down", async () => {
    shellClient.listPending.mockResolvedValueOnce([diffApproval("d1")]);
    mountBar();
    await waitFor(() => expect(overlay.options?.open).toBe(true));

    emit({ type: "fetch-blob", hash: "h-new", approvalId: "d1" } as unknown as ApprovalCardIntent);
    await waitFor(() => {
      expect(shellClient.getText).toHaveBeenCalledWith("h-new");
      const props = overlay.options?.props as { blobResults?: Record<string, unknown> };
      expect(props.blobResults?.["h-new"]).toEqual({ text: "blob-text" });
    });

    // A hash NOT present in the payload is ignored (never fetched).
    emit({
      type: "fetch-blob",
      hash: "not-in-payload",
      approvalId: "d1",
    } as unknown as ApprovalCardIntent);
    await Promise.resolve();
    expect(shellClient.getText).not.toHaveBeenCalledWith("not-in-payload");
  });

  it("refreshes failed payloads on retry while retaining successful immutable content", async () => {
    shellClient.listPending.mockResolvedValueOnce([diffApproval("retry")]);
    shellClient.getText
      .mockRejectedValueOnce(new Error("temporary connection loss"))
      .mockResolvedValueOnce("recovered content");
    mountBar();
    await waitFor(() => expect(overlay.options?.open).toBe(true));

    emit({ type: "fetch-blob", hash: "h-new", approvalId: "retry" });
    await waitFor(() => {
      const props = overlay.options?.props as {
        blobResults?: Record<string, unknown>;
      };
      expect(props.blobResults?.["h-new"]).toEqual({ error: "temporary connection loss" });
    });

    emit({ type: "fetch-blob", hash: "h-new", approvalId: "retry", refresh: true });
    await waitFor(() => {
      expect(shellClient.getText).toHaveBeenCalledTimes(2);
      const props = overlay.options?.props as {
        blobResults?: Record<string, unknown>;
      };
      expect(props.blobResults?.["h-new"]).toEqual({ text: "recovered content" });
    });

    emit({ type: "fetch-blob", hash: "h-new", approvalId: "retry", refresh: true });
    await Promise.resolve();
    expect(shellClient.getText).toHaveBeenCalledTimes(2);
  });

  const gadTarget = {
    repoPath: "packages/demo",
    path: "logo.png",
    oldHash: "h-old",
    newHash: "h-new",
    oldState: "state:a",
    newState: "state:b",
  };

  it("creates a gad-browser panel with the target on an open-in-gad-browser intent", async () => {
    shellClient.getTreePage.mockResolvedValueOnce({ revision: 1, nodes: [], nextCursor: null });
    shellClient.listPending.mockResolvedValueOnce([diffApproval("d1")]);
    mountBar();
    await waitFor(() => expect(overlay.options?.open).toBe(true));

    emit({
      type: "open-in-gad-browser",
      target: gadTarget,
      approvalId: "d1",
    } as unknown as ApprovalCardIntent);

    await waitFor(() => {
      expect(shellClient.createPanel).toHaveBeenCalledWith("panels/gad-browser", {
        stateArgs: { diffTarget: gadTarget },
      });
    });
    expect(shellClient.navigate).not.toHaveBeenCalled();
  });

  it("reuses and focuses an existing gad-browser panel instead of creating one", async () => {
    shellClient.getTreePage.mockResolvedValueOnce({
      revision: 1,
      nodes: [{ slotId: "other" }, { slotId: "gadb" }],
      nextCursor: null,
    });
    shellClient.listPending.mockResolvedValueOnce([diffApproval("d1")]);
    mountBar();
    await waitFor(() => expect(overlay.options?.open).toBe(true));

    emit({
      type: "open-in-gad-browser",
      target: gadTarget,
      approvalId: "d1",
    } as unknown as ApprovalCardIntent);

    await waitFor(() => {
      expect(shellClient.navigate).toHaveBeenCalledWith("gadb", "panels/gad-browser", {
        stateArgs: { diffTarget: gadTarget },
      });
      expect(shellClient.navigateToId).toHaveBeenCalledWith("gadb");
    });
    expect(shellClient.createPanel).not.toHaveBeenCalled();
  });

  it("does not navigate another owner's gad-browser panel", async () => {
    shellClient.getTreePage.mockResolvedValueOnce({ revision: 1, nodes: [], nextCursor: null });
    shellClient.listPending.mockResolvedValueOnce([diffApproval("d1")]);
    mountBar();
    await waitFor(() => expect(overlay.options?.open).toBe(true));

    emit({
      type: "open-in-gad-browser",
      target: gadTarget,
      approvalId: "d1",
    } as unknown as ApprovalCardIntent);

    await waitFor(() => expect(shellClient.createPanel).toHaveBeenCalled());
    expect(shellClient.navigate).not.toHaveBeenCalled();
  });

  it("keeps decisions working while a diff approval is active", async () => {
    shellClient.resolve.mockImplementation(() => new Promise(() => undefined));
    shellClient.listPending.mockResolvedValueOnce([diffApproval("d1")]);
    mountBar();
    await waitFor(() => expect(overlay.options?.open).toBe(true));
    emit({ type: "decide", decision: "once", approvalId: "d1" });
    expect(shellClient.resolve).toHaveBeenCalledWith("d1", "once");
  });

  /**
   * The install review is the one approval that does not float (§7.2, §7.8): it
   * opens on the full surface, in this document, as a real dialog.
   */
  it("opens an install review on the full surface instead of the floating card", async () => {
    shellClient.listPending.mockResolvedValueOnce([installReviewApproval("news")]);
    mountBar();

    await screen.findByTestId("full-surface");
    expect(fullSurface.props?.approval?.approvalId).toBe("news");
    // Exclusive hosts: the native overlay is a view above the panels, so leaving
    // it up behind the dialog would float a second copy of the same decision.
    expect(overlay.options).toBeNull();
  });

  it("keeps the floating card for approvals that are not a review", async () => {
    shellClient.listPending.mockResolvedValueOnce([
      capabilityApproval({ approvalId: "plain", title: "Open a URL" }),
    ]);
    mountBar();
    await waitFor(() => expect(overlay.options?.open).toBe(true));
    expect(screen.queryByTestId("full-surface")).toBeNull();
  });

  it("leaves the review pending when the surface is closed without deciding", async () => {
    shellClient.listPending.mockResolvedValueOnce([installReviewApproval("news")]);
    mountBar();
    await screen.findByTestId("full-surface");

    // Closing is not declining: the review stays in the queue and the pill
    // offers it back, exactly as minimizing the floating card does.
    act(() => fullSurface.props?.onClose?.());
    expect(await screen.findByRole("button", { name: /Review approval/u })).toBeTruthy();
    expect(screen.queryByTestId("full-surface")).toBeNull();
    expect(shellClient.resolve).not.toHaveBeenCalled();
  });

  it("resolves the review the surface's own actions decide", async () => {
    shellClient.listPending.mockResolvedValueOnce([installReviewApproval("news")]);
    mountBar();
    await screen.findByTestId("full-surface");

    const resolution = { decision: "install", allowNow: [] } as const;
    await act(async () => {
      (fullSurface.props as unknown as { emit: (intent: unknown) => void }).emit({
        type: "resolve-install-review",
        approvalId: "news",
        resolution,
      });
    });
    expect(shellClient.resolveInstallReview).toHaveBeenCalledWith("news", resolution);
  });

  it("keeps the next review actionable while the previous review awaits its landing receipt", async () => {
    let finishFirst: (() => void) | undefined;
    let finishSecond: (() => void) | undefined;
    shellClient.resolveInstallReview
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirst = resolve;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishSecond = resolve;
          })
      );
    const first = installReviewApproval("first");
    const second = { ...installReviewApproval("second"), attention: "queue" as const };
    shellClient.listPending.mockResolvedValueOnce([first]);
    mountBar();
    await waitFor(() => expect(fullSurface.props?.approval?.approvalId).toBe("first"));

    const resolution = { decision: "install", allowNow: [] } as const;
    act(() => {
      fullSurface.props?.emit?.({
        type: "resolve-install-review",
        approvalId: "first",
        resolution,
      });
    });
    expect(shellClient.resolveInstallReview).toHaveBeenCalledWith("first", resolution);
    // Recording the answer and waiting for its landing receipt are different
    // phases. The decided review leaves immediately; a long reconciliation
    // must not pin it on screen as "Saving…".
    await waitFor(() => expect(screen.queryByTestId("full-surface")).toBeNull());

    // The queue removes a decided review immediately. Its RPC remains open
    // until publication landing is known, so the next review can legitimately
    // become current before the first call returns.
    const pendingChangedListener = shellClient.onEvent.mock.calls.find(
      ([event]) => event === "shell-approval:pending-changed"
    )?.[1];
    expect(pendingChangedListener).toBeTypeOf("function");
    act(() => pendingChangedListener?.({ pending: [second] }));
    await waitFor(() => expect(fullSurface.props?.approval?.approvalId).toBe("second"));
    expect(screen.queryByRole("button", { name: /Review approval/u })).toBeNull();
    expect(fullSurface.props?.actionPending).toBe(false);

    act(() => {
      fullSurface.props?.emit?.({
        type: "resolve-install-review",
        approvalId: "second",
        resolution,
      });
    });
    expect(shellClient.resolveInstallReview).toHaveBeenCalledWith("second", resolution);
    expect(shellClient.resolveInstallReview).toHaveBeenCalledTimes(2);

    // Settle both deferred receipts so the mounted coordinator has no work
    // left behind after the assertion.
    await act(async () => {
      finishFirst?.();
      finishSecond?.();
      await Promise.resolve();
    });
  });

  it("restores an install review when recording its decision fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    shellClient.resolveInstallReview.mockRejectedValueOnce(new Error("review write blocked"));
    shellClient.listPending.mockResolvedValueOnce([installReviewApproval("startup")]);
    mountBar();
    await waitFor(() => expect(fullSurface.props?.approval?.approvalId).toBe("startup"));

    act(() => {
      fullSurface.props?.emit?.({
        type: "resolve-install-review",
        approvalId: "startup",
        resolution: { decision: "install", allowNow: [] },
      });
    });

    await waitFor(() => {
      expect(fullSurface.props?.approval?.approvalId).toBe("startup");
      expect(fullSurface.props?.decisionError).toBe("review write blocked");
      expect(fullSurface.props?.actionPending).toBe(false);
    });
    errorSpy.mockRestore();
  });

  it("keeps a same-agent follow-up visible across a briefly empty queue", async () => {
    shellClient.resolveInstallReview.mockResolvedValueOnce(undefined);
    const first = { ...installReviewApproval("first"), callerId: "agent:builder" };
    const second = {
      ...installReviewApproval("second"),
      callerId: "agent:builder",
      attention: "queue" as const,
    };
    shellClient.listPending.mockResolvedValueOnce([first]);
    mountBar();
    await waitFor(() => expect(fullSurface.props?.approval?.approvalId).toBe("first"));

    act(() => {
      fullSurface.props?.emit?.({
        type: "resolve-install-review",
        approvalId: "first",
        resolution: { decision: "install", allowNow: [] },
      });
    });

    const pendingChangedListener = shellClient.onEvent.mock.calls.find(
      ([event]) => event === "shell-approval:pending-changed"
    )?.[1];
    act(() => pendingChangedListener?.({ pending: [] }));
    await waitFor(() => expect(screen.queryByTestId("full-surface")).toBeNull());

    act(() => pendingChangedListener?.({ pending: [second] }));
    await waitFor(() => expect(fullSurface.props?.approval?.approvalId).toBe("second"));
    expect(screen.queryByRole("button", { name: /Review approval/u })).toBeNull();
  });

  it("does not pop open an unrelated queued approval after a review drains", async () => {
    shellClient.resolveInstallReview.mockResolvedValueOnce(undefined);
    const first = { ...installReviewApproval("first"), callerId: "agent:builder" };
    const unrelated = {
      ...installReviewApproval("unrelated"),
      callerId: "agent:other",
      attention: "queue" as const,
    };
    shellClient.listPending.mockResolvedValueOnce([first]);
    mountBar();
    await waitFor(() => expect(fullSurface.props?.approval?.approvalId).toBe("first"));

    act(() => {
      fullSurface.props?.emit?.({
        type: "resolve-install-review",
        approvalId: "first",
        resolution: { decision: "install", allowNow: [] },
      });
    });
    const pendingChangedListener = shellClient.onEvent.mock.calls.find(
      ([event]) => event === "shell-approval:pending-changed"
    )?.[1];
    act(() => pendingChangedListener?.({ pending: [] }));
    act(() => pendingChangedListener?.({ pending: [unrelated] }));

    expect(await screen.findByRole("button", { name: /Review approval/u })).toBeTruthy();
    expect(screen.queryByTestId("full-surface")).toBeNull();
  });

  /**
   * §7.2's Result. The card that asked is gone by the time there is anything to
   * say — accepting takes the approval out of the queue — so the coordinator is
   * the only thing left holding the answer. These cover what it may say with it.
   */
  async function resolveWith(
    outcome: unknown,
    options: { captureTimers?: boolean } = {}
  ): Promise<void> {
    shellClient.listPending.mockResolvedValueOnce([installReviewApproval("news")]);
    shellClient.resolveInstallReview.mockResolvedValueOnce(outcome as never);
    mountBar();
    await screen.findByTestId("full-surface");
    if (options.captureTimers) vi.useFakeTimers();
    await act(async () => {
      (fullSurface.props as unknown as { emit: (intent: unknown) => void }).emit({
        type: "resolve-install-review",
        approvalId: "news",
        resolution: { decision: "install", allowNow: [] },
      });
    });
  }

  const acceptedOutcome = {
    approvalId: "news",
    mode: "install",
    decision: "accepted",
    heading: "News added",
    subject: "News 1.2.0",
    parts: [],
    entryPoint: {
      identityKey: "panels/news@ev",
      repoPath: "panels/news",
      title: "News",
      kind: "panel",
    },
    landing: { landed: ["panels/news@ev"], failed: [], workspaceUnchanged: false },
  };

  const workspaceReadyOutcome = {
    ...acceptedOutcome,
    mode: "adopt-root",
    heading: "Your workspace is ready",
    subject: undefined,
    entryPoint: {
      identityKey: "about/about@ev",
      repoPath: "about/about",
      title: "About Vibestudio",
      kind: "panel",
    },
    landing: { landed: ["about/about@ev"], failed: [], workspaceUnchanged: false },
  } as const;

  it("says what was added and opens it, by the same mechanism as every other panel", async () => {
    await resolveWith(acceptedOutcome);

    expect(await screen.findByText("News added")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open News →" }));

    await waitFor(() =>
      expect(shellClient.createPanel).toHaveBeenCalledWith("panels/news", { title: "News" })
    );
    // The result has handed the user to what it was pointing at, so it goes.
    await waitFor(() => expect(screen.queryByText("News added")).toBeNull());
  });

  it("lets the result be dismissed without touching the queue", async () => {
    await resolveWith(acceptedOutcome);
    await screen.findByText("News added");

    // The answered review is already gone; this confirmation is independent
    // queue chrome, and dismissing it decides nothing.
    expect(screen.queryByTestId("full-surface")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("News added")).toBeNull();
    expect(screen.queryByTestId("full-surface")).toBeNull();
    expect(shellClient.resolve).not.toHaveBeenCalled();
  });

  it("auto-dismisses a successful install result", async () => {
    try {
      await resolveWith(acceptedOutcome, { captureTimers: true });
      expect(screen.getByText("News added")).toBeTruthy();

      act(() => {
        vi.advanceTimersByTime(8_000);
      });

      expect(screen.queryByText("News added")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("briefly confirms a ready workspace without offering an internal entry point", async () => {
    try {
      await resolveWith(workspaceReadyOutcome, { captureTimers: true });

      expect(screen.getByText("Your workspace is ready")).toBeTruthy();
      expect(screen.queryByRole("button", { name: /^Open/u })).toBeNull();

      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      expect(screen.queryByText("Your workspace is ready")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("names the parts that failed, and says nothing was touched only when told", async () => {
    await resolveWith({
      ...acceptedOutcome,
      heading: "Couldn't add these parts",
      entryPoint: undefined,
      landing: {
        landed: [],
        failed: [
          {
            identityKey: "workers/feed@ev",
            title: "Feed Importer",
            reason: "Its build did not finish.",
          },
        ],
        workspaceUnchanged: true,
      },
    });

    // Named with a reason, never counted.
    expect(await screen.findByText("Feed Importer")).toBeTruthy();
    expect(screen.getByText("Its build did not finish.")).toBeTruthy();
    expect(screen.getByText(/exactly as it was/u)).toBeTruthy();
    // A failure interrupts.
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("never claims the workspace was left alone when the server did not say so", async () => {
    await resolveWith({
      ...acceptedOutcome,
      heading: "Couldn't add these parts",
      entryPoint: undefined,
      landing: {
        landed: ["panels/news@ev"],
        failed: [
          { identityKey: "workers/feed@ev", title: "Feed Importer", reason: "Build failed." },
        ],
        // A partial failure is not a clean one, and the surface may not round it
        // up to one.
        workspaceUnchanged: false,
      },
    });

    expect(await screen.findByText("Feed Importer")).toBeTruthy();
    expect(screen.queryByText(/exactly as it was/u)).toBeNull();
  });

  it("does not dress a cancelled review as a failure", async () => {
    await resolveWith({
      approvalId: "news",
      mode: "install",
      decision: "cancelled",
      heading: "News wasn't added",
      parts: [],
    });

    expect(await screen.findByText("News wasn't added")).toBeTruthy();
    // Declining is a decision the user made on purpose. Nothing went wrong, so
    // nothing shouts, and there is nothing to open.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Open/u })).toBeNull();
  });

  it("offers no link for a part this shell has no way to open", async () => {
    await resolveWith({
      ...acceptedOutcome,
      heading: "News added",
      // A client app is host chrome bound to a host target, not a panel slot —
      // there is no open action to offer, so none is shown.
      entryPoint: {
        identityKey: "apps/news@ev",
        repoPath: "apps/news",
        title: "News",
        kind: "app",
      },
    });

    expect(await screen.findByText("News added")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open News →" })).toBeNull();
  });

  it("surfaces a failed decision back through the overlay props", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    shellClient.resolve.mockRejectedValueOnce(new Error("resolve blocked"));
    shellClient.listPending.mockResolvedValueOnce([
      capabilityApproval({ approvalId: "solo", title: "Lonely" }),
    ]);
    mountBar();
    await waitFor(() => expect(overlay.options?.open).toBe(true));

    emit({ type: "decide", decision: "once", approvalId: "solo" });
    await waitFor(() => {
      expect(overlay.options?.props?.approval?.approvalId).toBe("solo");
      expect(overlay.options?.props?.decisionError).toBe("resolve blocked");
    });
    errorSpy.mockRestore();
  });
});
