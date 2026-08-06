/**
 * Panel ID generation utilities.
 *
 * Shared between shell and server panel lifecycle code.
 * These functions are pure — no Electron or Node.js-specific dependencies
 * beyond `crypto.randomBytes`.
 */

import { panelPrincipalId } from "./principalIds.js";

/**
 * Validate and sanitize a panel ID segment (e.g., a user-provided name).
 *
 * Valid segments must match ^[A-Za-z0-9][A-Za-z0-9_~-]*$ (1–64 chars):
 *   - Must start with an alphanumeric character (no leading hyphens, underscores, or dots)
 *   - May contain letters, digits, underscores, hyphens, and tildes
 *   - Tilde is explicitly included because the system itself generates segments of the
 *     form `<page>~<timestamp36>` for about-panels (e.g. "new~lk2f8g")
 *   - The strict allow-list implicitly rejects `.`, `..`, `...`, path separators
 *     (`/`, `\`), and any other shell-special characters — closing a path-traversal
 *     gap where the previous deny-list omitted `..`
 *
 * @decision DEC-01: Allow-list regex over deny-list
 * @rationale: The original deny-list rejected `.`, `/`, `\` but silently allowed `..`,
 *   which breaks the invariant that panel IDs are clean slash-segmented tree paths relied
 *   on by CDP ancestor checks, git-auth prefix checks, and typecheck source extraction.
 *   An allow-list is more robust: unknown-bad inputs are rejected by default.
 */
// Replaced deny-list with strict allow-list to close the `..` path-traversal gap.
// Tilde retained for system-generated about-panel segments.
const VALID_PANEL_ID_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_~-]*$/;

export function sanitizePanelIdSegment(segment: string): string {
  const trimmed = segment.trim();
  if (!trimmed || !VALID_PANEL_ID_SEGMENT.test(trimmed)) {
    throw new Error(`Invalid panel identifier segment: ${segment}`);
  }
  return trimmed;
}

export function panelIdSegmentFromName(name: string): string {
  const normalized = name
    .trim()
    .replace(/[^A-Za-z0-9_~-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .replace(/-+$/g, "");
  if (!normalized) throw new Error(`Invalid panel identifier segment: ${name}`);
  return sanitizePanelIdSegment(normalized);
}

/**
 * Generate a unique nonce for panel ID generation.
 * Format: base36-timestamp-hexrandom (e.g., "lk2f8g-3a1b9c4e")
 */
export function generatePanelNonce(): string {
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  return `${Date.now().toString(36)}-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Compute a deterministic panel ID from a source path, optional parent, and
 * optional requested name.
 *
 * ID scheme:
 * - Root panels: `panel:tree/{escapedPath}`
 * - Named children: `{parentId}/{name}`
 * - Auto-named children: `{parentId}/{escapedPath}/{nonce}`
 *
 * @param parent - Only needs `{ id: string }`. Pass null/undefined for root.
 */
export function computePanelId(params: {
  relativePath: string;
  parent?: { id: string } | null;
  requestedId?: string;
  isRoot?: boolean;
}): string {
  const { relativePath, parent, requestedId, isRoot } = params;

  // Escape slashes in path to avoid collisions
  const escapedPath = relativePath.replace(/\//g, "~");

  if (isRoot) {
    if (requestedId) {
      const segment = sanitizePanelIdSegment(requestedId);
      return panelPrincipalId(`tree/${segment}`);
    }
    const nonce = generatePanelNonce();
    return panelPrincipalId(`tree/${escapedPath}/${nonce}`);
  }

  // Parent prefix: use parent's full ID, or "tree" for root panels
  const parentPrefix = parent?.id ?? panelPrincipalId("tree");

  if (requestedId) {
    const segment = sanitizePanelIdSegment(requestedId);
    return `${parentPrefix}/${segment}`;
  }

  const autoSegment = generatePanelNonce();
  return `${parentPrefix}/${escapedPath}/${autoSegment}`;
}

/**
 * The full logical identity of one idempotent panel-open operation.
 *
 * A retry converges on the same panel only when its execution coordinates match.
 * Folding source, exact ref, explicit context, and parent into the hashed segment means a
 * caller reusing an `operationId` for a different logical open (other source,
 * other context, other parent) derives a *distinct* slot and entity identity
 * instead of colliding with — and potentially destroying — the first panel.
 */
export interface PanelOperationIdentityInput {
  operationId: string;
  /** Requested panel source (workspace repo path or full browser URL). */
  source: string;
  /** Explicit caller-provided context only; derived contexts stay out of the key. */
  contextId?: string | null;
  parentId?: string | null;
  ref?: string | null;
}

export interface PanelOperationIdentity {
  /** Stable panel-id segment (`op-<hash>`), for `computePanelId({ requestedId })`. */
  operationSegment: string;
  /** Stable history entry key (`nav-op-<hash>`), which also keys the runtime entity. */
  entryKey: string;
}

/**
 * Derive every retry-stable identifier of one logical panel open in one place.
 */
export async function derivePanelOperationIdentity(
  input: PanelOperationIdentityInput
): Promise<PanelOperationIdentity> {
  const material = [
    input.operationId,
    input.source,
    input.contextId ?? "",
    input.parentId ?? "",
    input.ref ?? "latest",
  ].join("\u0000");
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(material)
  );
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 24);
  const operationSegment = `op-${hash}`;
  return { operationSegment, entryKey: `nav-${operationSegment}` };
}

/**
 * Typed collision surfaced when a slot id is reused with a different durable
 * identity (entry key / entity / parent). Distinguishable from transport
 * failures so a retrying caller never mistakes "this identity is taken" for
 * "the write may not have happened" — and never rolls back live state.
 */
export const SLOT_IDENTITY_COLLISION_CODE = "SLOT_IDENTITY_COLLISION";

export class SlotIdentityCollisionError extends Error {
  readonly code = SLOT_IDENTITY_COLLISION_CODE;
  constructor(
    readonly slotId: string,
    readonly conflict: { field: string; existing: unknown; attempted: unknown }
  ) {
    super(
      `Slot identity collision on ${slotId}: ${conflict.field} existing=${JSON.stringify(
        conflict.existing
      )} attempted=${JSON.stringify(conflict.attempted)}`
    );
    this.name = "SlotIdentityCollisionError";
  }
}

/** Recognize a slot identity collision, locally thrown or reconstructed from RPC. */
export function isSlotIdentityCollisionError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === SLOT_IDENTITY_COLLISION_CODE
  );
}
