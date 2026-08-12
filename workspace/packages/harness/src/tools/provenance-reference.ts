import type { VcsSemanticNodeRef } from "@vibestudio/service-schemas/vcs";
import {
  loadAgentReference,
  type AgentReferenceStore,
} from "./agent-pagination.js";

const PROVENANCE_REFERENCE_DOMAIN = "provenance-subject";

export interface ProvenanceReferenceBasis {
  root: VcsSemanticNodeRef;
  limit: number;
  stream?: "adjacency" | "file-history";
  page?: number;
  cursor?: string;
}

/** Retain the exact graph subject and its page geometry behind one model-safe ref. */
export function putProvenanceReference(
  references: AgentReferenceStore,
  root: VcsSemanticNodeRef,
  limit: number,
  continuation?: { stream: "adjacency" | "file-history"; page: number; cursor: string }
): string {
  return references.put(PROVENANCE_REFERENCE_DOMAIN, {
    root,
    limit,
    ...(continuation ?? {}),
  });
}

export function loadProvenanceReference(
  references: AgentReferenceStore,
  ref: string
): ProvenanceReferenceBasis {
  return loadAgentReference<ProvenanceReferenceBasis>(
    references,
    PROVENANCE_REFERENCE_DOMAIN,
    ref
  );
}
