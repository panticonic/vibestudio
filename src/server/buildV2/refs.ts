import { BuildRequestError } from "./diagnostics.js";

const VALID_REF_DESCRIPTION = `"main", "state:<stateHash>", or "ctx:<contextId>"`;
const CONTEXT_REF_PATTERN = /^ctx:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

export function validateBuildRef(ref: string | undefined): string | undefined {
  if (!ref || ref === "main" || ref.startsWith("state:") || CONTEXT_REF_PATTERN.test(ref)) {
    return ref;
  }
  throw new BuildRequestError(
    "invalid_build_ref",
    `Invalid build ref "${ref}": expected ${VALID_REF_DESCRIPTION}. ` +
      `Git commit SHAs, branches, and tags are not GAD build refs; use ctx:<contextId> for ` +
      `unpublished context code, or an exact state: ref returned by a build/runtime API.`,
    { ref }
  );
}

/** Context selectors are resolved with caller authority before entering the build engine. */
export function validateResolvedBuildRef(ref: string | undefined): string | undefined {
  const validated = validateBuildRef(ref);
  if (validated?.startsWith("ctx:")) {
    throw new BuildRequestError(
      "invalid_build_ref",
      "A context build requires its resolved immutable state",
      { ref },
    );
  }
  return validated;
}
