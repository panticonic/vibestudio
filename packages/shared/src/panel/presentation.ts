import type { PanelRuntimeLease } from "./panelLease.js";

export type PanelPresentationStage =
  | "resolving"
  | "leasing"
  | "creating-view"
  | "navigating"
  | "booting"
  | "waiting-for-slot"
  | "attaching"
  | "recovering";

export interface PanelPresentationLeaseHolder {
  runtimeEntityId: string;
  connectionId: string;
  clientSessionId: string;
  holderLabel: string;
  holderPlatform: PanelRuntimeLease["platform"];
}

export type PanelPresentation =
  | { state: "idle"; slotId: string }
  | {
      state: "loading";
      slotId: string;
      attemptId: string;
      stage: PanelPresentationStage;
      enteredAt: number;
    }
  | {
      state: "unavailable";
      slotId: string;
      attemptId: string;
      reason: "leased-elsewhere";
      lease: PanelPresentationLeaseHolder;
      enteredAt: number;
    }
  | {
      state: "ready";
      slotId: string;
      attemptId: string;
      surface: "code" | "external";
      runtimeEntityId: string;
      webContentsId: number;
      nativeSlotId: string;
      documentRevision: number;
      url: string;
      enteredAt: number;
    }
  | {
      state: "failed";
      slotId: string;
      attemptId: string;
      stage: PanelPresentationStage;
      code: string;
      message: string;
      /**
       * Whether another attempt could plausibly succeed without anything
       * changing about the panel itself.
       *
       * The distinction the model was missing. A dropped transport and a
       * single renderer crash clear on their own; a renderer that fails to
       * boot, or one already crash-looping, will fail again the same way.
       * Without saying which, a failure can only be memoised — and a
       * memoised transient failure is indistinguishable from a broken panel,
       * which is how a slot ends up waiting on a condition that has already
       * passed.
       */
      retryable: boolean;
      enteredAt: number;
    };

export interface PanelPresentationSnapshot {
  revision: number;
  presentation: PanelPresentation;
}

export function summarizePresentationLease(lease: PanelRuntimeLease): PanelPresentationLeaseHolder {
  return {
    runtimeEntityId: lease.runtimeEntityId,
    connectionId: lease.connectionId,
    clientSessionId: lease.clientSessionId,
    holderLabel: lease.holderLabel,
    holderPlatform: lease.platform,
  };
}
