import type { ServiceContext } from "./serviceDispatcher.js";

export const BROWSER_DATA_PROVIDER_RUNTIME_ID = "@workspace-extensions/browser-data";
export const BROWSER_DATA_PROVIDER_REPO_PATH = "extensions/browser-data";

/** Exact reviewed provider check shared by every protected browser-data host seam. */
export function isReviewedBrowserDataProvider(
  ctx: Pick<ServiceContext, "caller">,
  repoPath: string | null
): boolean {
  return (
    ctx.caller.runtime.kind === "extension" &&
    ctx.caller.runtime.id === BROWSER_DATA_PROVIDER_RUNTIME_ID &&
    ctx.caller.codeApproved === true &&
    ctx.caller.code?.callerId === ctx.caller.runtime.id &&
    repoPath === BROWSER_DATA_PROVIDER_REPO_PATH &&
    ctx.caller.code.repoPath === repoPath
  );
}
