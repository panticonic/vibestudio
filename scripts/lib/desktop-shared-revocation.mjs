import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { capabilityPatternCovers } from "@vibestudio/shared/authorityManifest";

export async function until(read, label, deadline) {
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
export async function nativeRpc(page, destination, method, args, timeoutMs = 30_000) {
  if (
    !destination ||
    (destination.kind !== "hub" &&
      !(
        destination.kind === "workspace" &&
        typeof destination.workspaceId === "string" &&
        destination.workspaceId.length > 0
      ))
  ) {
    throw new Error(`Native RPC ${method} requires an explicit hub or workspace destination`);
  }
  return page.evaluate(
    async ({ destination, method, args, timeoutMs }) => {
      const bridge = window.__vibestudioTransport;
      if (!bridge) throw new Error("Native workspace transport is unavailable");
      const requestId = `e2e-revocation-${crypto.randomUUID()}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          off();
          reject(new Error(`Timed out calling ${method}`));
        }, timeoutMs);
        const off = bridge.onMessage(({ message, delivery }) => {
          if (message.type !== "response" || message.requestId !== requestId) return;
          clearTimeout(timer);
          off();
          const responseWorkspaceId = delivery?.caller?.workspaceId;
          if (
            (destination.kind === "workspace" && responseWorkspaceId !== destination.workspaceId) ||
            (destination.kind === "hub" && responseWorkspaceId !== undefined)
          ) {
            reject(new Error(`Native RPC ${method} response came from the wrong owner`));
            return;
          }
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
            destination,
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
    { destination, method, args, timeoutMs }
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

const BROWSER_IMPORT_APPROVAL_CAPABILITIES = [
  { pattern: "userland:workers/browser-data/browser-data.write#*", phase: "store" },
  { pattern: "service:browserEnvironment.startImportRead", phase: "read" },
];

/** Identify one authority operation owned by the Browser Data extension's fixture import. */
export function browserImportApprovalIdentity(entry) {
  if (
    entry?.kind !== "capability" ||
    entry.repoPath !== "extensions/browser-data" ||
    (entry.requester?.repoPath !== undefined &&
      entry.requester.repoPath !== "extensions/browser-data")
  ) {
    return null;
  }
  const matched = BROWSER_IMPORT_APPROVAL_CAPABILITIES.find(({ pattern }) =>
    capabilityPatternCovers(pattern, entry.capability)
  );
  if (!matched || typeof entry.operationId !== "string" || entry.operationId.length === 0)
    return null;
  return {
    phase: matched.phase,
    logicalKey: JSON.stringify({
      capability: entry.capability,
      operationId: entry.operationId,
      securityIdentity: entry.securityIdentity ?? null,
      grantResourceKey: entry.grantResourceKey ?? null,
      resource: entry.resource ?? null,
    }),
  };
}

/** Return bounded identity evidence for a Browser Data approval the harness cannot classify. */
export function browserImportApprovalRejection(entry) {
  if (
    entry?.kind !== "capability" ||
    (entry.repoPath !== "extensions/browser-data" &&
      entry.requester?.repoPath !== "extensions/browser-data") ||
    browserImportApprovalIdentity(entry)
  ) {
    return null;
  }
  return {
    approvalId: entry.approvalId ?? null,
    repoPath: entry.repoPath ?? null,
    requesterRepoPath: entry.requester?.repoPath ?? null,
    capability: entry.capability ?? null,
    operationId: entry.operationId ?? null,
  };
}

/** Wait until the queue acknowledges resolution of the exact card that was clicked. */
export async function waitForApprovalSettlement(readPending, approvalId, deadline) {
  await until(
    async () =>
      (await readPending()).some((entry) => entry.approvalId === approvalId) ? null : true,
    `settling browser-import approval ${approvalId}`,
    deadline
  );
}

/** Resolve the next browser-import acquisition through its exact visible native card. */
export async function approveVisibleBrowserImport(
  app,
  workspaceId,
  deadline,
  beforeDecision,
  predicate = () => true,
  rejectedCandidate = () => null
) {
  const chrome = await chromePage(app, deadline);
  while (Date.now() < deadline) {
    const pending = await nativeRpc(
      chrome,
      { kind: "workspace", workspaceId },
      "shellApproval.listPending",
      []
    );
    const next = pending.find(
      (entry) =>
        entry.kind === "capability" &&
        predicate(entry) &&
        /browser|import/iu.test(
          `${entry.capability ?? ""} ${entry.title ?? ""} ${entry.description ?? ""}`
        )
    );
    if (!next) {
      const rejected = pending.map(rejectedCandidate).find((entry) => entry !== null);
      if (rejected) {
        throw new Error(
          `Browser import exposed an unclassified approval: ${JSON.stringify(rejected)}`
        );
      }
      return null;
    }
    const card = await until(
      async () => {
        const displayed = await visibleCard(app, next.approvalId);
        if (displayed) return displayed;
        for (const page of app.context().pages()) {
          if (page.isClosed()) continue;
          const pill = page.locator("[data-approval-pill]:visible").first();
          if (await pill.isVisible().catch(() => false)) await pill.click();
        }
        return null;
      },
      `displaying browser-import approval ${next.approvalId}`,
      deadline
    );
    const once = card.locator('[data-approval-decision="once"]');
    if (!(await once.isEnabled()))
      throw new Error("Browser-import approval has no enabled one-time decision");
    await beforeDecision?.(next, card);
    await once.click();
    await waitForApprovalSettlement(
      () => nativeRpc(chrome, { kind: "workspace", workspaceId }, "shellApproval.listPending", []),
      next.approvalId,
      deadline
    );
    console.log(
      `[desktop-smoke] Approved and settled browser-import acquisition ${next.approvalId} through visible chrome`
    );
    return next;
  }
  return null;
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
  const workspace = await nativeRpc(owner, { kind: "hub" }, "hubControl.createWorkspace", [
    { operationId: randomUUID(), workspace: workspaceName },
  ]);
  await prepareWorkspace(ownerApp, workspace);
  const invitation = await nativeRpc(owner, { kind: "hub" }, "hubControl.inviteUser", [
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
  const ownerCatalog = await nativeRpc(owner, { kind: "hub" }, "hubControl.listWorkspaces", []);
  const memberCatalog = await nativeRpc(member, { kind: "hub" }, "hubControl.listWorkspaces", []);
  const privatePair = (rows) =>
    rows.filter((entry) => entry.privateRole === "personal" || entry.privateRole === "system");
  const ownerPrivate = privatePair(ownerCatalog);
  const memberPrivate = privatePair(memberCatalog);
  for (const [label, rows] of [
    ["owner", ownerPrivate],
    ["member", memberPrivate],
  ]) {
    if (
      rows.length !== 2 ||
      !rows.some((entry) => entry.privateRole === "personal") ||
      !rows.some((entry) => entry.privateRole === "system")
    ) {
      throw new Error(`${label} did not receive exactly one Personal/System pair`);
    }
  }
  const ownerPrivateIds = new Set(ownerPrivate.map((entry) => entry.workspaceId));
  const memberPrivateIds = new Set(memberPrivate.map((entry) => entry.workspaceId));
  if ([...ownerPrivateIds].some((workspaceId) => memberPrivateIds.has(workspaceId)))
    throw new Error("Two authenticated users were assigned the same private workspace");
  if (
    memberCatalog.some((entry) => ownerPrivateIds.has(entry.workspaceId)) ||
    ownerCatalog.some((entry) => memberPrivateIds.has(entry.workspaceId))
  ) {
    throw new Error("A private workspace appeared in the other user's authenticated catalog");
  }
  const membership = await nativeRpc(owner, { kind: "hub" }, "hubControl.listWorkspaceMembers", [
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
    { kind: "workspace", workspaceId: workspace.workspaceId },
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
      const rows = await nativeRpc(
        member,
        { kind: "workspace", workspaceId: workspace.workspaceId },
        "shellApproval.listPending",
        []
      );
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
    { kind: "workspace", workspaceId: workspace.workspaceId },
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
    await nativeRpc(owner, { kind: "hub" }, "hubControl.removeWorkspaceMember", removalArgs);
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
      const workspaces = await nativeRpc(owner, { kind: "hub" }, "hubControl.listWorkspaces", []);
      for (const candidate of workspaces) {
        const rows = await nativeRpc(
          owner,
          { kind: "workspace", workspaceId: candidate.workspaceId },
          "shellApproval.listPending",
          []
        );
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
    { kind: "hub" },
    "hubControl.removeWorkspaceMember",
    removalArgs
  );
  if (!removal.removed || removal.closedSessions < 1)
    throw new Error("Membership removal did not retire the live member session");

  // Exercise the captured stale approval id through the exact same member UI
  // session, even if revocation already removed its visible card.
  let staleDecisionError;
  try {
    await nativeRpc(
      member,
      { kind: "workspace", workspaceId: workspace.workspaceId },
      "shellApproval.resolve",
      [pending.approvalId, "once"]
    );
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
  const memberWorkspaces = await nativeRpc(
    member,
    { kind: "hub" },
    "hubControl.listWorkspaces",
    []
  );
  if (memberWorkspaces.some((entry) => entry.workspaceId === workspace.workspaceId))
    throw new Error("Revoked workspace remains available to the member");
  const ownerWorkspaces = await nativeRpc(owner, { kind: "hub" }, "hubControl.listWorkspaces", []);
  if (!ownerWorkspaces.some((entry) => entry.workspaceId === workspace.workspaceId))
    throw new Error("Member revocation removed the owner's access");
  const ownerState = await nativeRpc(
    owner,
    { kind: "workspace", workspaceId: workspace.workspaceId },
    "vcs.mainState",
    []
  );
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
    uniquePrivatePairs: true,
    privateCatalogsIsolated: true,
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
