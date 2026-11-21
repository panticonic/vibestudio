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
            candidate.url().startsWith("vs-client://") &&
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

/** Make the real first-start choice before testing another foreground interaction. */
export async function declineFirstRunReporting(app: TestApp): Promise<void> {
  const shell = await findWorkspaceShellPage(app);
  const consent = shell.getByRole("dialog", { name: "Help Vibestudio improve", exact: true });
  await expect(consent).toBeVisible({ timeout: 30_000 });
  await consent.getByRole("button", { name: "Keep automatic reports off", exact: true }).click();
  await expect(consent).toBeHidden({ timeout: 30_000 });
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

/** Present one exact approval on the surface that currently owns its UI. */
export async function presentApprovalCard(page: Page, approvalId: string): Promise<Locator> {
  const candidates = () => [
    page,
    ...page
      .context()
      .pages()
      .filter(
        (candidate) =>
          candidate !== page &&
          candidate.url().includes("#overlaySurface=approval")
      ),
  ].filter((candidate) => !candidate.isClosed());
  const cardSelector = "[data-approval-id]";
  const requestedSelector = `[data-approval-id=${JSON.stringify(approvalId)}]`;
  const visible = async (selector: string) => {
    for (const surface of candidates()) {
      const locator = surface.locator(`${selector}:visible`).first();
      if (await locator.isVisible()) return { surface, locator };
    }
    return null;
  };
  const exact = await visible(requestedSelector);
  if (exact) return exact.locator;

  // A collapsed queue and its expanded card may be on different native
  // surfaces. Rediscover the live owner after opening or switching cards.
  let opened = false;
  await expect
    .poll(
      async () => {
        if (await visible(cardSelector)) return true;
        const pill = opened ? null : await visible("[data-approval-pill]");
        if (pill) {
          await pill.locator.click();
          opened = true;
        }
        return false;
      },
      { timeout: 30_000 }
    )
    .toBe(true);
  for (const direction of ["Next approval", "Previous approval"] as const) {
    for (let index = 0; index < 100; index += 1) {
      const requested = await visible(requestedSelector);
      if (requested) return requested.locator;
      const current = await visible(cardSelector);
      if (!current) break;
      const navigation = current.surface.getByRole("button", { name: direction, exact: true });
      if (!(await navigation.count()) || !(await navigation.isEnabled())) break;
      const prior = await current.locator.getAttribute("data-approval-id");
      await navigation.click();
      const advanceSelector = `${cardSelector}:not([data-approval-id=${JSON.stringify(prior)}])`;
      await expect
        .poll(async () => Boolean(await visible(advanceSelector)), { timeout: 30_000 })
        .toBe(true);
    }
  }
  throw new Error(`Approval ${approvalId} is missing from the visible queue`);
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
