const VALID_REF_DESCRIPTION = `"main", "state:<stateHash>", or "ctx:<contextId>"`;

export function validateBuildRef(ref: string | undefined): string | undefined {
  if (!ref || ref === "main" || ref.startsWith("state:") || ref.startsWith("ctx:")) return ref;
  throw new Error(
    `Invalid build ref "${ref}": expected ${VALID_REF_DESCRIPTION}. ` +
      `Git commit SHAs, branches, and tags are not GAD build refs; use a state hash from vcs.log as state:<hash>.`
  );
}
