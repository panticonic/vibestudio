import { expect, test } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import YAML from "yaml";
import {
  approvePendingStartupUnits,
  approvePendingWorkspaceCreationReview,
  createManagedTestWorkspace,
  ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE,
  ensureHostedShellReady,
  executePanelScript,
  hasElectronDisplay,
  launchTestApp,
  removeManagedTestWorkspace,
  type TestApp,
} from "../../setup/electronSetup";
import {
  completeReviewedWorkspaceCreation,
  findWorkspaceShellPage,
  presentApprovalCard,
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

async function findWorkspacePolicyApproval(
  app: TestApp,
  managedWorkspaceId: string
): Promise<string[]> {
  return app.app.evaluate(
    async (_electron, request) => {
      const matches: string[] = [];
      for (const workspaceId of request.ownerWorkspaceIds) {
        const owner = await globalThis.__testApi!.forWorkspace(workspaceId);
        const pending = await owner.rpcCall("shellApproval", "listPending", []);
        for (const approval of pending) {
          if (
            approval.kind === "capability" &&
            approval.capability === "workspaces.rpcPolicy.write" &&
            approval.resource?.value === request.managedWorkspaceId
          ) {
            matches.push(approval.approvalId);
          }
        }
      }
      return [...new Set(matches)];
    },
    {
      ownerWorkspaceIds: [app.systemWorkspaceId, app.workspaceId, managedWorkspaceId],
      managedWorkspaceId,
    }
  );
}

async function clickApprovalOnce(
  app: TestApp,
  page: import("@playwright/test").Page,
  managedWorkspaceId: string
): Promise<void> {
  await expect
    .poll(() => findWorkspacePolicyApproval(app, managedWorkspaceId), { timeout: 30_000 })
    .toHaveLength(1);
  const [approvalId] = await findWorkspacePolicyApproval(app, managedWorkspaceId);
  if (!approvalId) throw new Error("Expected exact workspace policy approval disappeared");
  const card = await presentApprovalCard(page, approvalId);
  await card.getByRole("button", { name: /^(Allow|Connect|Use) once$/i }).click();
}

async function openWorkspaceConnections(app: TestApp): Promise<void> {
  await waitForShell(
    app,
    `(() => {
      const button = Array.from(document.querySelectorAll('button')).find((node) =>
        (node.textContent ?? '').trim() === 'Settings'
      );
      if (!button) return null;
      button.click();
      return true;
    })()`
  );
  await waitForShell(
    app,
    `(() => {
      const tab = document.querySelector('[aria-label="Workspace connections"]');
      if (!tab) return null;
      tab.click();
      return true;
    })()`
  );
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
  await waitForShell(
    app,
    `(() => {
      const button = document.querySelector('button[aria-label="Add workspace"]');
      if (!button) return null;
      button.click();
      return true;
    })()`
  );
  await waitForShell(
    app,
    `(() => {
      const button = Array.from(document.querySelectorAll('button')).find((node) =>
        (node.textContent ?? '').trim() === 'Explore apps & sources'
      );
      if (!button) return null;
      button.click();
      return true;
    })()`
  );
  await waitForShell(
    app,
    `(() => {
      const button = Array.from(document.querySelectorAll('button')).find((node) =>
        (node.textContent ?? '').trim() === 'Explore Cross-workspace RPC fixture'
      );
      if (!button) return null;
      button.click();
      return true;
    })()`
  );
  await waitForShell(
    app,
    `(() => {
      const input = document.querySelector('[aria-label="Workspace name"]');
      if (!input) return null;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(name)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`
  );
  await waitForShell(
    app,
    `(() => {
      const button = Array.from(document.querySelectorAll('button')).find((node) =>
        (node.textContent ?? '').trim() === 'Create workspace'
      );
      if (!button || button.disabled) return null;
      button.click();
      return true;
    })()`
  );
  const workspaceId = await expect
    .poll(
      () =>
        app.app.evaluate(async (_electron, requestedName) => {
          const rows = await globalThis.__testApi!.listWorkspaces();
          return rows.find((row) => row.name === requestedName)?.workspaceId ?? null;
        }, name),
      { timeout: 30_000 }
    )
    .not.toBeNull()
    .then(() =>
      app.app.evaluate(async (_electron, requestedName) => {
        const rows = await globalThis.__testApi!.listWorkspaces();
        return rows.find((row) => row.name === requestedName)!.workspaceId;
      }, name)
    );
  await completeReviewedWorkspaceCreation(app, workspaceId, page, name, preexistingWorkspaceIds);
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
  managedWorkspaceId: string,
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
  await waitForShell(
    app,
    `(() => {
      const region = document.querySelector('[aria-label="Review workspace permission"]');
      const save = Array.from(region?.querySelectorAll('button') ?? []).find((node) =>
        (node.textContent ?? '').includes('Save permission')
      );
      if (!save) return null;
      save.click();
      return true;
    })()`
  );
  await clickApprovalOnce(app, page, managedWorkspaceId);
  await waitForShell(
    app,
    `(() => document.body.innerText.includes('Permission saved.') ? true : null)()`
  );
}

async function removeWorkspacePolicy(
  app: TestApp,
  page: import("@playwright/test").Page,
  managedWorkspaceId: string,
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
  await waitForShell(
    app,
    `(() => {
      const region = document.querySelector('[aria-label="Review workspace permission"]');
      const remove = Array.from(region?.querySelectorAll('button') ?? []).find((node) =>
        (node.textContent ?? '').includes('Remove permission')
      );
      if (!remove) return null;
      remove.click();
      return true;
    })()`
  );
  await clickApprovalOnce(app, page, managedWorkspaceId);
  await waitForShell(
    app,
    `(() => document.body.innerText.includes('Permission removed.') ? true : null)()`
  );
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
    `import { DurableObjectBase, rpc } from "@workspace/runtime/worker/kernel";\nexport class CrossWorkspaceReceiver extends DurableObjectBase {\n  @rpc({ website: { kind: "closed", reason: "This receiver is available only to reviewed workspace code." }, principals: ["code"], effect: { kind: "open" }, tier: "open", sensitivity: "read", crossWorkspace: true })\n  async readGreeting() { return { greeting: "hello across workspaces", callerWorkspaceId: this.caller.workspaceId }; }\n}\n`
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
    `import React, { useState } from "react"; import { createRoot } from "react-dom/client"; import { rpc } from "@workspace/runtime";\nfunction App(){ const [workspaceId,setWorkspaceId]=useState(""); const [result,setResult]=useState(""); return <main><input aria-label="Destination workspace" value={workspaceId} onChange={e=>setWorkspaceId(e.target.value)}/><button onClick={async()=>{try{const value=await rpc.call(${JSON.stringify(RECEIVER_TARGET)},${JSON.stringify(METHOD)},[],{destination:{kind:"workspace",workspaceId}});setResult(JSON.stringify(value));}catch(e){setResult("ERROR:"+String(e));}}}>Call receiver</button><output>{result}</output></main> }\nconst root=document.getElementById("root"); if(!root) throw new Error("Missing panel root"); createRoot(root).render(<App/>);\n`
  );
  const configPath = path.join(root, "meta/vibestudio.yml");
  const config = YAML.parse(fs.readFileSync(configPath, "utf8"));
  config.template.name = "Cross-workspace RPC fixture";
  config.template.description = "Two-workspace native RPC acceptance source.";
  config.template.repositories.push(
    "workers/cross-workspace-receiver",
    "panels/cross-workspace-caller"
  );
  config.initPanels = [{ source: "panels/cross-workspace-caller" }];
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
  const workspacePath = await createManagedTestWorkspace({
    workspaceKind: "project",
    configureSource: configureCrossWorkspaceFixture,
  });
  let app: TestApp | null = null;
  try {
    app = await launchTestApp({
      workspace: workspacePath,
      launchTimeout: 300_000,
    });
    await approvePendingStartupUnits(app);
    await approvePendingWorkspaceCreationReview(app);
    await approvePendingWorkspaceCreationReview({
      app: app.app,
      workspaceId: app.systemWorkspaceId,
    });
    const shellPage = await findWorkspaceShellPage(app);
    const launchWorkspaces = await app.app.evaluate(async () =>
      globalThis.__testApi!.listWorkspaces()
    );
    await settleWorkspaceInstallReviews(
      app,
      launchWorkspaces.map((workspace) => workspace.workspaceId)
    );
    const peerWorkspaceId = await createPeerWorkspace(
      app,
      shellPage,
      peerName,
      launchWorkspaces.map((workspace) => workspace.workspaceId)
    );
    const workspaces = await app.app.evaluate(async () => globalThis.__testApi!.listWorkspaces());
    const peer = workspaces.find((row) => row.name === peerName);
    expect(peer).toBeTruthy();
    expect(peer!.workspaceId).toBe(peerWorkspaceId);
    const source = workspaces.find((row) => row.workspaceId === app!.workspaceId);
    expect(source).toBeTruthy();
    const openSource = shellPage.getByRole("button", {
      name: `Open ${source!.name}`,
      exact: true,
    });
    await openSource.click();
    await expect(openSource).toHaveAttribute("aria-current", "location");
    const ready = await ensureHostedShellReady(app, {
      panelSource: "panels/cross-workspace-caller",
    });
    expect(ready.presentation.state).toBe("ready");
    await expect
      .poll(() =>
        executePanelScript<boolean>(
          app!,
          ready.panelId,
          `Boolean(document.querySelector('[aria-label="Destination workspace"]'))`
        )
      )
      .toBe(true);
    await openWorkspaceConnections(app);
    await addWorkspacePolicy(
      app,
      shellPage,
      source!.workspaceId,
      source!.name,
      "outgoing",
      peer!.name
    );
    await addWorkspacePolicy(
      app,
      shellPage,
      peer!.workspaceId,
      peer!.name,
      "incoming",
      source!.name
    );
    await shellPage.getByRole("button", { name: "Close settings", exact: true }).click();
    await expect(shellPage.locator("#connection-workspace")).toHaveCount(0);

    await executePanelScript(
      app,
      ready.panelId,
      `(() => {
        const input = document.querySelector('[aria-label="Destination workspace"]');
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, ${JSON.stringify(peer!.workspaceId)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`
    );
    await executePanelScript(app, ready.panelId, `document.querySelector('button')?.click()`);
    await expect
      .poll(
        () =>
          executePanelScript<string>(
            app!,
            ready.panelId,
            `document.querySelector('output')?.textContent ?? ''`
          ),
        { timeout: 30_000 }
      )
      .toContain("hello across workspaces");
    expect(
      await executePanelScript<string>(
        app,
        ready.panelId,
        `document.querySelector('output')?.textContent ?? ''`
      )
    ).toContain(app.workspaceId);

    await openWorkspaceConnections(app);
    await removeWorkspacePolicy(app, shellPage, source!.workspaceId, source!.name);
    await shellPage.getByRole("button", { name: "Close settings", exact: true }).click();
    await expect(shellPage.locator("#connection-workspace")).toHaveCount(0);
    await executePanelScript(
      app,
      ready.panelId,
      `(() => { document.querySelector('button').click(); })()`
    );
    await expect
      .poll(
        () =>
          executePanelScript<string>(
            app!,
            ready.panelId,
            `document.querySelector('output')?.textContent ?? ''`
          ),
        { timeout: 30_000 }
      )
      .toMatch(/ERROR:.*(EACCES|not admitted|policy)/i);
  } finally {
    await app?.cleanup();
    removeManagedTestWorkspace(workspacePath);
  }
});
