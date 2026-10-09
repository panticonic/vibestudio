import { expect, test } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import YAML from "yaml";
import { TEMPLATE_REGISTRY_FILE_ENV } from "@vibestudio/service-schemas/templates";
import {
  approvePendingStartupUnits,
  approvePendingWorkspaceCreationReview,
  createManagedTestWorkspace,
  ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE,
  ensureHostedShellReady,
  executePanelScript,
  getManagedTestWorkspaceRoot,
  hasElectronDisplay,
  launchTestApp,
  removeManagedTestWorkspace,
  type TestApp,
} from "../../setup/electronSetup";
import type { E2eRootTemplate } from "../../setup/e2eRootTemplate";
import {
  completeReviewedWorkspaceCreation,
  declineFirstRunReporting,
  findWorkspaceShellPage,
  settleWorkspaceInstallReviews,
} from "../support/workspaceCreation";

test.skip(!hasElectronDisplay(), ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE);
const RECEIVER_TARGET = "do:workers/cross-workspace-receiver:CrossWorkspaceReceiver:main";
const METHOD = "readGreeting";

async function executeInHostedShell<T>(app: TestApp, source: string): Promise<T> {
  return app.app.evaluate(async ({ webContents }, script) => {
    const shell = webContents
      .getAllWebContents()
      .find(
        (candidate) =>
          !candidate.isDestroyed() &&
          candidate.getTitle() === "@workspace-apps/shell" &&
          !candidate.getURL().includes("overlaySurface=")
      );
    if (!shell) throw new Error("Hosted shell WebContents was not found");
    return shell.executeJavaScript(script, true);
  }, source) as Promise<T>;
}

async function waitForShell(app: TestApp, source: string): Promise<void> {
  await expect
    .poll(() => executeInHostedShell<unknown | null>(app, source), { timeout: 30_000 })
    .not.toBeNull();
}

async function diagnosticPhase<T>(name: string, action: () => T | Promise<T>): Promise<T> {
  const title = `cross-workspace: ${name}`;
  test.info().annotations.push({ type: "cross-workspace-phase", description: title });
  try {
    return await test.step(title, async () => await action());
  } finally {
    test.info().annotations.push({
      type: "cross-workspace-phase-settled",
      description: title,
    });
  }
}

interface CallerInvocationResult {
  callId: number;
  status: "idle" | "pending" | "fulfilled" | "rejected";
  value?: unknown;
  error?: string;
  code?: unknown;
  errorKind?: unknown;
}

interface ReceiverReadinessResult {
  status: "pending" | "fulfilled" | "rejected";
  targetId?: string;
  error?: string;
}

async function invokeCallerAndWait(
  app: TestApp,
  panelId: string,
  expectedCallId: number
): Promise<CallerInvocationResult> {
  await executePanelScript(app, panelId, `document.querySelector('button')?.click()`);
  const readResult = () =>
    executePanelScript<CallerInvocationResult>(
      app,
      panelId,
      `JSON.parse(document.querySelector('[aria-label="Call result"]')?.textContent ?? '{}')`
    );
  await expect
    .poll(() => readResult(), { timeout: 30_000 })
    .toMatchObject({
      callId: expectedCallId,
      status: expect.stringMatching(/^(fulfilled|rejected)$/),
    });
  return readResult();
}

async function waitForReceiverService(
  owner: Pick<TestApp, "app" | "workspaceId">,
  panelId: string
): Promise<void> {
  const readReadiness = () =>
    executePanelScript<ReceiverReadinessResult>(
      owner,
      panelId,
      `JSON.parse(document.querySelector('[aria-label="Receiver service readiness"]')?.textContent ?? '{}')`
    );
  await expect
    .poll(() => readReadiness(), { timeout: 30_000 })
    .toMatchObject({ status: expect.stringMatching(/^(fulfilled|rejected)$/) });
  const readiness = await readReadiness();
  expect(readiness.status, readiness.error ?? "Receiver service resolution should succeed").toBe(
    "fulfilled"
  );
  expect(readiness.targetId).toBe(RECEIVER_TARGET);
}

function readWorkspaceRpcPolicyEvidence(
  workspacePath: string,
  workspaceIds: readonly string[]
): Array<Record<string, unknown>> {
  const centralDataPath = path.dirname(path.dirname(workspacePath));
  const database = new DatabaseSync(path.join(centralDataPath, "server-auth", "identity.db"), {
    readOnly: true,
  });
  try {
    return database
      .prepare(
        `SELECT w.workspace_id AS workspaceId, w.name AS workspaceName,
                p.updated_by AS updatedBy, u.handle AS updatedByHandle,
                p.policy_json AS policy, p.updated_at AS updatedAt
         FROM workspaces w
         LEFT JOIN workspace_rpc_policy p ON p.workspace_id = w.workspace_id
         LEFT JOIN users u ON u.id = p.updated_by
         WHERE w.workspace_id IN (?, ?)
         ORDER BY w.workspace_id`
      )
      .all(workspaceIds[0], workspaceIds[1]);
  } finally {
    database.close();
  }
}

async function openWorkspaceConnections(app: TestApp): Promise<void> {
  const shell = await findWorkspaceShellPage(app);
  await shell.getByRole("button", { name: "Settings", exact: true }).click();
  await shell.getByRole("tab", { name: "Workspaces", exact: true }).click();
  await waitForShell(
    app,
    `(() => document.querySelector('#connection-workspace') ? true : null)()`
  );
}

async function createPeerWorkspace(
  app: TestApp,
  page: import("@playwright/test").Page,
  name: string,
  preexistingWorkspaceIds: readonly string[]
): Promise<string> {
  await diagnosticPhase("peer creation: open workspace chooser", () =>
    waitForShell(
      app,
      `(() => {
        const button = document.querySelector('button[aria-label="Add workspace"]');
        if (!button) return null;
        button.click();
        return true;
      })()`
    )
  );
  await diagnosticPhase("peer creation: choose the template catalog", async () => {
    await page.getByRole("radio", { name: "Templates Find your starting point" }).click();
    await expect(page.getByRole("heading", { name: "Choose your starting point" })).toBeVisible();
    await page
      .getByRole("button", { name: "Review Cross-workspace RPC fixture", exact: true })
      .click();
  });
  await diagnosticPhase("peer creation: enter the requested name", () =>
    waitForShell(
      app,
      `(() => {
        const input = document.querySelector('[aria-label="Workspace name"]');
        if (!input) return null;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, ${JSON.stringify(name)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`
    )
  );
  await diagnosticPhase("peer creation: submit the workspace", () =>
    waitForShell(
      app,
      `(() => {
        const button = Array.from(document.querySelectorAll('button')).find((node) =>
          (node.textContent ?? '').trim() === 'Create workspace'
        );
        if (!button || button.disabled) return null;
        button.click();
        return true;
      })()`
    )
  );
  let listQueriesStarted = 0;
  let listQueriesSettled = 0;
  let lastListSnapshot: {
    count: number;
    rows: Array<{ name: string; workspaceId: string }>;
  } | null = null;
  const readWorkspaceList = async () => {
    listQueriesStarted += 1;
    try {
      const rows = await app.app.evaluate(async () => globalThis.__testApi!.listWorkspaces());
      listQueriesSettled += 1;
      lastListSnapshot = {
        count: rows.length,
        rows: rows.slice(0, 20).map(({ name, workspaceId }) => ({ name, workspaceId })),
      };
      return rows;
    } catch (error) {
      listQueriesSettled += 1;
      throw error;
    }
  };
  let workspaceId: string;
  try {
    workspaceId = await diagnosticPhase("peer creation: observe workspace list publication", () =>
      expect
        .poll(
          async () =>
            (await readWorkspaceList()).find((row) => row.name === name)?.workspaceId ?? null,
          { timeout: 30_000 }
        )
        .not.toBeNull()
        .then(async () => (await readWorkspaceList()).find((row) => row.name === name)!.workspaceId)
    );
  } catch (error) {
    throw new Error(
      `Workspace list did not expose the created workspace: ${JSON.stringify({
        requestedName: name,
        listQueriesStarted,
        listQueriesSettled,
        queryPending: listQueriesStarted > listQueriesSettled,
        lastListSnapshot,
      })}`,
      { cause: error }
    );
  }
  await diagnosticPhase("peer creation: resolve its reviewed adoption", () =>
    completeReviewedWorkspaceCreation(app, workspaceId, page, name, preexistingWorkspaceIds)
  );
  return workspaceId;
}

async function chooseRadixOption(app: TestApp, triggerSelector: string, label: string) {
  await executeInHostedShell(
    app,
    `(() => { document.querySelector(${JSON.stringify(triggerSelector)})?.click(); return true; })()`
  );
  await waitForShell(
    app,
    `(() => {
      const option = Array.from(document.querySelectorAll('[role="option"]')).find((node) =>
        (node.textContent ?? '').includes(${JSON.stringify(label)})
      );
      if (!option) return null;
      option.click();
      return true;
    })()`
  );
}

async function addWorkspacePolicy(
  app: TestApp,
  page: import("@playwright/test").Page,
  managingWorkspace: string,
  direction: "incoming" | "outgoing",
  peerWorkspace: string
): Promise<void> {
  await chooseRadixOption(app, "#connection-workspace", managingWorkspace);
  await waitForShell(
    app,
    `(() => {
      const section = document.querySelector('[aria-labelledby="policy-${direction}"]');
      const add = Array.from(section?.querySelectorAll('button') ?? []).find((node) =>
        (node.textContent ?? '').includes('Add permission')
      );
      if (!add) return null;
      add.click();
      return true;
    })()`
  );
  await chooseRadixOption(app, `#peer-${direction}`, peerWorkspace);
  await executeInHostedShell(
    app,
    `(() => {
      const set = (selector, value) => {
        const input = document.querySelector(selector);
        if (!input) throw new Error('Missing policy input ' + selector);
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      };
      set('#target-${direction}', ${JSON.stringify(RECEIVER_TARGET)});
      set('#operation-${direction}', ${JSON.stringify(METHOD)});
      return true;
    })()`
  );
  await waitForShell(
    app,
    `(() => {
      const form = document.querySelector('#target-${direction}')?.closest('form');
      const review = Array.from(form?.querySelectorAll('button') ?? []).find((node) =>
        (node.textContent ?? '').includes('Review permission')
      );
      if (!review || review.disabled) return null;
      review.click();
      return true;
    })()`
  );
  const review = page.locator('[aria-label="Review workspace permission"]');
  await expect(review).toBeVisible();
  await expect(review).toContainText(managingWorkspace);
  await expect(review).toContainText(peerWorkspace);
  await expect(review).toContainText(RECEIVER_TARGET);
  await expect(review).toContainText(METHOD);
  await review.getByRole("button", { name: "Save permission", exact: true }).click();
  await waitForShell(
    app,
    `(() => document.body.innerText.includes('Permission saved.') ? true : null)()`
  );
  const policy = page.locator(`[aria-labelledby="policy-${direction}"]`);
  await expect(policy).toContainText(peerWorkspace);
  await expect(policy).toContainText(RECEIVER_TARGET);
  await expect(policy).toContainText(METHOD);
  await expect(policy).toContainText("For your account");
}

async function removeWorkspacePolicy(
  app: TestApp,
  page: import("@playwright/test").Page,
  managingWorkspace: string
): Promise<void> {
  await chooseRadixOption(app, "#connection-workspace", managingWorkspace);
  await waitForShell(
    app,
    `(() => {
      const button = document.querySelector(${JSON.stringify(
        `button[aria-label="Remove ${METHOD} on ${RECEIVER_TARGET} permission"]`
      )});
      if (!button) return null;
      button.click();
      return true;
    })()`
  );
  const review = page.locator('[aria-label="Review workspace permission"]');
  await expect(review).toBeVisible();
  await expect(review).toContainText(managingWorkspace);
  await expect(review).toContainText(RECEIVER_TARGET);
  await expect(review).toContainText(METHOD);
  await review.getByRole("button", { name: "Remove permission", exact: true }).click();
  await waitForShell(
    app,
    `(() => document.body.innerText.includes('Permission removed.') ? true : null)()`
  );
  const outgoing = page.locator('[aria-labelledby="policy-outgoing"]');
  await expect(outgoing).not.toContainText(RECEIVER_TARGET);
}

function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}
function configureCrossWorkspaceFixture(root: string) {
  writeJson(path.join(root, "workers/cross-workspace-receiver/package.json"), {
    name: "@workspace-workers/cross-workspace-receiver",
    version: "0.1.0",
    private: true,
    type: "module",
    vibestudio: {
      title: "Cross-workspace receiver",
      kind: "worker",
      entry: "index.ts",
      durable: { classes: [{ className: "CrossWorkspaceReceiver" }] },
      authority: { provides: [], requests: [] },
    },
    dependencies: { "@workspace/runtime": "workspace:*" },
  });
  fs.writeFileSync(
    path.join(root, "workers/cross-workspace-receiver/index.ts"),
    `import { DurableObjectBase, rpc } from "@workspace/runtime/worker/kernel";\nexport class CrossWorkspaceReceiver extends DurableObjectBase {\n  protected createTables(): void {}\n\n  @rpc({ website: { kind: "closed", reason: "This receiver is available only to reviewed workspace code." }, principals: ["code"], effect: { kind: "open" }, tier: "open", sensitivity: "read", crossWorkspace: true })\n  async readGreeting() { return { greeting: "hello across workspaces", callerWorkspaceId: this.caller.workspaceId }; }\n}\n`
  );
  writeJson(path.join(root, "panels/cross-workspace-caller/package.json"), {
    name: "@workspace-panels/cross-workspace-caller",
    version: "0.1.0",
    private: true,
    type: "module",
    vibestudio: {
      title: "Cross-workspace caller",
      kind: "panel",
      entry: "index.tsx",
      exposeModules: ["react", "react/jsx-runtime", "react-dom/client", "@workspace/runtime"],
      authority: { provides: [], requests: [] },
    },
    dependencies: {
      "@workspace/runtime": "workspace:*",
      react: "^19.0.0",
      "react-dom": "^19.0.0",
    },
  });
  fs.writeFileSync(
    path.join(root, "panels/cross-workspace-caller/index.tsx"),
    `import React, { useEffect, useRef, useState } from "react"; import { createRoot } from "react-dom/client"; import { rpc, workers } from "@workspace/runtime";\ntype CallResult={callId:number,status:"idle"|"pending"|"fulfilled"|"rejected",value?:unknown,error?:string,code?:unknown,errorKind?:unknown};\ntype ReceiverReadiness={status:"pending"|"fulfilled"|"rejected",targetId?:string,error?:string};\nfunction App(){ const [workspaceId,setWorkspaceId]=useState(""); const [receiver,setReceiver]=useState<ReceiverReadiness>({status:"pending"}); const [result,setResult]=useState<CallResult>({callId:0,status:"idle"}); const nextCallId=useRef(0); useEffect(()=>{let active=true;void workers.resolveService("e2e.cross-workspace.v1").then(service=>{if(active)setReceiver({status:"fulfilled",targetId:service.targetId});},error=>{if(active)setReceiver({status:"rejected",error:String(error)});});return()=>{active=false;};},[]); const call=async()=>{if(receiver.status!=="fulfilled"||!receiver.targetId)return;const callId=++nextCallId.current;setResult({callId,status:"pending"});try{const value=await rpc.call(receiver.targetId,${JSON.stringify(METHOD)},[],{destination:{kind:"workspace",workspaceId}});setResult({callId,status:"fulfilled",value});}catch(e){const failure=e&&typeof e==="object"?e as {code?:unknown,errorKind?:unknown}:{ };setResult({callId,status:"rejected",error:String(e),code:failure.code,errorKind:failure.errorKind});}}; return <main><output aria-label="Receiver service readiness">{JSON.stringify(receiver)}</output><input aria-label="Destination workspace" value={workspaceId} onChange={e=>setWorkspaceId(e.target.value)}/><button disabled={receiver.status!=="fulfilled"||result.status==="pending"} onClick={call}>Call receiver</button><output aria-label="Call result">{JSON.stringify(result)}</output></main> }\nconst root=document.getElementById("root"); if(!root) throw new Error("Missing panel root"); createRoot(root).render(<App/>);\n`
  );
  const configPath = path.join(root, "meta/vibestudio.yml");
  const config = YAML.parse(fs.readFileSync(configPath, "utf8"));
  config.template.name = "Cross-workspace RPC fixture";
  config.template.description = "Two-workspace native RPC acceptance source.";
  config.initPanels = [{ source: "panels/cross-workspace-caller" }];
  config.singletonObjects.push({
    source: "workers/cross-workspace-receiver",
    className: "CrossWorkspaceReceiver",
    key: "main",
  });
  config.services.push({
    source: "workers/cross-workspace-receiver",
    name: "cross-workspace.receiver",
    title: "Cross-workspace receiver",
    action: "read a greeting",
    description: "Native RPC acceptance fixture",
    notability: "everyday",
    presentation: { domain: "computer", verb: "see" },
    protocols: ["e2e.cross-workspace.v1"],
    authority: { binding: "declared", principals: ["code"] },
    durableObject: { className: "CrossWorkspaceReceiver" },
  });
  fs.writeFileSync(configPath, YAML.stringify(config));
}

test("configures two workspace boundaries in the shell and calls an exported receiver", async () => {
  test.setTimeout(600_000);
  const peerName = `e2e_peer_${Date.now()}`;
  const workspacePath = await diagnosticPhase("prepare the customized project fixture", () =>
    createManagedTestWorkspace({
      workspaceKind: "project",
      configureSource: configureCrossWorkspaceFixture,
    })
  );
  const testRoot = getManagedTestWorkspaceRoot(workspacePath);
  const registryPath = path.join(testRoot, "cross-workspace-template-registry.json");
  await diagnosticPhase("prepare the private template catalog entry", async () => {
    const caseRootTemplate = JSON.parse(
      fs.readFileSync(path.join(testRoot, "case-root-template.json"), "utf8")
    ) as { template: E2eRootTemplate };
    fs.writeFileSync(
      registryPath,
      `${JSON.stringify(
        {
          version: 1,
          templates: [
            {
              id: "cross-workspace-rpc-fixture",
              role: "catalog",
              name: "Cross-workspace RPC fixture",
              description: "A private local fixture for cross-workspace RPC E2E coverage.",
              url: caseRootTemplate.template.pin.url,
            },
          ],
        },
        null,
        2
      )}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
  });
  let app: TestApp | null = null;
  try {
    app = await diagnosticPhase("launch the desktop app and discover workspace owners", () =>
      launchTestApp({
        workspace: workspacePath,
        env: {
          [TEMPLATE_REGISTRY_FILE_ENV]: registryPath,
        },
        launchTimeout: 300_000,
      })
    );
    await diagnosticPhase("resolve selected workspace launch approvals", () =>
      approvePendingStartupUnits(app!)
    );
    await diagnosticPhase("record the first-run reporting choice", () =>
      declineFirstRunReporting(app!)
    );
    await diagnosticPhase("resolve the project workspace creation review", () =>
      approvePendingWorkspaceCreationReview(app!)
    );
    await diagnosticPhase("resolve the System workspace creation review", () =>
      approvePendingWorkspaceCreationReview({
        app: app!.app,
        workspaceId: app!.systemWorkspaceId,
      })
    );
    const shellPage = await diagnosticPhase("find the hosted workspace shell", () =>
      findWorkspaceShellPage(app!)
    );
    const launchWorkspaces = await diagnosticPhase("read the initial workspace list", () =>
      app!.app.evaluate(async () => globalThis.__testApi!.listWorkspaces())
    );
    await diagnosticPhase("settle initial workspace install reviews", () =>
      settleWorkspaceInstallReviews(
        app!,
        launchWorkspaces.map((workspace) => workspace.workspaceId)
      )
    );
    const peerWorkspaceId = await diagnosticPhase(
      "create the peer workspace from the catalog",
      () =>
        createPeerWorkspace(
          app!,
          shellPage,
          peerName,
          launchWorkspaces.map((workspace) => workspace.workspaceId)
        )
    );
    const workspaces = await diagnosticPhase("read the workspace list after peer creation", () =>
      app!.app.evaluate(async () => globalThis.__testApi!.listWorkspaces())
    );
    const peer = workspaces.find((row) => row.name === peerName);
    expect(peer).toBeTruthy();
    expect(peer!.workspaceId).toBe(peerWorkspaceId);
    const peerOwner = { app: app!.app, workspaceId: peerWorkspaceId };
    const peerPanel = await diagnosticPhase("wait for the peer receiver panel readiness", () =>
      ensureHostedShellReady(peerOwner, { panelSource: "panels/cross-workspace-caller" })
    );
    await diagnosticPhase("resolve the receiver in the peer code workspace", () =>
      waitForReceiverService(peerOwner, peerPanel.panelId)
    );
    const source = workspaces.find((row) => row.workspaceId === app!.workspaceId);
    expect(source).toBeTruthy();
    const openSource = shellPage.getByRole("button", {
      name: `Open ${source!.name}`,
      exact: true,
    });
    await diagnosticPhase("open the source workspace", async () => {
      await openSource.click();
      await expect(openSource).toHaveAttribute("aria-current", "location");
    });
    const ready = await diagnosticPhase("wait for the source hosted panel", () =>
      ensureHostedShellReady(app!, {
        panelSource: "panels/cross-workspace-caller",
      })
    );
    expect(ready.presentation.state).toBe("ready");
    await diagnosticPhase("resolve the receiver in the source code workspace", () =>
      waitForReceiverService(app!, ready.panelId)
    );
    await diagnosticPhase("verify the caller panel is rendered", () =>
      expect
        .poll(() =>
          executePanelScript<boolean>(
            app!,
            ready.panelId,
            `Boolean(document.querySelector('[aria-label="Destination workspace"]'))`
          )
        )
        .toBe(true)
    );
    await diagnosticPhase("open workspace connections", () => openWorkspaceConnections(app!));
    await diagnosticPhase("save the outgoing workspace policy", () =>
      addWorkspacePolicy(app!, shellPage, source!.name, "outgoing", peer!.name)
    );
    await diagnosticPhase("set the receiver destination for the first call", () =>
      executePanelScript(
        app!,
        ready.panelId,
        `(() => {
          const input = document.querySelector('[aria-label="Destination workspace"]');
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          setter.call(input, ${JSON.stringify(peer!.workspaceId)});
          input.dispatchEvent(new Event('input', { bubbles: true }));
        })()`
      )
    );
    await diagnosticPhase("invoke the receiver with outgoing policy only", async () => {
      const result = await invokeCallerAndWait(app!, ready.panelId, 1);
      expect(result).toMatchObject({ callId: 1, status: "rejected", code: "EACCES" });
      expect(result.error).toMatch(/incoming-blocked/);
    });
    await diagnosticPhase("save the incoming workspace policy", () =>
      addWorkspacePolicy(app!, shellPage, peer!.name, "incoming", source!.name)
    );
    await diagnosticPhase("close workspace connections after adding both policies", async () => {
      await shellPage.getByRole("button", { name: "Close settings", exact: true }).click();
      await expect(shellPage.locator("#connection-workspace")).toHaveCount(0);
    });

    await diagnosticPhase("set the receiver destination for the permitted call", () =>
      executePanelScript(
        app!,
        ready.panelId,
        `(() => {
          const input = document.querySelector('[aria-label="Destination workspace"]');
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          setter.call(input, ${JSON.stringify(peer!.workspaceId)});
          input.dispatchEvent(new Event('input', { bubbles: true }));
        })()`
      )
    );
    await diagnosticPhase("invoke the receiver with both policies", async () => {
      const result = await invokeCallerAndWait(app!, ready.panelId, 2);
      if (result.status === "rejected") {
        let policyEvidence: unknown;
        try {
          policyEvidence = readWorkspaceRpcPolicyEvidence(workspacePath, [
            source!.workspaceId,
            peer!.workspaceId,
          ]);
        } catch (error) {
          policyEvidence = {
            collectionError: error instanceof Error ? error.message : String(error),
          };
        }
        try {
          await test.info().attach("cross-workspace-policy-evidence", {
            body: JSON.stringify(policyEvidence, null, 2),
            contentType: "application/json",
          });
        } catch {
          // Evidence collection must not replace the receiver's original error below.
        }
      }
      expect(result.status, result.error ?? "The second receiver call should succeed").toBe(
        "fulfilled"
      );
      expect(result.value).toMatchObject({
        greeting: "hello across workspaces",
        callerWorkspaceId: app!.workspaceId,
      });
    });

    await diagnosticPhase("open workspace connections to remove the outgoing policy", () =>
      openWorkspaceConnections(app!)
    );
    await diagnosticPhase("remove the outgoing workspace policy", () =>
      removeWorkspacePolicy(app!, shellPage, source!.name)
    );
    await diagnosticPhase("close workspace connections after policy removal", async () => {
      await shellPage.getByRole("button", { name: "Close settings", exact: true }).click();
      await expect(shellPage.locator("#connection-workspace")).toHaveCount(0);
    });
    await diagnosticPhase("invoke the receiver after removing outgoing policy", async () => {
      const result = await invokeCallerAndWait(app!, ready.panelId, 3);
      expect(result).toMatchObject({ callId: 3, status: "rejected", code: "EACCES" });
      expect(result.error).toMatch(/outgoing-blocked/);
    });
  } finally {
    test.info().annotations.push({
      type: "cross-workspace-phase",
      description: "cleanup: retire the Electron app and child owners",
    });
    try {
      await app?.cleanup();
    } finally {
      test.info().annotations.push({
        type: "cross-workspace-phase-settled",
        description: "cleanup: retire the Electron app and child owners",
      });
    }
    test.info().annotations.push({
      type: "cross-workspace-phase",
      description: "cleanup: release the workspace fixture",
    });
    try {
      removeManagedTestWorkspace(workspacePath);
    } finally {
      test.info().annotations.push({
        type: "cross-workspace-phase-settled",
        description: "cleanup: release the workspace fixture",
      });
    }
  }
});
