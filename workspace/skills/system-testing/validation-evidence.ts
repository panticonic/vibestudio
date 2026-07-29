import {
  collectStoredValueRefs,
  hydrateStoredValueRefs,
  type BlobReader,
} from "@vibestudio/agentic-protocol";
import type { TestExecutionResult } from "./types.js";

/**
 * Materialize the canonical validation view without expanding the durable run
 * record. Trajectory request/result payloads are references by design; a
 * validator is an explicit semantic read boundary and must never have to know
 * whether evidence was stored inline or in the blobstore.
 */
export async function materializeValidationEvidence(
  execution: TestExecutionResult,
  reader?: BlobReader
): Promise<TestExecutionResult> {
  const refs = collectStoredValueRefs(execution);
  if (refs.length === 0) return execution;
  if (!reader) {
    throw new Error(
      `system-test validation evidence contains ${refs.length} stored value reference(s), ` +
        "but the headless runner did not provide its blob reader"
    );
  }
  return (await hydrateStoredValueRefs(execution, reader, {
    strict: true,
    context: "system-test validation evidence",
  })) as TestExecutionResult;
}
