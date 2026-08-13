import { HOST_SEMANTIC_CAPABILITY_COPY } from "../hostApprovalCopy.js";
import { generatedHostCapabilityCategory } from "./hostAuthorityCatalog.generated.js";
import { productBuiltinCategory } from "./productBuiltinIndex.js";

export const AUTHORITY_DOMAINS = {
  files: {
    label: "Your files & work",
    description: "Documents, code, and project content in your workspace",
  },
  sharing: {
    label: "Publishing & sending",
    description: "Anything that leaves your workspace: publishing, sending, posting",
  },
  accounts: {
    label: "Accounts & sign-ins",
    description: "Connected accounts, passwords, and credentials",
  },
  web: { label: "The web", description: "Browsing data, websites, and downloads" },
  automation: {
    label: "Apps & automation",
    description: "Installing, running, and scheduling apps and agents",
  },
  people: {
    label: "People & devices",
    description: "Workspace members, presence, and paired devices",
  },
  computer: {
    label: "This computer",
    description: "The Vibestudio application and the machine it runs on",
  },
  safety: {
    label: "Permissions and safety",
    description: "Your permission choices and the controls that enforce them",
  },
} as const;

export const AUTHORITY_VERBS = {
  see: { label: "See" },
  act: { label: "Do" },
  manage: { label: "Manage" },
} as const;

export type AuthorityDomainId = keyof typeof AUTHORITY_DOMAINS;
export type AuthorityVerb = keyof typeof AUTHORITY_VERBS;
export interface CapabilityDomain {
  domain: AuthorityDomainId;
  verb: AuthorityVerb;
}

export function capabilityDomain(capability: string): CapabilityDomain | null {
  const generated =
    productBuiltinCategory(capability) ?? generatedHostCapabilityCategory(capability);
  if (generated) return generated;
  return (
    HOST_SEMANTIC_CAPABILITY_COPY.find(({ prefix }) =>
      prefix.endsWith(":") || prefix.endsWith(".")
        ? capability.startsWith(prefix)
        : capability === prefix || capability.startsWith(`${prefix}:`)
    )?.authorityCategory ?? null
  );
}

export function isSafetyCapability(capability: string): boolean {
  return capabilityDomain(capability)?.domain === "safety";
}
