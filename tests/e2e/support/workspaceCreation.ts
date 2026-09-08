import { expect, type Locator, type Page } from "@playwright/test";
import {
  approvePendingWorkspaceCreationReview,
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
