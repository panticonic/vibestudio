/**
 * Pure (React-free, RPC-free) model shared by the approval coordinator
 * (`ConsentApprovalBar`, which runs in the chrome with RPC) and the
 * presentational `ApprovalCard` (which renders inside the content-overlay
 * surface, a separate document with NO RPC). Keeping these helpers here lets the
 * card be hosted in the overlay without dragging in `../shell/client`.
 */
import type { ApprovalDecision, PendingApproval } from "@vibestudio/shared/approvals";
import { getApprovalRiskTone, getRequesterCategoryLabel } from "@vibestudio/shared/approvalCopy";
import type { DiffChangedFile, DiffReviewEntry } from "@workspace/ui";

export interface CallerInfo {
  /** Friendly user-visible label — panel title, worker source basename, etc. */
  label: string;
  /** Caller kind, formatted for display ("Panel" / "Worker" / "Service"). */
  kindLabel: string;
  /** Caller kind as accepted by the approval payload. */
  kind: "panel" | "app" | "worker" | "do" | "system";
  /** Set when this caller refers to a panel that exists in the live tree. */
  panelId?: string;
  /** Truncated id, retained for the expandable details panel. */
  shortId: string;
}

/** Risk tone → accent token key used by `data-approval-tone` in overrides.css. */
export type ApprovalTone = "sky" | "amber" | "red";

/** Browse position for the queue navigator (null when a single approval). */
export interface ApprovalQueueInfo {
  index: number;
  total: number;
  canPrev: boolean;
  canNext: boolean;
}

/**
 * Intents the presentational card emits up to its host. In the overlay these
 * cross the process boundary (surface → main → chrome) as opaque payloads; the
 * chrome coordinator runs the matching RPC handler.
 */
export type ApprovalCardIntentBody =
  | { type: "decide"; decision: ApprovalDecision }
  | { type: "submit-client-config"; values: Record<string, string> }
  | { type: "submit-credential-input"; values: Record<string, string> }
  | { type: "submit-secret-input"; values: Record<string, string> }
  | { type: "resolve-userland"; choice: string }
  | { type: "device-cancel" }
  | { type: "minimize" }
  | { type: "browse"; dir: "prev" | "next" }
  | { type: "show-panel" }
  // Diff-review (P3.5): the overlay surface has no RPC, so the presentational
  // card asks the chrome coordinator to fetch a payload blob by content hash,
  // and the result comes back down as an updated `blobResults` prop.
  | { type: "fetch-blob"; hash: string }
  // Diff-review escape hatch: the reviewer wants to inspect a file in the
  // gad-browser panel (the only surface with a real file-inspection view).
  // The chrome coordinator opens/focuses gad-browser with this target as
  // launch state-args. Emitted both for degraded (binary/oversized) rows and
  // as a quiet secondary action on normal file headers.
  | { type: "open-in-gad-browser"; target: GadBrowserTarget };
export type ApprovalCardIntent = { approvalId: string } & ApprovalCardIntentBody;

/**
 * Deep-link target for the "open in gad-browser" escape hatch. Carries the
 * repo + focused path + the two content hashes and two tree states named in the
 * diff-review payload, so the gad-browser panel can render a real two-state
 * compare view for the file. `files` carries the entry's whole changed-file set
 * so the panel can step across every file the reviewer was sent for; `binary` /
 * `tooLarge` mirror the host degrade flags of the focused file. Mirrors the
 * per-file fields of a `DiffReviewEntry` (and the panel's `DiffTarget`).
 */
export interface GadBrowserTarget {
  repoPath: string;
  path: string;
  oldHash?: string;
  newHash?: string;
  oldState: string;
  newState: string | null;
  /** Host-flagged binary/oversized focused file → diffstat-only in the panel. */
  binary?: boolean;
  tooLarge?: boolean;
  /** Every changed file of the source entry (includes the focused `path`). */
  files?: DiffChangedFile[];
}

/**
 * Result of one chrome-side blob fetch, pushed back down to the overlay surface.
 * `text` is the decoded blob; a `null`-shaped result is either a missing blob or
 * a fetch error (both degrade non-blockingly in the viewer).
 */
export type BlobResult = { text: string } | { missing: true } | { error: string };

/**
 * Feature-detect the diff-review payload on an approval. Absent (every approval
 * that isn't a host main-advance / repo deletion / restore) → `null`, and the
 * card renders exactly as today. Present → the host-computed per-repo batch
 * entries. The field is declared on the shared `PendingApproval` type; the
 * runtime shape check guards against a malformed payload over the wire.
 */
export function getDiffReviewPayload(approval: PendingApproval): DiffReviewEntry[] | null {
  const candidate = approval.diffReview;
  if (!Array.isArray(candidate) || candidate.length === 0) return null;
  const valid = candidate.every((entry) => {
    if (typeof entry !== "object" || entry === null) return false;
    const record = entry as { repoPath?: unknown; changedFiles?: unknown; diffStat?: unknown };
    if (typeof record.repoPath !== "string") return false;
    if (!Array.isArray(record.changedFiles)) return false;
    const diffStat = record.diffStat;
    if (typeof diffStat !== "object" || diffStat === null) return false;
    return typeof (diffStat as { filesChanged?: unknown }).filesChanged === "number";
  });
  return valid ? candidate : null;
}

/**
 * Every content hash the diff-review payload legitimately references. The chrome
 * fetches ONLY these hashes on the surface's behalf — a `fetch-blob` intent for
 * any other hash is ignored. (Content addressing already guarantees a hash can
 * only return its own bytes; this bounds WHICH blobs the card may read at all.)
 */
export function diffReviewPayloadHashes(entries: DiffReviewEntry[]): Set<string> {
  const hashes = new Set<string>();
  for (const entry of entries) {
    for (const file of entry.changedFiles) {
      if (file.oldHash) hashes.add(file.oldHash);
      if (file.newHash) hashes.add(file.newHash);
    }
  }
  return hashes;
}

export function basename(path: string): string {
  if (!path) return "";
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

export function prettifyId(callerId: string): string {
  // Drop common prefixes ("do-service:", "do:", "worker:") and trim noise.
  return callerId.replace(/^(do-service:|do:|worker:|panel:)/, "");
}

export function truncateId(id: string, head = 8, tail = 4): string {
  if (id.length <= head + tail + 1) return id;
  return `${id.slice(0, head)}…${id.slice(-tail)}`;
}

export function approvalAccent(approval: PendingApproval): ApprovalTone {
  const tone = getApprovalRiskTone(approval);
  if (tone === "danger") return "red";
  if (tone === "caution") return "amber";
  return "sky";
}

/**
 * Highest-risk tone across the whole pending queue, so a minimized red request
 * can't hide behind a calmer sky one in the pill.
 */
export function highestPendingTone(pending: readonly PendingApproval[]): ApprovalTone {
  let tone: ApprovalTone = "sky";
  for (const approval of pending) {
    const accent = approvalAccent(approval);
    if (accent === "red") return "red";
    if (accent === "amber") tone = "amber";
  }
  return tone;
}

/**
 * Derive a display-friendly caller from an approval. Authoritative titles come
 * from the server-side entity-title registry (mirrored onto `callerTitle` /
 * `requester.title`); we fall back to a derived id-ish label.
 */
export function resolveCallerInfo(approval: PendingApproval): CallerInfo {
  if (approval.requester) {
    return {
      label: approval.requester.title ?? approval.callerTitle ?? prettifyId(approval.callerId),
      kindLabel: getRequesterCategoryLabel(approval.requester.category),
      kind: approval.requester.kind,
      panelId:
        approval.requester.panel?.id ??
        (approval.requester.kind === "panel" ? approval.requester.id : undefined),
      shortId: truncateId(approval.requester.ephemeralInstanceKey),
    };
  }
  const shortId = truncateId(approval.callerId);
  const serverTitle = approval.callerTitle?.trim() || undefined;
  if (approval.callerKind === "panel") {
    return {
      label: serverTitle ?? prettifyId(approval.callerId),
      kindLabel: "Panel",
      kind: "panel",
      // "Show panel" is offered unconditionally — navigation is a no-op for
      // unknown ids, so it's safe.
      panelId: approval.callerId,
      shortId,
    };
  }
  if (approval.callerKind === "worker") {
    const fromRepo = basename(approval.repoPath);
    return {
      label: serverTitle ?? fromRepo ?? prettifyId(approval.callerId),
      kindLabel: "Worker",
      kind: "worker",
      shortId,
    };
  }
  if (approval.callerKind === "app") {
    const fromRepo = basename(approval.repoPath);
    return {
      label: serverTitle ?? fromRepo ?? prettifyId(approval.callerId),
      kindLabel: "App",
      kind: "app",
      shortId,
    };
  }
  if (approval.callerKind === "system") {
    return {
      label: serverTitle ?? "Workspace",
      kindLabel: "Workspace",
      kind: "system",
      shortId,
    };
  }
  // Durable-object service or unknown — show the trailing segment of the id.
  const id = prettifyId(approval.callerId);
  const segments = id.split(":");
  return {
    label: serverTitle ?? segments[segments.length - 1] ?? id,
    kindLabel: "Service",
    kind: "do",
    shortId,
  };
}

export type { ApprovalDecision };
