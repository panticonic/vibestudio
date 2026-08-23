/**
 * Shell-owned surfaces a caller may ask the host to open, and the deep links
 * that reach them from outside a session.
 *
 * One descriptor, three carriers: `app.openShellSurface(target)` from inside
 * the workspace, `vibestudio://…` from the OS, and `https://vibestudio.app/…`
 * share links. The host validates every form here before it touches the shell.
 *
 *   vibestudio://ask?v=1&panel=<slotId>&mode=quickfire&prompt=…   command agent
 *   vibestudio://about?v=1&page=permissions                        About page
 *   vibestudio://command?v=1&panel=<slotId>&id=<commandId>         panel host command
 *   vibestudio://surface?v=1&kind=settings&section=devices         management chrome
 *
 * Nothing here grants anything: a prompt only pre-fills the compose box, a
 * command runs only if the named panel still contributes it, and every surface
 * is first-party chrome the user can already reach by hand.
 */

import { PAIR_LINK_ORIGIN } from "./connect.js";

export const SHELL_SURFACE_PROTOCOL_VERSION = 1 as const;
export const MAX_SHELL_SURFACE_PARAMS_LENGTH = 8 * 1024;
export const MAX_SHELL_SURFACE_PROMPT_LENGTH = 4_000;

export type CommandAgentMode = "all" | "commands" | "goto" | "quickfire";
export const COMMAND_AGENT_MODES: readonly CommandAgentMode[] = [
  "all",
  "commands",
  "goto",
  "quickfire",
];

export const SETTINGS_SECTIONS = [
  "connection",
  "devices",
  "profile",
  "appearance",
  "apps",
  "hosts",
  "templates",
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export type ManagementSurface = "settings" | "workspace-chooser";
export const MANAGEMENT_SURFACES: readonly ManagementSurface[] = ["settings", "workspace-chooser"];

/** The object forms; the two management surfaces may also be passed as bare strings. */
export type ShellSurfaceDescriptor =
  | { kind: "settings"; section?: SettingsSection }
  | { kind: "workspace-chooser" }
  | {
      kind: "command-agent";
      /** Panel slot id the overlay is about; the focused panel when omitted. */
      panelId?: string;
      mode?: CommandAgentMode;
      /** Pre-filled compose text. The user still presses send. */
      prompt?: string;
    }
  | { kind: "about"; page: string }
  | { kind: "panel-command"; panelId: string; commandId: string };

export type ShellSurfaceTarget = ManagementSurface | ShellSurfaceDescriptor;
export type ShellSurfaceKind = ShellSurfaceDescriptor["kind"];
export const SHELL_SURFACE_KINDS: readonly ShellSurfaceKind[] = [
  "settings",
  "workspace-chooser",
  "command-agent",
  "about",
  "panel-command",
];

export type ShellSurfaceCarrier = "scheme" | "https";

/** Link host (scheme) / path (https) per descriptor kind. */
const LINK_HOSTS: Record<ShellSurfaceKind, string> = {
  settings: "surface",
  "workspace-chooser": "surface",
  "command-agent": "ask",
  about: "about",
  "panel-command": "command",
};
const LINK_HOST_SET = new Set(Object.values(LINK_HOSTS));

const PAGE_RE = /^[a-z][a-z0-9-]*$/;
const PANEL_ID_MAX = 512;
const COMMAND_ID_MAX = 256;

function isSafeText(value: string, maxLength: number): boolean {
  if (value.length === 0 || value.length > maxLength) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if ((code <= 0x1f && code !== 0x0a) || code === 0x7f) return false;
  }
  return true;
}

/** Canonical object form of a target. */
export function normalizeShellSurfaceTarget(target: ShellSurfaceTarget): ShellSurfaceDescriptor {
  return typeof target === "string" ? { kind: target } : target;
}

/** Throws with an actionable message when a target is malformed. */
export function validateShellSurfaceTarget(target: unknown): ShellSurfaceDescriptor {
  if (typeof target === "string") {
    if (!(MANAGEMENT_SURFACES as readonly string[]).includes(target)) {
      throw new Error(`Unknown shell surface "${target}"`);
    }
    return { kind: target as ManagementSurface };
  }
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    throw new Error("Shell surface target must be a string or an object with a kind");
  }
  const record = target as Record<string, unknown>;
  const kind = record["kind"];
  if (typeof kind !== "string" || !(SHELL_SURFACE_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`Unknown shell surface kind "${String(kind)}"`);
  }
  const allowed: Record<ShellSurfaceKind, readonly string[]> = {
    settings: ["kind", "section"],
    "workspace-chooser": ["kind"],
    "command-agent": ["kind", "panelId", "mode", "prompt"],
    about: ["kind", "page"],
    "panel-command": ["kind", "panelId", "commandId"],
  };
  for (const key of Object.keys(record)) {
    if (!allowed[kind as ShellSurfaceKind].includes(key)) {
      throw new Error(`Shell surface "${kind}" does not accept "${key}"`);
    }
  }
  switch (kind as ShellSurfaceKind) {
    case "settings": {
      const section = record["section"];
      if (section !== undefined && !(SETTINGS_SECTIONS as readonly unknown[]).includes(section)) {
        throw new Error("Shell settings section is not recognized");
      }
      return {
        kind: "settings",
        ...(section !== undefined ? { section: section as SettingsSection } : {}),
      };
    }
    case "workspace-chooser":
      return { kind: kind as ManagementSurface };
    case "command-agent": {
      const { panelId, mode, prompt } = record;
      if (
        panelId !== undefined &&
        (typeof panelId !== "string" || !isSafeText(panelId, PANEL_ID_MAX))
      ) {
        throw new Error("Shell surface panelId must be a non-empty panel slot id");
      }
      if (mode !== undefined && !(COMMAND_AGENT_MODES as readonly unknown[]).includes(mode)) {
        throw new Error("Shell surface mode must be all, commands, goto, or quickfire");
      }
      if (
        prompt !== undefined &&
        (typeof prompt !== "string" || !isSafeText(prompt, MAX_SHELL_SURFACE_PROMPT_LENGTH))
      ) {
        throw new Error(
          `Shell surface prompt must be 1–${MAX_SHELL_SURFACE_PROMPT_LENGTH} characters`
        );
      }
      return {
        kind: "command-agent",
        ...(panelId !== undefined ? { panelId: panelId as string } : {}),
        ...(mode !== undefined ? { mode: mode as CommandAgentMode } : {}),
        ...(prompt !== undefined ? { prompt: prompt as string } : {}),
      };
    }
    case "about": {
      const page = record["page"];
      if (typeof page !== "string" || !PAGE_RE.test(page) || page.length > 64) {
        throw new Error("Shell surface page must be a kebab-case About page id");
      }
      return { kind: "about", page };
    }
    case "panel-command": {
      const { panelId, commandId } = record;
      if (typeof panelId !== "string" || !isSafeText(panelId, PANEL_ID_MAX)) {
        throw new Error("Shell surface panelId must be a non-empty panel slot id");
      }
      if (typeof commandId !== "string" || !isSafeText(commandId, COMMAND_ID_MAX)) {
        throw new Error("Shell surface commandId must be a non-empty command id");
      }
      return { kind: "panel-command", panelId, commandId };
    }
  }
}

function encodeParams(descriptor: ShellSurfaceDescriptor): string {
  const pairs: Array<[string, string]> = [["v", String(SHELL_SURFACE_PROTOCOL_VERSION)]];
  switch (descriptor.kind) {
    case "settings":
      pairs.push(["kind", descriptor.kind]);
      if (descriptor.section !== undefined) pairs.push(["section", descriptor.section]);
      break;
    case "workspace-chooser":
      pairs.push(["kind", descriptor.kind]);
      break;
    case "command-agent":
      if (descriptor.panelId !== undefined) pairs.push(["panel", descriptor.panelId]);
      if (descriptor.mode !== undefined) pairs.push(["mode", descriptor.mode]);
      if (descriptor.prompt !== undefined) pairs.push(["prompt", descriptor.prompt]);
      break;
    case "about":
      pairs.push(["page", descriptor.page]);
      break;
    case "panel-command":
      pairs.push(["panel", descriptor.panelId], ["id", descriptor.commandId]);
      break;
  }
  const encoded = pairs
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  if (encoded.length > MAX_SHELL_SURFACE_PARAMS_LENGTH) {
    throw new Error("Shell surface link exceeds the size limit");
  }
  return encoded;
}

export function createShellSurfaceLink(
  target: ShellSurfaceTarget,
  carrier: ShellSurfaceCarrier = "scheme"
): string {
  const descriptor = validateShellSurfaceTarget(target);
  const host = LINK_HOSTS[descriptor.kind];
  const params = encodeParams(descriptor);
  return carrier === "https"
    ? `${PAIR_LINK_ORIGIN}/${host}#${params}`
    : `vibestudio://${host}?${params}`;
}

export type ParsedShellSurfaceLink =
  | { kind: "ok"; target: ShellSurfaceDescriptor; carrier: ShellSurfaceCarrier }
  | { kind: "error"; reason: string }
  /** A well-formed link to something else (a panel, a pairing link). */
  | { kind: "unrelated" };

function decodeParams(raw: string): Map<string, string> | string {
  if (!raw || raw.length > MAX_SHELL_SURFACE_PARAMS_LENGTH) {
    return "Shell surface link is missing parameters or exceeds the size limit";
  }
  const values = new Map<string, string>();
  for (const part of raw.split("&")) {
    if (!part) return "Shell surface link contains an empty parameter";
    const separator = part.indexOf("=");
    if (separator <= 0) return "Shell surface link contains a malformed parameter";
    let key: string;
    let value: string;
    try {
      key = decodeURIComponent(part.slice(0, separator).replace(/\+/g, " "));
      value = decodeURIComponent(part.slice(separator + 1).replace(/\+/g, " "));
    } catch {
      return "Shell surface link contains invalid percent encoding";
    }
    if (values.has(key)) return `Shell surface link contains duplicate parameter \`${key}\``;
    values.set(key, value);
  }
  return values;
}

export function parseShellSurfaceLink(raw: string): ParsedShellSurfaceLink {
  if (typeof raw !== "string")
    return { kind: "error", reason: "Shell surface link must be a string" };
  let host: string;
  let rawParams: string;
  let carrier: ShellSurfaceCarrier;
  const schemeMatch = /^vibestudio:\/\/([a-z-]+)\?(.*)$/s.exec(raw);
  if (schemeMatch) {
    host = schemeMatch[1]!;
    rawParams = schemeMatch[2]!;
    carrier = "scheme";
    if (!LINK_HOST_SET.has(host)) return { kind: "unrelated" };
  } else if (raw.startsWith(`${PAIR_LINK_ORIGIN}/`)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { kind: "error", reason: "Shell surface URL is not a valid URL" };
    }
    host = url.pathname.slice(1);
    if (url.origin !== PAIR_LINK_ORIGIN || !LINK_HOST_SET.has(host)) return { kind: "unrelated" };
    if (url.search)
      return {
        kind: "error",
        reason: "Shell surface URL must carry its parameters in the fragment",
      };
    if (!url.hash || url.hash === "#")
      return { kind: "error", reason: "Shell surface URL is missing its fragment" };
    rawParams = url.hash.slice(1);
    carrier = "https";
  } else {
    return { kind: "unrelated" };
  }

  const decoded = decodeParams(rawParams);
  if (typeof decoded === "string") return { kind: "error", reason: decoded };
  if (decoded.get("v") !== String(SHELL_SURFACE_PROTOCOL_VERSION)) {
    return {
      kind: "error",
      reason: `Unsupported shell-surface link version (expected v=${SHELL_SURFACE_PROTOCOL_VERSION})`,
    };
  }
  let candidate: Record<string, unknown>;
  switch (host) {
    case "surface":
      candidate = {
        kind: decoded.get("kind"),
        ...(decoded.has("section") ? { section: decoded.get("section") } : {}),
      };
      break;
    case "ask":
      candidate = {
        kind: "command-agent",
        ...(decoded.has("panel") ? { panelId: decoded.get("panel") } : {}),
        ...(decoded.has("mode") ? { mode: decoded.get("mode") } : {}),
        ...(decoded.has("prompt") ? { prompt: decoded.get("prompt") } : {}),
      };
      break;
    case "about":
      candidate = { kind: "about", page: decoded.get("page") };
      break;
    case "command":
      candidate = {
        kind: "panel-command",
        panelId: decoded.get("panel"),
        commandId: decoded.get("id"),
      };
      break;
    default:
      return { kind: "unrelated" };
  }
  const known = new Set(["v", "kind", "section", "panel", "mode", "prompt", "page", "id"]);
  for (const key of decoded.keys()) {
    if (!known.has(key))
      return { kind: "error", reason: `Shell surface link contains unknown parameter \`${key}\`` };
  }
  try {
    return { kind: "ok", target: validateShellSurfaceTarget(candidate), carrier };
  } catch (error) {
    return { kind: "error", reason: error instanceof Error ? error.message : String(error) };
  }
}
