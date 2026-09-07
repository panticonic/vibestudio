import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

async function until(read, label, deadline) {
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out ${label}`);
}

export async function chromePage(app, deadline) {
  return until(
    async () => {
      for (const page of app.context().pages()) {
        if (page.isClosed() || !page.url().includes("/_a/")) continue;
        if (await page.locator('[aria-label="Open Personal"]').count()) return page;
      }
      return null;
    },
    "finding the paired native workspace chrome",
    deadline
  );
}

/** Uses the same authenticated native UI carrier as the existing selected-copy E2E. */
export async function nativeRpc(page, workspaceId, method, args, timeoutMs = 30_000) {
  return page.evaluate(
    async ({ workspaceId, method, args, timeoutMs }) => {
      const bridge = window.__vibestudioTransport;
      if (!bridge) throw new Error("Native workspace transport is unavailable");
      const requestId = `e2e-revocation-${crypto.randomUUID()}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          off();
          reject(new Error(`Timed out calling ${method}`));
        }, timeoutMs);
        const off = bridge.onMessage(({ message }) => {
          if (message.type !== "response" || message.requestId !== requestId) return;
          clearTimeout(timer);
          off();
          if ("error" in message) {
            reject(
              Object.assign(new Error(message.error), {
                code: message.errorCode,
                errorKind: message.errorKind,
                errorData: message.errorData,
              })
            );
          } else resolve(message.result);
        });
        const caller = {
          callerId: bridge.identity.runtimeId,
          callerKind: "app",
          workspaceId: bridge.identity.workspaceId,
        };
        void bridge
          .send({
            from: caller.callerId,
            target: "main",
            targetWorkspaceId: workspaceId ?? caller.workspaceId,
            delivery: { caller },
            provenance: [caller],
            message: { type: "request", requestId, fromId: caller.callerId, method, args },
          })
          .catch((error) => {
            clearTimeout(timer);
            off();
            reject(error);
          });
      });
    },
    { workspaceId, method, args, timeoutMs }
  );
}

async function visibleCards(app, approvalId) {
  const visible = [];
  for (const page of app.context().pages()) {
    if (page.isClosed()) continue;
    for (const card of await page.locator(`[data-approval-id="${approvalId}"]`).all()) {
      if (await card.isVisible()) visible.push(card);
    }
  }
  return visible;
}

async function visibleCard(app, approvalId) {
  return (await visibleCards(app, approvalId))[0] ?? null;
}

/** Additional native acceptance using the smoke's existing launch/cleanup owner.
 * launchMember must isolate both profile and native credential-store state and
 * register the application for teardown before waiting for its readiness.
 */
export async function runSharedMemberRevocation({
  ownerApp,
  launchMember,
  prepareWorkspace,
  receiptPath,
  timeoutMs = 360_000,
}) {
  const deadline = Date.now() + timeoutMs;
  const owner = await chromePage(ownerApp, deadline);
  const workspaceName = `approval-revocation-${randomUUID().slice(0, 8)}`;
  const workspace = await nativeRpc(owner, undefined, "hubControl.createWorkspace", [
    { workspace: workspaceName },
  ]);
  await prepareWorkspace(ownerApp, workspace);
  const invitation = await nativeRpc(owner, undefined, "hubControl.inviteUser", [
    {
      handle: `revocation-${randomUUID().slice(0, 8)}`,
      displayName: "Revocation acceptance member",
      role: "member",
      workspaces: [workspaceName],
      ttlMs: 600_000,
    },
  ]);
  const memberApp = await launchMember(invitation.pairing.deepLink);
  const member = await chromePage(memberApp, deadline);
  const memberWorkspace = await prepareWorkspace(memberApp, workspace);
  const membership = await nativeRpc(owner, undefined, "hubControl.listWorkspaceMembers", [
    { workspace: workspaceName },
  ]);
  const memberRow = membership.members.find((entry) => entry.userId === invitation.user.userId);
  if (!memberRow || memberRow.role !== "member")
    throw new Error(
      `The paired approval account is not an ordinary workspace member: ${JSON.stringify({
        invitedUserId: invitation.user.userId,
        workspaceId: workspace.workspaceId,
        returnedWorkspaceId: membership.workspaceId,
        members: membership.members.map(({ userId, role, accountRole }) => ({
          userId,
          role,
          accountRole,
        })),
      })}`
    );
  const panel = await memberApp.evaluate(
    async ({ workspaceId, parentId }) => {
      const testApi = globalThis.__testApi;
      if (!testApi) throw new Error("Native test API is unavailable");
      const workspaceApi = await testApi.forWorkspace(workspaceId);
      return workspaceApi.createBrowserPanel(parentId, "https://example.com", { focus: true });
    },
    { workspaceId: workspace.workspaceId, parentId: memberWorkspace.panelId }
  );
  const epoch = randomUUID();
  let settledRequest;
  const requestOutcome = nativeRpc(
    member,
    workspace.workspaceId,
    "browserPermissions.request",
    [
      {
        panelId: panel.id,
        sessionEpoch: epoch,
        origin: "https://example.com",
        topLevelUrl: "https://example.com/",
        capabilities: ["geolocation"],
        deviceLabel: "Revocation acceptance desktop",
      },
    ],
    Math.max(1, deadline - Date.now())
  ).then(
    (result) => (settledRequest = { result }),
    (error) => (settledRequest = { error: error.message })
  );
  const requirePendingRequest = () => {
    if (settledRequest)
      throw new Error(
        `Website permission request settled before approval: ${JSON.stringify(settledRequest)}`
      );
  };
  const pending = await until(
    async () => {
      requirePendingRequest();
      const rows = await nativeRpc(member, workspace.workspaceId, "shellApproval.listPending", []);
      requirePendingRequest();
      return rows.find(
        (entry) => entry.kind === "browser-permission" && entry.panelId === panel.id
      );
    },
    "waiting for the member-owned website approval",
    deadline
  );
  if (pending.ownerUserId !== invitation.user.userId)
    throw new Error("Website approval belongs to a different account");
  const ownerPending = await nativeRpc(
    owner,
    workspace.workspaceId,
    "shellApproval.listPending",
    []
  );
  if (ownerPending.some((entry) => entry.approvalId === pending.approvalId))
    throw new Error("Workspace administrator can see another member's private approval");

  const card = await until(
    async () => {
      requirePendingRequest();
      const displayed = await visibleCard(memberApp, pending.approvalId);
      if (displayed) return displayed;
      for (const page of memberApp.context().pages()) {
        if (page.isClosed()) continue;
        const pill = page.locator("[data-approval-pill]:visible").first();
        if (await pill.isVisible().catch(() => false)) {
          await pill.click();
          break;
        }
      }
      return null;
    },
    "displaying the member's exact native approval card",
    deadline
  );
  const decisionButton = card.locator('[data-approval-decision="once"]');
  if (!(await decisionButton.isEnabled()))
    throw new Error("The visible approval has no enabled one-time decision");
  await fs.mkdir(path.dirname(receiptPath), { recursive: true, mode: 0o700 });
  const screenshotPath = receiptPath.replace(/\.json$/, "-visible.png");
  await card.screenshot({ path: screenshotPath });
  await fs.chmod(screenshotPath, 0o600);

  const removalArgs = [
    {
      workspace: workspaceName,
      userId: invitation.user.userId,
    },
  ];
  let removalChallenge;
  try {
    await nativeRpc(owner, undefined, "hubControl.removeWorkspaceMember", removalArgs);
  } catch (error) {
    removalChallenge = error;
  }
  if (!removalChallenge || removalChallenge.code !== "EACQUIRE") {
    throw new Error(
      `Removing a workspace member did not require explicit owner approval: ${removalChallenge?.message ?? "call succeeded"}`
    );
  }
  const removalAcquisition = removalChallenge.errorData?.acquisition;
  console.log(
    `[desktop-smoke] Member-removal authority challenge: code=${removalChallenge.code}; pending=${String(removalAcquisition?.pending === true)}`
  );
  if (!removalAcquisition || removalAcquisition.pending !== true) {
    throw new Error(
      "The member-removal authority challenge was not entered into an approval queue"
    );
  }
  const removalPending = await until(
    async () => {
      const workspaces = await nativeRpc(owner, undefined, "hubControl.listWorkspaces", []);
      for (const candidate of workspaces) {
        const rows = await nativeRpc(owner, candidate.workspaceId, "shellApproval.listPending", []);
        const pending = rows.find(
          (entry) => entry.kind === "capability" && entry.title === "Remove a workspace member"
        );
        if (pending) return { pending, workspaceId: candidate.workspaceId };
      }
      return null;
    },
    "waiting for the owner's member-removal approval",
    deadline
  );
  console.log(
    `[desktop-smoke] Located member-removal approval ${removalPending.pending.approvalId} in workspace ${removalPending.workspaceId}`
  );
  const removalCard = await until(
    async () => {
      const displayed = await visibleCard(ownerApp, removalPending.pending.approvalId);
      if (displayed) return displayed;
      for (const page of ownerApp.context().pages()) {
        if (page.isClosed()) continue;
        const pill = page.locator("[data-approval-pill]:visible").first();
        if (await pill.isVisible().catch(() => false)) {
          await pill.click();
          break;
        }
      }
      return null;
    },
    "displaying the owner's member-removal approval",
    deadline
  );
  console.log("[desktop-smoke] Member-removal approval card is visible in owner chrome");
  const approveRemoval = removalCard.locator('[data-approval-decision="once"]');
  if (!(await approveRemoval.isEnabled())) {
    throw new Error("The member-removal approval has no enabled one-time decision");
  }
  await approveRemoval.click();
  await until(
    async () => ((await removalCard.isVisible().catch(() => false)) ? null : true),
    "recording the owner's member-removal approval",
    deadline
  );
  const removal = await nativeRpc(
    owner,
    undefined,
    "hubControl.removeWorkspaceMember",
    removalArgs
  );
  if (!removal.removed || removal.closedSessions < 1)
    throw new Error("Membership removal did not retire the live member session");

  // Exercise the captured stale approval id through the exact same member UI
  // session, even if revocation already removed its visible card.
  let staleDecisionError;
  try {
    await nativeRpc(member, workspace.workspaceId, "shellApproval.resolve", [
      pending.approvalId,
      "once",
    ]);
  } catch (error) {
    staleDecisionError = error.message;
  }
  if (!staleDecisionError || /Timed out/.test(staleDecisionError))
    throw new Error(
      `Stale approval decision was not explicitly rejected: ${staleDecisionError ?? "accepted"}`
    );
  // The stale RPC rejection alone cannot establish the UI postcondition. Every
  // visible copy of the captured card must withdraw its decision controls;
  // clicking an active card to produce an error would hide a stale UI defect.
  const visibleApprovalAfterRevocation = await until(
    async () => {
      const cards = await visibleCards(memberApp, pending.approvalId);
      if (cards.length === 0) return "removed";
      for (const remaining of cards) {
        for (const decision of await remaining.locator("[data-approval-decision]").all()) {
          if ((await decision.isVisible()) && (await decision.isEnabled())) return null;
        }
      }
      return "non-actionable";
    },
    "withdrawing the revoked member's visible approval decisions",
    Math.min(deadline, Date.now() + 15_000)
  );
  const outcome = await requestOutcome;
  if (outcome.result?.granted === true)
    throw new Error("Revoked member granted the pending website permission");
  if (outcome.error && /Timed out/.test(outcome.error))
    throw new Error("Revocation left the original approval request unresolved");
  const memberWorkspaces = await nativeRpc(member, undefined, "hubControl.listWorkspaces", []);
  if (memberWorkspaces.some((entry) => entry.workspaceId === workspace.workspaceId))
    throw new Error("Revoked workspace remains available to the member");
  const ownerWorkspaces = await nativeRpc(owner, undefined, "hubControl.listWorkspaces", []);
  if (!ownerWorkspaces.some((entry) => entry.workspaceId === workspace.workspaceId))
    throw new Error("Member revocation removed the owner's access");
  const ownerState = await nativeRpc(owner, workspace.workspaceId, "vcs.mainState", []);
  if (ownerState.kind !== "event")
    throw new Error("Owner workspace reads stopped after revocation");
  const receipt = {
    kind: "native-shared-member-approval-revocation",
    trigger: "authenticated native IPC browserPermissions.request for a real browser panel",
    workspaceId: workspace.workspaceId,
    memberUserId: invitation.user.userId,
    approvalId: pending.approvalId,
    removalApprovalWorkspaceId: removalPending.workspaceId,
    visibleBeforeRevocation: true,
    ordinaryMember: true,
    ownerCouldNotSeePrivateApproval: true,
    removal,
    staleDecisionRejected: true,
    staleDecisionError,
    visibleApprovalAfterRevocation,
    originalRequest: outcome,
    memberWorkspaceRemoved: true,
    ownerStillFunctional: true,
    screenshot: path.basename(screenshotPath),
    completedAt: new Date().toISOString(),
  };
  await fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  console.log(`[desktop-smoke] Shared-member approval revocation passed; receipt=${receiptPath}`);
  return { memberApp, receipt };
}
