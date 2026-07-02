// @vitest-environment jsdom

import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Theme } from "@radix-ui/themes";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingUnitBatchApproval, PendingUserlandApproval } from "@natstack/shared/approvals";
import type { ApprovalCardIntent } from "./approvalCardModel";

type ListPendingFn = () => Promise<unknown[]>;
const shellClient = vi.hoisted(() => ({
  heartbeat: vi.fn(() => Promise.resolve()),
  listPending: vi.fn<ListPendingFn>(() => Promise.resolve([])),
  resolve: vi.fn(() => Promise.resolve()),
  resolveUserland: vi.fn(() => Promise.resolve()),
  submitClientConfig: vi.fn(() => Promise.resolve()),
  submitCredentialInput: vi.fn(() => Promise.resolve()),
  subscribe: vi.fn(() => Promise.resolve()),
  unsubscribe: vi.fn(() => Promise.resolve()),
  onRpcEvent: vi.fn((_event: string, _listener: (event: { payload: unknown }) => void) => () => {}),
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
    resolveUserland: shellClient.resolveUserland,
    submitClientConfig: shellClient.submitClientConfig,
    submitCredentialInput: shellClient.submitCredentialInput,
  },
  shellPresence: { heartbeat: shellClient.heartbeat },
  events: { subscribe: shellClient.subscribe, unsubscribe: shellClient.unsubscribe },
  onRpcEvent: shellClient.onRpcEvent,
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
      accentColor: "iris",
      grayColor: "slate",
      radius: "medium",
      scaling: "100%",
      panelBackground: "translucent",
    }),
  };
});

vi.mock("./NavigationContext", () => ({
  useNavigation: () => ({ navigateToId: vi.fn() }),
}));

import { ConsentApprovalBar } from "./ConsentApprovalBar";

function emit(intent: ApprovalCardIntent): void {
  act(() => {
    overlay.onIntent?.(intent);
  });
}

function userlandApproval(
  partial: Partial<PendingUserlandApproval> & { approvalId: string; title: string }
): PendingUserlandApproval {
  return {
    kind: "userland",
    callerId: partial.callerId ?? `panel:${partial.approvalId}`,
    callerKind: partial.callerKind ?? "panel",
    repoPath: partial.repoPath ?? "panels/test",
    effectiveVersion: partial.effectiveVersion ?? "ev",
    requestedAt: partial.requestedAt ?? Date.now(),
    callerTitle: partial.callerTitle,
    subject: partial.subject ?? { id: "sub-1", label: "Subject" },
    title: partial.title,
    summary: partial.summary,
    promptOptions: partial.promptOptions ?? "choices",
    options: partial.options ?? [{ value: "ok", label: "OK", tone: "primary" }],
    approvalId: partial.approvalId,
  };
}

function startupApproval(approvalId: string): PendingUnitBatchApproval {
  return {
    kind: "unit-batch",
    trigger: "startup",
    callerId: "system:units",
    callerKind: "system",
    repoPath: "meta",
    effectiveVersion: "ev",
    requestedAt: Date.now(),
    title: "Approve native extension",
    description: "startup",
    approvalId,
    units: [
      {
        unitKind: "extension",
        unitName: "@workspace-extensions/ext",
        displayName: "Extension",
        version: "0.1.0",
        source: { kind: "workspace-repo", repo: "extensions/ext", ref: "main" },
        ev: "ev-ext",
        capabilities: ["node:fs"],
      },
    ],
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
      userlandApproval({ approvalId: "a1", title: "First" }),
      userlandApproval({ approvalId: "a2", title: "Second" }),
      userlandApproval({ approvalId: "a3", title: "Third" }),
    ]);
    mountBar();
    await waitFor(() => {
      expect(overlay.options?.open).toBe(true);
      expect(overlay.options?.props?.approval?.approvalId).toBe("a1");
    });
    expect((overlay.options?.props?.queue as { total: number }).total).toBe(3);
  });

  it("excludes startup approvals from the runtime overlay", async () => {
    shellClient.listPending.mockResolvedValueOnce([
      startupApproval("extension-startup"),
      userlandApproval({ approvalId: "runtime", title: "Runtime approval" }),
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
      userlandApproval({ approvalId: "solo", title: "Lonely", callerTitle: "Chat A" }),
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

  it("resolves and removes an approval on a decide intent", async () => {
    shellClient.resolve.mockImplementation(() => new Promise(() => undefined));
    shellClient.listPending.mockResolvedValueOnce([
      userlandApproval({ approvalId: "solo", title: "Lonely" }),
    ]);
    mountBar();
    await waitFor(() => expect(overlay.options?.open).toBe(true));

    emit({ type: "decide", decision: "once", approvalId: "solo" });
    expect(shellClient.resolve).toHaveBeenCalledWith("solo", "once");
    await waitFor(() => expect(overlay.options).toBeNull());
  });

  it("ignores stale overlay intents for a previously rendered approval", async () => {
    shellClient.listPending.mockResolvedValueOnce([
      userlandApproval({ approvalId: "current", title: "Current" }),
    ]);
    mountBar();
    await waitFor(() => expect(overlay.options?.open).toBe(true));

    emit({ type: "decide", decision: "once", approvalId: "stale" });

    expect(shellClient.resolve).not.toHaveBeenCalled();
    expect(overlay.options?.props?.approval?.approvalId).toBe("current");
  });

  it("surfaces a failed decision back through the overlay props", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    shellClient.resolve.mockRejectedValueOnce(new Error("resolve blocked"));
    shellClient.listPending.mockResolvedValueOnce([
      userlandApproval({ approvalId: "solo", title: "Lonely" }),
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
