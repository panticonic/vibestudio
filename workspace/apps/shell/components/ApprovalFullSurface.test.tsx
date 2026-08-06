// @vitest-environment jsdom

/**
 * The full surface's focus contract (§7.8: "focus returns to the originating
 * panel or onboarding step").
 *
 * The hook is tested on its own AND through a real mount. Handing focus BACK
 * when a review ends is ours — a review usually ends by being resolved rather
 * than dismissed, so the surface unmounts without a dialog ever "closing" — and
 * the hook tests hold that contract precisely, in isolation from anything Radix
 * does. The mount tests then hold what only a real dialog can show: that the
 * review renders inside it in dialog layout under its accessible name, that the
 * keyboard actually lands in it, that Escape minimizes without answering the
 * review, and that the hook's hand-back survives contact with Radix's own focus
 * restoration rather than fighting it.
 *
 * Mounting a Radix dialog in this runner used to be impossible: the scroll-lock
 * helpers are CJS, so their inner `require("react")` was resolved by Node from
 * the workspace package store and bound to a second copy of React whose
 * dispatcher is null. `vitest.sharedConfig.ts` now pins those helpers to the
 * root copy, which fixes the resolution at its source rather than mocking the
 * dialog away.
 */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Theme } from "@radix-ui/themes";
import { describe, expect, it, vi } from "vitest";
import type { PendingUnitInstallReviewApproval } from "@vibestudio/shared/approvals";

// The surface registers itself as a shell overlay so main hides the panel views
// beneath it; that registration reaches the shell transport, which only exists
// inside the app. Nothing here is about the registration.
vi.mock("../shell/useShellOverlay", () => ({ useShellOverlay: () => {} }));

import { ApprovalFullSurface, useReturnFocus } from "./ApprovalFullSurface";
import { resolveCallerInfo, type ApprovalCardIntent } from "./approvalCardModel";

function Surface() {
  useReturnFocus();
  return <button type="button">Add template</button>;
}

describe("the full surface's focus contract", () => {
  it("puts focus back where it came from when the surface goes away", () => {
    const opener = document.createElement("button");
    opener.textContent = "Templates";
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    const { unmount } = render(<Surface />);
    // The surface takes focus while it is open.
    screen.getByText("Add template").focus();
    expect(document.activeElement).not.toBe(opener);

    // Resolving the review unmounts it — the same hand-back a dismissal gets.
    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("does not reach for a panel that went away while the review was open", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();

    const { unmount } = render(<Surface />);
    // The originating panel closed underneath the review. Focus has nowhere to
    // return to, and that is a shrug, never an exception.
    opener.remove();
    expect(() => unmount()).not.toThrow();
  });
});

describe("the full surface renders the review it is given", () => {
  function installApproval(): PendingUnitInstallReviewApproval {
    const approval: PendingUnitInstallReviewApproval = {
      kind: "unit-install-review",
      approvalId: "install-1",
      callerId: "system:templates",
      callerKind: "system",
      repoPath: "meta",
      effectiveVersion: "",
      requestedAt: 1,
      mode: "install",
      title: "Add News",
      description: "Adds 1 part.",
      parts: [
        {
          identityKey: "workers/news@ev",
          kind: "worker",
          label: "Agent",
          surfaces: [],
          name: "@news/agent",
          title: "News Agent",
          purpose: "Fetches and summarizes articles on a schedule.",
          repoPath: "workers/news-agent",
          effectiveVersion: "ev",
          version: "1.2.0",
          requiredUnitKeys: [],
          runsInBackground: true,
          origin: {
            url: "https://github.com/panticonic/news",
            originKey: "github.com/panticonic",
            registrableDomain: "github.com",
            version: "1.2.0",
            isHostBuild: false,
            firstEncounter: true,
          },
          notableRows: [],
          everydayRows: [],
          change: "added",
          section: "template",
        },
      ],
      summary: { panels: 0, agents: 1, services: 0, clientApps: 0, extensions: 0 },
      unchangedPartCount: 0,
    };
    return approval;
  }

  function mountSurface(overrides?: {
    emit?: (intent: ApprovalCardIntent) => void;
    onClose?: () => void;
  }): {
    approval: PendingUnitInstallReviewApproval;
    unmount: () => void;
  } {
    const approval = installApproval();
    const { unmount } = render(
      <Theme>
        <ApprovalFullSurface
          approval={approval}
          caller={resolveCallerInfo(approval)}
          queue={null}
          decisionError={null}
          actionPending={false}
          appearance="light"
          emit={overrides?.emit ?? vi.fn()}
          onClose={overrides?.onClose ?? vi.fn()}
        />
      </Theme>
    );
    return { approval, unmount };
  }

  it("mounts the dialog around the card, named and in dialog layout", () => {
    mountSurface();

    // The dialog is really there, with the accessible name the copy gives it.
    const dialog = screen.getByRole("dialog");
    // Twice: the dialog's own hidden name, and the card's visible heading.
    expect(within(dialog).getAllByText("Add News").length).toBeGreaterThan(0);
    // And the review inside it, down to the part it is about.
    expect(within(dialog).getByText("News Agent")).toBeTruthy();
    // Identity at human scale: no commit id or content digest, at any level.
    expect(dialog.textContent).not.toMatch(/[0-9a-f]{40}/u);
  });

  it("takes the keyboard into the review when it opens", async () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();

    mountSurface();

    // A review the keyboard cannot reach is a review that did not happen: the
    // decision has to be answerable without touching a pointer (§7.8).
    const dialog = screen.getByRole("dialog");
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    opener.remove();
  });

  it("minimizes on Escape instead of answering the review", () => {
    const onClose = vi.fn();
    const emit = vi.fn();
    mountSurface({ onClose, emit });

    fireEvent.keyDown(document.body, { key: "Escape", code: "Escape" });

    // Closing is not declining. The review must still be pending afterwards, so
    // no decision may leave here — the coordinator turns this into "minimized".
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(emit).not.toHaveBeenCalled();
  });

  it("hands the keyboard back when the review is resolved rather than dismissed", async () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();

    const { unmount } = mountSurface();
    const dialog = screen.getByRole("dialog");
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    // The case the dialog itself cannot cover: nothing "closed" it. The approval
    // left the queue because it was answered, and the surface went with it. If
    // focus did not come back here, accepting a template would leave the
    // keyboard on nothing.
    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
