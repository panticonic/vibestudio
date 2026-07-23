/**
 * Canonical, transport-independent panel navigation.
 *
 * A PanelLocation identifies logical workspace content. It is deliberately
 * separate from the loopback/gateway HTTP URL used to serve a built panel.
 */

import { PAIR_LINK_ORIGIN } from "./connect.js";
import type { PanelPlacementHint } from "./types.js";

export const PANEL_LOCATION_PROTOCOL_VERSION = 1 as const;
export const PANEL_DEEP_LINK_HOST = "panel" as const;
export const PANEL_SHARE_LINK_PATH = "/panel" as const;
export const MAX_PANEL_LOCATION_PARAMS_LENGTH = 32 * 1024;

export type PanelDisposition = "current" | "child" | "root";
export type PanelLocationCarrier = "scheme" | "https";

export interface PanelLocation {
  /** Workspace-relative build source, for example `panels/chat`. */
  source: string;
  /** Optional workspace selector for links that cross application launches. */
  workspace?: string;
  /** Optional code/build ref; independent from the state context. */
  ref?: string;
  /** Optional data/storage context. */
  contextId?: string;
  /** Initial panel state, validated again by the target panel manifest. */
  stateArgs?: Record<string, unknown>;
  /** Optional panel title/name override. */
  name?: string;
  /** Whether a newly-created target should receive focus. */
  focus?: boolean;
  /** Placement relative to the panel from which navigation originates. */
  disposition?: PanelDisposition;
  /**
   * Layout hint applied when the location creates a panel. This is independent
   * of `disposition`: use `disposition: "child"` to choose tree placement and
   * `placement.disposition: "side"` to request its visual placement.
   */
  placement?: PanelPlacementHint;
}

export type ParsedPanelLocationLink =
  | { kind: "ok"; location: PanelLocation; carrier: PanelLocationCarrier }
  | { kind: "error"; reason: string };

const PARAMETER_KEYS = new Set([
  "v",
  "source",
  "workspace",
  "ref",
  "contextId",
  "stateArgs",
  "name",
  "focus",
  "disposition",
  "placement",
  "preferredWidth",
  "minWidth",
]);
const SOURCE_RE = /^[A-Za-z0-9._@-]+\/[A-Za-z0-9._@-]+$/;

function isSafeText(value: string, maxLength: number): boolean {
  return value.length > 0 && value.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(value);
}

export function isPanelStateArgs(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJsonValue(value: unknown, ancestors: Set<object>): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.every((entry) => isJsonValue(entry, ancestors))
    : Object.values(value).every((entry) => isJsonValue(entry, ancestors));
  ancestors.delete(value);
  return valid;
}

export function validatePanelLocation(location: PanelLocation): void {
  if (!SOURCE_RE.test(location.source)) {
    throw new Error("Panel source must be a canonical two-segment workspace source");
  }
  for (const [label, value, maxLength] of [
    ["workspace", location.workspace, 256],
    ["ref", location.ref, 1024],
    ["contextId", location.contextId, 1024],
    ["name", location.name, 256],
  ] as const) {
    if (value !== undefined && !isSafeText(value, maxLength)) {
      throw new Error(`Panel ${label} is empty, too long, or contains control characters`);
    }
  }
  if (
    location.disposition !== undefined &&
    location.disposition !== "current" &&
    location.disposition !== "child" &&
    location.disposition !== "root"
  ) {
    throw new Error("Panel disposition must be current, child, or root");
  }
  if (location.placement !== undefined) {
    const { disposition, preferredWidth, minWidth } = location.placement;
    if (
      disposition !== undefined &&
      disposition !== "side" &&
      disposition !== "replace" &&
      disposition !== "split-below"
    ) {
      throw new Error("Panel placement must be side, replace, or split-below");
    }
    for (const [label, value] of [
      ["preferredWidth", preferredWidth],
      ["minWidth", minWidth],
    ] as const) {
      if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
        throw new Error(`Panel ${label} must be a positive finite number`);
      }
    }
  }
  if (location.stateArgs !== undefined) {
    if (!isPanelStateArgs(location.stateArgs)) {
      throw new Error("Panel stateArgs must be a JSON object");
    }
    if (!isJsonValue(location.stateArgs, new Set())) {
      throw new Error("Panel stateArgs must contain only finite JSON values");
    }
    let encoded: string;
    try {
      encoded = JSON.stringify(location.stateArgs);
    } catch {
      throw new Error("Panel stateArgs must be JSON-serializable");
    }
    if (encoded === undefined || encoded.length > MAX_PANEL_LOCATION_PARAMS_LENGTH) {
      throw new Error("Panel stateArgs exceeds the panel-link size limit");
    }
  }
}

function encodePanelLocationParams(location: PanelLocation): string {
  validatePanelLocation(location);
  const pairs: Array<[string, string]> = [
    ["v", String(PANEL_LOCATION_PROTOCOL_VERSION)],
    ["source", location.source],
  ];
  if (location.workspace !== undefined) pairs.push(["workspace", location.workspace]);
  if (location.ref !== undefined) pairs.push(["ref", location.ref]);
  if (location.contextId !== undefined) pairs.push(["contextId", location.contextId]);
  if (location.stateArgs !== undefined) {
    pairs.push(["stateArgs", JSON.stringify(location.stateArgs)]);
  }
  if (location.name !== undefined) pairs.push(["name", location.name]);
  if (location.focus !== undefined) pairs.push(["focus", String(location.focus)]);
  if (location.disposition !== undefined) pairs.push(["disposition", location.disposition]);
  if (location.placement?.disposition !== undefined) {
    pairs.push(["placement", location.placement.disposition]);
  }
  if (location.placement?.preferredWidth !== undefined) {
    pairs.push(["preferredWidth", String(location.placement.preferredWidth)]);
  }
  if (location.placement?.minWidth !== undefined) {
    pairs.push(["minWidth", String(location.placement.minWidth)]);
  }
  const encoded = pairs
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  if (encoded.length > MAX_PANEL_LOCATION_PARAMS_LENGTH) {
    throw new Error("Panel link exceeds the panel-link size limit");
  }
  return encoded;
}

export function createPanelLocationLink(
  location: PanelLocation,
  carrier: PanelLocationCarrier = "scheme"
): string {
  const params = encodePanelLocationParams(location);
  return carrier === "https"
    ? `${PAIR_LINK_ORIGIN}${PANEL_SHARE_LINK_PATH}#${params}`
    : `vibestudio://${PANEL_DEEP_LINK_HOST}?${params}`;
}

export function createPanelDeepLink(location: PanelLocation): string {
  return createPanelLocationLink(location, "scheme");
}

export function createPanelShareUrl(location: PanelLocation): string {
  return createPanelLocationLink(location, "https");
}

function decodeParams(raw: string): Map<string, string> | string {
  if (!raw || raw.length > MAX_PANEL_LOCATION_PARAMS_LENGTH) {
    return "Panel link is missing parameters or exceeds the size limit";
  }
  const values = new Map<string, string>();
  for (const part of raw.split("&")) {
    if (!part) return "Panel link contains an empty parameter";
    const separator = part.indexOf("=");
    if (separator <= 0) return "Panel link contains a malformed parameter";
    let key: string;
    let value: string;
    try {
      key = decodeURIComponent(part.slice(0, separator).replace(/\+/g, " "));
      value = decodeURIComponent(part.slice(separator + 1).replace(/\+/g, " "));
    } catch {
      return "Panel link contains invalid percent encoding";
    }
    if (!PARAMETER_KEYS.has(key)) return `Panel link contains unknown parameter \`${key}\``;
    if (values.has(key)) return `Panel link contains duplicate parameter \`${key}\``;
    values.set(key, value);
  }
  return values;
}

export function parsePanelLocationLink(raw: string): ParsedPanelLocationLink {
  if (typeof raw !== "string") return { kind: "error", reason: "Panel link must be a string" };
  const schemePrefix = `vibestudio://${PANEL_DEEP_LINK_HOST}?`;
  const httpsPrefix = `${PAIR_LINK_ORIGIN}${PANEL_SHARE_LINK_PATH}`;
  let rawParams: string;
  let carrier: PanelLocationCarrier;
  if (raw.startsWith(schemePrefix)) {
    // Manual parsing keeps this path compatible with React Native/Hermes,
    // whose URL implementation has historically rejected custom schemes.
    rawParams = raw.slice(schemePrefix.length);
    carrier = "scheme";
  } else if (raw.startsWith(httpsPrefix)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { kind: "error", reason: "Panel share URL is not a valid URL" };
    }
    if (url.origin !== PAIR_LINK_ORIGIN || url.pathname !== PANEL_SHARE_LINK_PATH || url.search) {
      return { kind: "error", reason: "Not a canonical Vibestudio panel share URL" };
    }
    if (!url.hash || url.hash === "#") {
      return { kind: "error", reason: "Panel share URL is missing its location fragment" };
    }
    rawParams = url.hash.slice(1);
    carrier = "https";
  } else {
    return { kind: "error", reason: "Not a Vibestudio panel link" };
  }

  const decoded = decodeParams(rawParams);
  if (typeof decoded === "string") return { kind: "error", reason: decoded };
  if (decoded.get("v") !== String(PANEL_LOCATION_PROTOCOL_VERSION)) {
    return {
      kind: "error",
      reason: `Unsupported panel-link protocol version (expected v=${PANEL_LOCATION_PROTOCOL_VERSION})`,
    };
  }
  const source = decoded.get("source");
  if (!source) return { kind: "error", reason: "Panel link is missing `source`" };

  const focusValue = decoded.get("focus");
  if (focusValue !== undefined && focusValue !== "true" && focusValue !== "false") {
    return { kind: "error", reason: "Panel link `focus` must be true or false" };
  }
  const dispositionValue = decoded.get("disposition");
  if (
    dispositionValue !== undefined &&
    dispositionValue !== "current" &&
    dispositionValue !== "child" &&
    dispositionValue !== "root"
  ) {
    return { kind: "error", reason: "Panel link has an invalid disposition" };
  }
  const placementValue = decoded.get("placement");
  if (
    placementValue !== undefined &&
    placementValue !== "side" &&
    placementValue !== "replace" &&
    placementValue !== "split-below"
  ) {
    return { kind: "error", reason: "Panel link has an invalid placement" };
  }
  const parsePositiveNumber = (key: "preferredWidth" | "minWidth"): number | string | undefined => {
    const raw = decoded.get(key);
    if (raw === undefined) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0
      ? value
      : `Panel link \`${key}\` must be a positive finite number`;
  };
  const preferredWidth = parsePositiveNumber("preferredWidth");
  if (typeof preferredWidth === "string") return { kind: "error", reason: preferredWidth };
  const minWidth = parsePositiveNumber("minWidth");
  if (typeof minWidth === "string") return { kind: "error", reason: minWidth };

  let stateArgs: Record<string, unknown> | undefined;
  const rawStateArgs = decoded.get("stateArgs");
  if (rawStateArgs !== undefined) {
    try {
      const parsed = JSON.parse(rawStateArgs) as unknown;
      if (!isPanelStateArgs(parsed)) {
        return { kind: "error", reason: "Panel link stateArgs must be a JSON object" };
      }
      stateArgs = parsed;
    } catch {
      return { kind: "error", reason: "Panel link stateArgs is not valid JSON" };
    }
  }

  const location: PanelLocation = {
    source,
    ...(decoded.get("workspace") !== undefined ? { workspace: decoded.get("workspace") } : {}),
    ...(decoded.get("ref") !== undefined ? { ref: decoded.get("ref") } : {}),
    ...(decoded.get("contextId") !== undefined ? { contextId: decoded.get("contextId") } : {}),
    ...(stateArgs !== undefined ? { stateArgs } : {}),
    ...(decoded.get("name") !== undefined ? { name: decoded.get("name") } : {}),
    ...(focusValue !== undefined ? { focus: focusValue === "true" } : {}),
    ...(dispositionValue !== undefined
      ? { disposition: dispositionValue as PanelDisposition }
      : {}),
    ...(placementValue !== undefined || preferredWidth !== undefined || minWidth !== undefined
      ? {
          placement: {
            ...(placementValue !== undefined
              ? {
                  disposition: placementValue as NonNullable<PanelPlacementHint["disposition"]>,
                }
              : {}),
            ...(preferredWidth !== undefined ? { preferredWidth } : {}),
            ...(minWidth !== undefined ? { minWidth } : {}),
          },
        }
      : {}),
  };
  try {
    validatePanelLocation(location);
  } catch (error) {
    return { kind: "error", reason: error instanceof Error ? error.message : String(error) };
  }
  return { kind: "ok", location, carrier };
}

export function tryParsePanelLocationLink(raw: string): PanelLocation | null {
  const parsed = parsePanelLocationLink(raw);
  return parsed.kind === "ok" ? parsed.location : null;
}
