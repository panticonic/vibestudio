import type { UnitAuthorityManifest, UnitAuthorityRequest } from "./authorityManifest.js";
import { hostCapabilityPresentation } from "./authority/hostCapabilityPresentations.js";
import {
  HOST_SEMANTIC_CAPABILITY_COPY,
  type EditableCapabilityCopy,
} from "./hostApprovalCopy.js";
import { authorityRow, type AuthorityRow } from "./authority/authorityRows.js";
import { diffAuthorityRows, type AuthorityRowDiff } from "./authority/authorityRowDiff.js";
import type {
  AuthorityDomainId,
  AuthorityVerb,
} from "./authority/capabilityDomains.js";

export interface CapabilityPresentation extends EditableCapabilityCopy {
  authorityCategory?: { domain: AuthorityDomainId; verb: AuthorityVerb; declaredBy?: string };
}

export type CapabilityRequesterKind =
  | "app"
  | "panel"
  | "worker"
  | "extension"
  | "scheduled-job"
  | "agent-heartbeat"
  | "durable-object";

export type CapabilityPresentationResolver = (
  capability: string,
  requesterKind?: CapabilityRequesterKind
) => CapabilityPresentation;

export function summarizeAuthorityRequests(
  requests: readonly UnitAuthorityRequest[],
  previous: readonly UnitAuthorityRequest[] = [],
  presentationFor?: (capability: string) => CapabilityPresentation
): {
  requests: readonly UnitAuthorityRequest[];
  rows: AuthorityRow[];
  diff: AuthorityRowDiff;
} {
  const projectRows = (scopes: readonly UnitAuthorityRequest[]) =>
    scopes.map((request) => {
      const presentation = (presentationFor ?? describeCapability)(request.capability);
      return authorityRow({
        capability: request.capability,
        resource: request.resource,
        tier: request.tier,
        statement: "declared",
        provenance: {
          source: "manifest",
          ...(presentation.authorityCategory?.declaredBy
            ? { surface: `declared by ${presentation.authorityCategory.declaredBy}` }
            : {}),
        },
        ...(presentation.authorityCategory
          ? {
              category: presentation.authorityCategory,
              reviewedAction: presentation.action,
            }
          : {}),
      });
    });
  const rows = projectRows(requests);
  const previousRows = projectRows(previous);
  return {
    requests,
    rows,
    diff: diffAuthorityRows(previousRows, rows),
  };
}

/** One progressive-disclosure review for installed code's declared effects. */
export function summarizeAuthorityManifest(
  manifest: UnitAuthorityManifest,
  previous: UnitAuthorityManifest = { requests: [] },
  presentationFor?: (capability: string) => CapabilityPresentation
) {
  return summarizeAuthorityRequests(manifest.requests, previous.requests, presentationFor);
}

export function describeCapability(
  capability: string,
  requesterKind?: CapabilityRequesterKind
): CapabilityPresentation {
  const semantic = HOST_SEMANTIC_CAPABILITY_COPY.find(({ prefix }) =>
    prefix.endsWith(":")
      ? capability.startsWith(prefix)
      : capability === prefix || capability.startsWith(`${prefix}:`)
  );
  if (semantic) {
    if (semantic.prefix === "workspace-service:") {
      const name = capability.slice(semantic.prefix.length);
      const service = humanize(name);
      return renderRequester(
        {
          ...semantic.presentation,
          title: `Use ${service}`,
          action: `use ${service}`,
        },
        requesterKind
      );
    }
    return renderRequester(semantic.presentation, requesterKind);
  }
  const reviewedHostEffect = hostCapabilityPresentation(capability);
  if (reviewedHostEffect) return renderRequester(reviewedHostEffect, requesterKind);
  if (capability.startsWith("service:")) {
    const address = capability.slice("service:".length);
    const separator = address.lastIndexOf(".");
    const service = separator < 0 ? address : address.slice(0, separator);
    const method = separator < 0 ? address : address.slice(separator + 1);
    return {
      group: "runtime",
      title: humanize(method),
      action: lowerFirst(humanize(method)),
      description: `Call the ${humanize(method).toLowerCase()} operation provided by ${humanize(service)}`,
    };
  }
  if (capability.startsWith("rpc:")) {
    const method = capability.slice("rpc:".length);
    return {
      group: "runtime",
      title: humanize(method),
      action: lowerFirst(humanize(method)),
      description: "Direct runtime operation retained as an audit label during semantic migration",
    };
  }
  return renderRequester(
    {
      group: "other",
      title: humanize(capability),
      action: lowerFirst(humanize(capability)),
      description: "Explicit capability requested by {requesterKind}",
    },
    requesterKind
  );
}

export function createCapabilityPresentationResolver(
  services: () => readonly {
    name: string;
    title?: string;
    action?: string;
    description?: string;
    presentation?: { domain: AuthorityDomainId; verb: AuthorityVerb };
    source?: string;
  }[]
): CapabilityPresentationResolver {
  return (capability, requesterKind) => {
    if (!capability.startsWith("workspace-service:")) {
      return describeCapability(capability, requesterKind);
    }
    const name = capability.slice("workspace-service:".length);
    const service = services().find((candidate) => candidate.name === name);
    if (!service) return describeCapability(capability, requesterKind);
    const title = service.title?.trim() || humanize(name);
    const action = service.action?.trim() || `use ${lowerFirst(title)}`;
    const description = service.description?.trim() || `Use the ${title} service in this workspace`;
    return {
      group: "runtime",
      title: `${title[0]!.toUpperCase()}${title.slice(1)}`,
      action,
      description,
      ...(service.presentation
        ? {
            authorityCategory: {
              ...service.presentation,
              ...(service.source ? { declaredBy: service.source } : {}),
            },
          }
        : {}),
    };
  };
}

function renderRequester(
  presentation: CapabilityPresentation,
  requesterKind?: CapabilityRequesterKind
): CapabilityPresentation {
  const requesterKindLabel = requesterKind
    ? `this ${requesterKind === "durable-object" ? "background process" : requesterKind.replace(/-/gu, " ")}`
    : "the requester";
  const description = presentation.description
    .replace(/\{requesterKind\}/gu, requesterKindLabel)
    .replace(/this unit/gu, requesterKindLabel);
  return description === presentation.description ? presentation : { ...presentation, description };
}

function humanize(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._:/#-]+/g, " ")
    .trim()
    .replace(/^./, (character) => character.toUpperCase());
}

function lowerFirst(value: string): string {
  return value.length === 0 ? value : `${value[0]!.toLowerCase()}${value.slice(1)}`;
}
