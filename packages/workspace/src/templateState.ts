import {
  canonicalJson,
  compareUtf16CodeUnits,
  sha256HexSyncText,
} from "@vibestudio/content-addressing";
import {
  WorkspaceTemplateDeclarationSchema,
  WorkspaceTemplatePinSchema,
  WorkspaceTemplateStateSchema,
} from "@vibestudio/workspace-contracts/workspaceConfigSchema";
import type {
  WorkspaceTemplateDeclaration,
  WorkspaceTemplatePin,
  WorkspaceTemplateState,
  WorkspaceTemplatesConfig,
} from "@vibestudio/workspace-contracts/types";
import { normalizeTemplateGitUrl } from "./templateCoordinates.js";

/** Workspace-authored inputs to template resolution. */
export interface TemplateStateDeclaration {
  roots: WorkspaceTemplateDeclaration[];
  overrides: Record<string, WorkspaceTemplatePin>;
}

export interface TemplateStateDeclarationInput {
  use?: readonly WorkspaceTemplateDeclaration[];
  overrides?: Readonly<Record<string, WorkspaceTemplatePin>>;
}

function normalizedPin(input: WorkspaceTemplatePin): WorkspaceTemplatePin {
  const pin = WorkspaceTemplatePinSchema.parse(input);
  return { ...pin, url: normalizeTemplateGitUrl(pin.url) };
}

function normalizedDeclaration(input: WorkspaceTemplateDeclaration): WorkspaceTemplateDeclaration {
  const declaration = WorkspaceTemplateDeclarationSchema.parse(input);
  return { ...declaration, url: normalizeTemplateGitUrl(declaration.url) };
}

/**
 * Normalize the workspace's relationship declaration. This rejects ambiguous
 * authored input, not workspace drift or historical-content differences.
 */
export function normalizeTemplateStateDeclaration(
  templates: TemplateStateDeclarationInput | WorkspaceTemplatesConfig | undefined
): TemplateStateDeclaration {
  const rootsByUrl = new Map<string, WorkspaceTemplateDeclaration>();
  for (const raw of templates?.use ?? []) {
    const declaration = normalizedDeclaration(raw);
    const existing = rootsByUrl.get(declaration.url);
    if (existing && canonicalJson(existing) !== canonicalJson(declaration)) {
      throw new Error(`Template roots use incompatible credentials for ${declaration.url}`);
    }
    rootsByUrl.set(declaration.url, declaration);
  }

  const roots = [...rootsByUrl.values()].sort((left, right) =>
    compareUtf16CodeUnits(left.url, right.url)
  );
  const overrideEntries: [string, WorkspaceTemplatePin][] = [];
  for (const [declaredUrl, raw] of Object.entries(templates?.overrides ?? {})) {
    const url = normalizeTemplateGitUrl(declaredUrl);
    const pin = normalizedPin(raw);
    if (url !== pin.url) {
      throw new Error(`Template override ${declaredUrl} points at ${raw.url}`);
    }
    overrideEntries.push([url, pin]);
  }
  overrideEntries.sort(([left], [right]) => compareUtf16CodeUnits(left, right));
  return { roots, overrides: Object.fromEntries(overrideEntries) };
}

/**
 * Read descriptive relationship state. There is deliberately no fingerprint,
 * graph-integrity proof, or fragment verification: current workspace content
 * wins and ordinary VCS handles divergence.
 */
export function parseTemplateState(input: unknown): WorkspaceTemplateState {
  return WorkspaceTemplateStateSchema.parse(input) as WorkspaceTemplateState;
}

/** Bind a reviewed suggestion decision to the exact value the user saw. */
export function templateSuggestionDigest(
  nodeId: string,
  section: "trust" | "providers",
  value: unknown
): `v1-sha256:${string}` {
  return `v1-sha256:${sha256HexSyncText(
    canonicalJson({ protocol: "template-suggestion-v1", nodeId, section, value })
  )}`;
}
