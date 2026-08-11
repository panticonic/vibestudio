/**
 * The full-surface approval host — the window-sized dialog behind the two-pane
 * install review (docs/template-install-unit-approval-ux-plan.md §7.2, §7.8).
 *
 * Why this exists at all. Every other approval is hosted by the content overlay:
 * a transparent native view floated over the panels, capped by the host well
 * below the window and anchored to a corner. That shape is a notification, and
 * §7.2 asks for a dialog "preferring 1100×720 and never wider than the window".
 * The cap is not ours to raise from here, and raising it would be the wrong fix
 * anyway — a corner-anchored floating card that swallows the window is still a
 * card. So the full surface is hosted the way every other window-sized surface
 * in this shell is hosted: as a dialog in the chrome document, with the panel
 * views hidden underneath it (`useShellOverlay`, the same registration the
 * workspace chooser and the wizard use). CSS cannot stack chrome above a native
 * panel view; that registration is what makes the dialog visible at all.
 *
 * What that buys, beyond width: the shell's dialog conventions come with it.
 * Focus enters the surface, is trapped while it is open, `Escape` closes, and
 * focus returns to whatever the person was on before it opened — the panel or
 * the onboarding step that started this (§7.8). None of that is re-implemented
 * here; inventing a second focus model for one surface is how a shell ends up
 * with two.
 *
 * The card inside is the same `ApprovalCard` the overlay renders, in `dialog`
 * layout. Same header, same queue navigator, same `Enter`/`D` shortcuts, same
 * intents to the same coordinator: only the host and the arrangement differ.
 */
import { useEffect, useRef } from "react";
import { Dialog } from "@radix-ui/themes";
import { OVERLAY_Z } from "@workspace/ui/overlay";
import type { PendingApproval } from "@vibestudio/shared/approvals";
import { getApprovalCopy } from "@vibestudio/shared/approvalCopy";
import { useShellOverlay } from "../shell/useShellOverlay";
import { ApprovalCard } from "./ApprovalCard";
import type { ApprovalCardIntent, ApprovalQueueInfo, CallerInfo } from "./approvalCardModel";

/** §7.2: prefer 1100×720, and never wider or taller than the window. */
const PREFERRED_WIDTH = 1100;
const PREFERRED_HEIGHT = 720;
/** Breathing room so the dialog never sits flush against the window edge. */
const WINDOW_MARGIN = 32;

export interface ApprovalFullSurfaceProps {
  approval: PendingApproval;
  caller: CallerInfo;
  queue: ApprovalQueueInfo | null;
  decisionError: string | null;
  actionPending: boolean;
  appearance: "light" | "dark";
  emit: (intent: ApprovalCardIntent) => void;
  /** Closing the surface without deciding — the same act as minimizing it. */
  onClose: () => void;
}

/**
 * Put focus back where it was when the surface opened (§7.8: "focus returns to
 * the originating panel or onboarding step").
 *
 * The dialog restores focus itself when it closes normally, and this agrees with
 * it rather than fighting it — restoring to the same element is idempotent. What
 * it adds is the case the dialog cannot cover: this surface is not always
 * dismissed, it is often *resolved*, and the review then unmounts because the
 * approval left the queue rather than because a dialog closed. A review that
 * ends by being accepted must hand focus back exactly as one that ends by being
 * closed, or accepting leaves the keyboard on nothing.
 *
 * It restores only to an element that is still in the document and still
 * focusable; a panel that went away while the review was open gets nothing
 * rather than an exception.
 */
export function useReturnFocus(): void {
  const origin = useRef<Element | null>(
    typeof document === "undefined" ? null : document.activeElement
  );
  useEffect(() => {
    const opener = origin.current;
    return () => {
      if (!(opener instanceof HTMLElement)) return;
      if (!opener.isConnected) return;
      opener.focus();
    };
  }, []);
}

export function ApprovalFullSurface({
  approval,
  caller,
  queue,
  decisionError,
  actionPending,
  appearance,
  emit,
  onClose,
}: ApprovalFullSurfaceProps) {
  // Hide the native panel views while this is up. Without it the dialog renders
  // correctly and is covered by whatever panel happens to be on screen.
  useShellOverlay(true);
  useReturnFocus();
  const copy = getApprovalCopy(approval);

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Content
        className="approval-full-surface"
        aria-describedby={undefined}
        style={{
          width: `min(${PREFERRED_WIDTH}px, calc(100vw - ${WINDOW_MARGIN}px))`,
          maxWidth: `calc(100vw - ${WINDOW_MARGIN}px)`,
          height: `min(${PREFERRED_HEIGHT}px, calc(100dvh - ${WINDOW_MARGIN}px))`,
          maxHeight: `calc(100dvh - ${WINDOW_MARGIN}px)`,
          padding: 0,
          overflow: "hidden",
          zIndex: OVERLAY_Z.dialog as unknown as number,
          boxShadow: "var(--elevation-overlay)",
        }}
      >
        {/*
          The dialog's accessible name. The card renders the same words as its own
          visible heading a few pixels below, so repeating them here as a second
          visible title would say everything twice — hidden, it names the surface
          for anyone who arrives by screen reader without duplicating it for
          anyone who arrives by eye.
        */}
        <Dialog.Title className="approval-full-surface-name">{copy.title}</Dialog.Title>
        <ApprovalCard
          key={approval.approvalId}
          approval={approval}
          caller={caller}
          queue={queue}
          decisionError={decisionError}
          actionPending={actionPending}
          diffReview={null}
          appearance={appearance}
          layout="dialog"
          emit={emit}
        />
      </Dialog.Content>
    </Dialog.Root>
  );
}
