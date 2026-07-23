import type {
  EvalCeilingPurpose,
  UnitAuthorityManifest,
  UnitAuthorityRequest,
} from "./authorityManifest.js";
import { hostCapabilityPresentation } from "./authority/hostCapabilityPresentations.js";
import {
  HOST_AUTHORITY_GROUP_COPY,
  HOST_SEMANTIC_CAPABILITY_COPY,
  type EditableCapabilityCopy,
} from "./hostApprovalCopy.js";

export interface AuthorityRequestGroup {
  id: string;
  label: string;
  description: string;
  requestCount: number;
  addedCount: number;
  items: Array<{
    capability: string;
    title: string;
    description: string;
    added: boolean;
  }>;
}

export interface CapabilityPresentation extends EditableCapabilityCopy {}

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
  groups: AuthorityRequestGroup[];
  removedCount: number;
} {
  const previousKeys = new Set(previous.map(scopeKey));
  const currentKeys = new Set(requests.map(scopeKey));
  const counts = new Map<
    string,
    {
      requestCount: number;
      addedCount: number;
      items: Map<string, AuthorityRequestGroup["items"][number]>;
    }
  >();
  for (const request of requests) {
    const presentation = (presentationFor ?? describeCapability)(request.capability);
    const id = presentation.group;
    const count = counts.get(id) ?? { requestCount: 0, addedCount: 0, items: new Map() };
    const added = !previousKeys.has(scopeKey(request));
    count.requestCount += 1;
    if (added) count.addedCount += 1;
    const existing = count.items.get(request.capability);
    count.items.set(request.capability, {
      capability: request.capability,
      title: presentation.title,
      description: presentation.description,
      added: added || existing?.added === true,
    });
    counts.set(id, count);
  }
  return {
    requests,
    groups: HOST_AUTHORITY_GROUP_COPY.flatMap(([id, label, description]) => {
      const count = counts.get(id);
      return count
        ? [
            {
              id,
              label,
              description,
              requestCount: count.requestCount,
              addedCount: count.addedCount,
              items: [...count.items.values()].sort((a, b) => a.title.localeCompare(b.title)),
            },
          ]
        : [];
    }),
    removedCount: previous.filter((request) => !currentKeys.has(scopeKey(request))).length,
  };
}

const EVAL_PURPOSE_LABELS: Record<EvalCeilingPurpose, string> = {
  "agentic-code-execution": "Code run by this agent",
  "tool-eval": "Code run by this tool",
  "test-eval": "Code run by this test",
};

/** One progressive-disclosure review for the complete authority contract.
 * Direct requests and eval ceilings deliberately stay distinct: accepting this
 * review admits the exact manifest version, but a ceiling still mints no grant. */
export function summarizeAuthorityManifest(
  manifest: UnitAuthorityManifest,
  previous: UnitAuthorityManifest = { requests: [], evalCeilings: [] },
  presentationFor?: (capability: string) => CapabilityPresentation
) {
  const direct = summarizeAuthorityRequests(manifest.requests, previous.requests, presentationFor);
  const previousByPurpose = new Map(
    previous.evalCeilings.map((ceiling) => [ceiling.purpose, ceiling.capabilities] as const)
  );
  const currentByPurpose = new Map(
    manifest.evalCeilings.map((ceiling) => [ceiling.purpose, ceiling.capabilities] as const)
  );
  const purposes = (Object.keys(EVAL_PURPOSE_LABELS) as EvalCeilingPurpose[]).filter(
    (purpose) => currentByPurpose.has(purpose) || previousByPurpose.has(purpose)
  );
  return {
    ...direct,
    evalCeilings: manifest.evalCeilings,
    eval: purposes.map((purpose) => {
      const review = summarizeAuthorityRequests(
        currentByPurpose.get(purpose) ?? [],
        previousByPurpose.get(purpose) ?? [],
        presentationFor
      );
      return {
        purpose,
        label: EVAL_PURPOSE_LABELS[purpose],
        groups: review.groups,
        removedCount: review.removedCount,
      };
    }),
  };
}

function scopeKey(scope: UnitAuthorityRequest): string {
  return `${scope.capability}\0${scope.tier}\0${scope.evidence}\0${JSON.stringify(scope.resource)}\0${JSON.stringify(scope.packages ?? [])}`;
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
  services: () => readonly { name: string; title?: string; action?: string; description?: string }[]
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
