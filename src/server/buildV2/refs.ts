import { BuildRequestError } from "./diagnostics.js";

const VALID_REF_DESCRIPTION = `"main", "state:<stateHash>", or "ctx:<contextId>"`;

export function validateBuildRef(ref: string | undefined): string | undefined {
  if (!ref || ref === "main" || ref.startsWith("state:") || ref.startsWith("ctx:")) return ref;
  throw new BuildRequestError(
    "invalid_build_ref",
    `Invalid build ref "${ref}": expected ${VALID_REF_DESCRIPTION}. ` +
      `Git commit SHAs, branches, and tags are not GAD build refs; use ctx:<contextId> for ` +
      `unpublished context code, or an exact state: ref returned by a build/runtime API.`,
    { ref }
  );
}
