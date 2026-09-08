import { expect, type Locator, type Page } from "@playwright/test";
import {
  approvePendingWorkspaceCreationReview,
  getPanelTree,
  type TestApp,
} from "../../setup/electronSetup";

/** Find the actual hosted shell surface independent of whichever modal it currently presents. */
export async function findWorkspaceShellPage(app: TestApp): Promise<Page> {
  let shell: Page | undefined;
  await expect
    .poll(
      async () => {
        for (const candidate of app.app.context().pages()) {
          if (
            (await candidate.title()) === "@workspace-apps/shell" &&
            !candidate.url().includes("overlaySurface=")
          ) {
            shell = candidate;
            return true;
          }
        }
        return false;
      },
      { timeout: 30_000 }
    )
    .toBe(true);
  return shell!;
}

/** Settle every install review already published for the launch workspaces. */
export async function settleWorkspaceInstallReviews(
  app: TestApp,
  workspaceIds: readonly string[]
): Promise<void> {
  for (const workspaceId of workspaceIds) {
    const approvalIds = await app.app.evaluate(async (_electron, selectedWorkspaceId) => {
      const api = await globalThis.__testApi!.forWorkspace(selectedWorkspaceId);
      const pending = (await api.rpcCall("shellApproval", "listPending", [])) as Array<{
        kind: string;
        approvalId: string;
      }>;
      return pending
        .filter((approval) => approval.kind === "unit-install-review")
        .map((approval) => approval.approvalId);
    }, workspaceId);
    await approvePendingWorkspaceCreationReview({ app: app.app, workspaceId }, approvalIds);
  }
}

/** Present one exact pending approval without acting on any other queue entry. */
export async function presentApprovalCard(page: Page, approvalId: string): Promise<Locator> {
  const requested = page.locator(`[data-approval-id=${JSON.stringify(approvalId)}]`);
  const pill = page.locator("[data-approval-pill]");
  if (!(await page.locator("[data-approval-id]:visible").count())) {
    await expect(pill).toBeVisible({ timeout: 30_000 });
    await pill.click();
  }
  await expect(page.locator("[data-approval-id]:visible")).toHaveCount(1, { timeout: 30_000 });
  for (const direction of ["Next approval", "Previous approval"] as const) {
    const navigation = page.getByRole("button", { name: direction, exact: true });
    for (let index = 0; index < 100 && !(await requested.isVisible()); index += 1) {
      if (!(await navigation.count())) break;
      if (!(await navigation.isEnabled())) break;
      const prior = await page
        .locator("[data-approval-id]:visible")
        .getAttribute("data-approval-id");
      await navigation.click();
      await expect
        .poll(() => page.locator("[data-approval-id]:visible").getAttribute("data-approval-id"))
        .not.toBe(prior);
    }
  }
  await expect(requested).toBeVisible({ timeout: 30_000 });
  return requested;
}

/** Complete the product's reviewed creation flow and wait for its workspace to become active. */
export async function completeReviewedWorkspaceCreation(
  app: TestApp,
  workspaceId: string,
  page: Page,
  workspaceName: string,
  preexistingWorkspaceIds: readonly string[]
): Promise<void> {
  const owner = { app: app.app, workspaceId };
  const approvalId = await expect
    .poll(
      () =>
        owner.app.evaluate(async (_electron, workspaceId) => {
          const api = await globalThis.__testApi!.forWorkspace(workspaceId);
          const state = (await api.rpcCall(
            "shellApproval",
            "getWorkspaceCreationReviewState",
            []
          )) as
            | { status: "pending"; approvalId: string }
            | { status: "preparing" | "not-required" | "resolved" | "unresolved" }
            | { status: "failed"; error: string };
          if (state.status === "failed") {
            throw new Error(`Workspace creation review failed: ${state.error}`);
          }
          return state.status === "pending" ? state.approvalId : null;
        }, owner.workspaceId),
      { timeout: 120_000 }
    )
    .not.toBeNull()
    .then(() =>
      owner.app.evaluate(async (_electron, workspaceId) => {
        const api = await globalThis.__testApi!.forWorkspace(workspaceId);
        const state = (await api.rpcCall(
          "shellApproval",
          "getWorkspaceCreationReviewState",
          []
        )) as { status: string; approvalId?: string };
        if (state.status !== "pending" || !state.approvalId) {
          throw new Error(`Workspace creation review changed before presentation: ${state.status}`);
        }
        return state.approvalId;
      }, owner.workspaceId)
    );
  const review = await presentApprovalCard(page, approvalId);
  await review.getByRole("button", { name: "Add to workspace", exact: true }).click();
  await expect
    .poll(
      () =>
        owner.app.evaluate(async (_electron, workspaceId) => {
          const api = await globalThis.__testApi!.forWorkspace(workspaceId);
          const state = (await api.rpcCall(
            "shellApproval",
            "getWorkspaceCreationReviewState",
            []
          )) as
            | { status: "preparing" | "pending" | "not-required" | "resolved" | "unresolved" }
            | { status: "failed"; error: string };
          if (state.status === "failed") {
            throw new Error(`Workspace creation review failed: ${state.error}`);
          }
          return state.status;
        }, owner.workspaceId),
      { timeout: 120_000 }
    )
    .toBe("resolved");
  await expect
    .poll(async () => (await getPanelTree(owner)).length, { timeout: 120_000 })
    .toBeGreaterThan(0);
  // Launch workspaces can finish publishing their own install reviews while
  // the new workspace is building. Settle those exact owners before checking
  // the navigation that the new workspace review just activated.
  await settleWorkspaceInstallReviews(app, preexistingWorkspaceIds);
  const openWorkspace = page.getByRole("button", {
    name: `Open ${workspaceName}`,
    exact: true,
  });
  await expect(openWorkspace).toBeVisible({ timeout: 120_000 });
  await expect(openWorkspace).toHaveAttribute("aria-current", "location");
}
