import { expect, test, type Locator } from "@playwright/test";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import YAML from "yaml";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  approvePendingStartupUnits,
  approvePendingWorkspaceCreationReview,
  createBrowserPanel,
  createManagedTestWorkspace,
  ensureHostedShellReady,
  launchTestApp,
  removeManagedTestWorkspace,
  clickPanelSelector,
  getPanelText,
  reloadPanel,
  executePanelScript,
  type TestApp,
} from "../../setup/electronSetup";
import { clickNativeApproval } from "../support/nativeApproval";
import { requireE2eRootTemplate } from "../../setup/e2eRootTemplate";
import { hasOwnedX11Display } from "../../setup/ownedXvfb";
import {
  findWorkspaceShellPage,
  presentApprovalCard,
  settleWorkspaceInstallReviews,
} from "../support/workspaceCreation";

let sdkPath: string;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  const root = process.env["VIBESTUDIO_E2E_TEMP_ROOT"];
  if (!root) throw new Error("The website SDK acceptance requires the owned E2E temporary root");
  const directory = path.join(root, "website-runtime-sdk");
  await promisify(execFile)(
    process.execPath,
    ["node_modules/tsx/dist/cli.mjs", "scripts/build-website-runtime.ts", "--out-dir", directory],
    {
      cwd: process.cwd(),
      timeout: 110_000,
      maxBuffer: 1024 * 1024,
    }
  );
  sdkPath = path.join(directory, "index.js");
});

test("website SDK requires explicit connection and retires access on document replacement", async () => {
  test.setTimeout(300_000);
  test.skip(!hasOwnedX11Display(), "Website consent input requires the owned native X11 display");
  const sdk = fs.readFileSync(sdkPath);
  const templatePin = requireE2eRootTemplate().pin;
  const html = `<!doctype html><title>Workspace website acceptance</title>
    <button id="connect">Connect</button><button id="discover">Discover</button><button id="closed">Try host inventory</button>
    <button id="eval">Run scoped eval</button><button id="launch">Launch agent</button><button id="inspect">Inspect template</button><button id="create">Create workspace</button><button id="receipt">Read receipt</button>
    <p id="status">Loading SDK</p><script type="module">
    import { connectWorkspace, workspaceConnection, callMain, templates, workspaces, rpc, contextId, launchAgentIntoChannel } from '/runtime.js';
    const output = value => document.querySelector('#status').textContent = value;
    const templatePin = ${JSON.stringify(templatePin)};
    const operationId = sessionStorage.getItem('operationId') || crypto.randomUUID();
    sessionStorage.setItem('operationId', operationId);
    const attempt = async operation => { try { output(await operation()); } catch (error) { output('error:' + (error.code || '') + ':' + error.message); } };
    document.querySelector('#connect').onclick = () => attempt(async () => { await connectWorkspace(); return 'connected:' + workspaceConnection.connected; });
    document.querySelector('#discover').onclick = () => attempt(async () => { const entries = await callMain('docs.search', 'read', { limit: 5 }); return 'discovered:' + Array.isArray(entries); });
    document.querySelector('#closed').onclick = () => attempt(async () => { await callMain('websiteHosting.list'); return 'unexpected inventory access'; });
    document.querySelector('#launch').onclick = () => attempt(async () => {
      const key = 'website-agent-' + operationId;
      await callMain('runtime.createEntity', { kind: 'do', execution: { surface: 'code', source: 'workers/pubsub-channel' }, className: 'PubSubChannel', key, contextId });
      const launched = await launchAgentIntoChannel(rpc, { source: 'workers/agent-worker', className: 'AiChatWorker', key, contextId, channelId: key, replay: true });
      return 'launched:' + launched.subscription.ok;
    });
    document.querySelector('#eval').onclick = () => attempt(async () => {
      const runId = crypto.randomUUID();
      const scope = { key: 'website-authority-acceptance', lifecycle: 'finite' };
      const code = "const runtime = await import('@workspace/runtime'); const entries = await runtime.rpc.call('main', 'docs.listSurfaces', []); let closed = false; try { await runtime.rpc.call('main', 'websiteHosting.list', []); } catch (error) { closed = /closed to websites/.test(error.message); } return { discovered: Array.isArray(entries), closed };";
      await callMain('eval.start', { runId, scope, source: { kind: 'inline', code } });
      for (let attempt = 0; attempt < 120; attempt++) {
        const state = await callMain('eval.get', { runId, scopeKey: scope.key });
        if (state.result) return 'eval:' + JSON.stringify(state.result);
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      throw new Error('Scoped eval did not settle');
    });
    document.querySelector('#inspect').onclick = () => attempt(async () => { const result = await templates.inspect({ pin: templatePin }); return 'inspected:' + result.pin.commit; });
    document.querySelector('#create').onclick = () => attempt(async () => { const result = await workspaces.create({ operationId, workspace: 'website-installation-acceptance', rootTemplate: templatePin }); sessionStorage.setItem('createdWorkspaceId', result.workspaceId); return 'created:' + result.workspaceId; });
    document.querySelector('#receipt').onclick = () => attempt(async () => { const result = await workspaces.receipt({ operationId }); return 'receipt:' + (result?.workspaceId === sessionStorage.getItem('createdWorkspaceId')); });
    output('loaded:disconnected=' + !workspaceConnection.connected);
    </script>`;
  const server = http.createServer((request, response) => {
    response.writeHead(200, {
      "content-type": request.url === "/runtime.js" ? "text/javascript" : "text/html",
    });
    response.end(request.url === "/runtime.js" ? sdk : html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Website acceptance listener failed");
  const url = `http://127.0.0.1:${address.port}/`;
  let workspacePath: string | undefined;
  let app: TestApp | undefined;
  try {
    workspacePath = await createManagedTestWorkspace({
      configureSource(sourceRoot) {
        const configPath = path.join(sourceRoot, "meta", "vibestudio.yml");
        const config = YAML.parse(fs.readFileSync(configPath, "utf8"));
        config.initPanels = [{ source: "about/new" }];
        fs.writeFileSync(configPath, YAML.stringify(config));
      },
    });
    app = await launchTestApp({ workspace: workspacePath, launchTimeout: 180_000 });
    await approvePendingStartupUnits(app);
    await approvePendingWorkspaceCreationReview(app);
    await approvePendingWorkspaceCreationReview({
      app: app.app,
      workspaceId: app.systemWorkspaceId,
    });
    const initial = await ensureHostedShellReady(app, { panelSource: "about/new" });
    const panel = await createBrowserPanel(app, initial.panelId, url, { focus: true });
    await ensureHostedShellReady(app, { panelSource: `browser:${url}` });
    const text = () => getPanelText(app!, panel.id);
    await expect.poll(text).toContain("loaded:disconnected=true");
    await settleWorkspaceInstallReviews(app, [app.workspaceId, app.systemWorkspaceId]);
    const shell = await findWorkspaceShellPage(app);
    const minimize = shell.getByRole("button", { name: "Minimize approval", exact: true });
    if (await minimize.isVisible()) await minimize.click();
    await expect(shell.locator("[data-approval-id]:visible")).toHaveCount(0);
    await clickPanelSelector(app, panel.id, "#discover");
    await expect.poll(text).toContain("EWORKSPACE_DISCONNECTED");
    const pendingCapability = async (capability: string) =>
      app!.app.evaluate(
        async (_electron, { workspaceId, capability }) => {
          const api = await globalThis.__testApi!.forWorkspace(workspaceId);
          const pending = (await api.rpcCall("shellApproval", "listPending", [])) as Array<{
            approvalId: string;
            kind: string;
            capability?: string;
          }>;
          return pending.filter(
            (item) =>
              item.kind === "capability" &&
              (capability.endsWith("#")
                ? item.capability?.startsWith(capability)
                : item.capability === capability)
          );
        },
        { workspaceId: app!.workspaceId, capability }
      );
    const pendingConnections = () => pendingCapability("workspace.connect");
    expect(await pendingConnections()).toEqual([]);
    await clickPanelSelector(app, panel.id, "#connect");
    await expect.poll(async () => (await pendingConnections()).length).toBe(1);
    const visibleConnectionApproval = async (capability = "workspace.connect") => {
      await expect
        .poll(async () => (await pendingCapability(capability)).length, { timeout: 30_000 })
        .toBe(1);
      const approvalId = (await pendingCapability(capability))[0]!.approvalId;
      let approval!: Locator;
      await expect
        .poll(
          async () => {
            for (const page of app!.app.context().pages()) {
              const candidate = page.locator(`[data-approval-id=${JSON.stringify(approvalId)}]`);
              if (await candidate.isVisible()) {
                approval = candidate;
                return true;
              }
              if (await page.locator("[data-approval-id]:visible").count()) {
                approval = await presentApprovalCard(page, approvalId);
                return true;
              }
            }
            return false;
          },
          { timeout: 30_000 }
        )
        .toBe(true);
      return approval;
    };
    const denied = await visibleConnectionApproval();
    const clickApproval = (button: Locator) => clickNativeApproval(app!, button);
    await clickApproval(denied.getByRole("button", { name: "Don't allow", exact: true }));
    await expect.poll(pendingConnections).toEqual([]);
    await expect.poll(text).toContain("Workspace connection was declined");
    await executePanelScript(
      app,
      panel.id,
      `globalThis.vibestudio.connect().catch(error => { document.querySelector('#status').textContent = error.message; })`
    );
    await expect.poll(text).toContain("Choose Connect on this page");
    expect(await pendingConnections()).toEqual([]);
    await clickPanelSelector(app, panel.id, "#connect");
    await expect.poll(async () => (await pendingConnections()).length).toBe(1);
    const approval = await visibleConnectionApproval();
    await expect(approval).toContainText(`127.0.0.1:${address.port}`);
    await clickApproval(approval.getByRole("button", { name: "Connect this page", exact: true }));
    await expect.poll(text).toContain("connected:true");
    await expect(shell.locator('[data-panel-trust="connected-website"]').first()).toBeVisible();
    await clickPanelSelector(app, panel.id, "#discover");
    await expect.poll(text).toContain("discovered:true");
    await clickPanelSelector(app, panel.id, "#eval");
    await expect.poll(text, { timeout: 90_000 }).toContain("eval:");
    expect(await text()).toContain('"discovered":true,"closed":true');
    await clickPanelSelector(app, panel.id, "#launch");
    await expect.poll(text, { timeout: 90_000 }).toMatch(/launched:|error:/);
    expect(await text()).toContain("launched:true");
    await clickPanelSelector(app, panel.id, "#closed");
    await expect.poll(text).toContain("error:");
    expect(await text()).not.toContain("unexpected inventory access");
    await clickPanelSelector(app, panel.id, "#inspect");
    const inspectionApproval = await visibleConnectionApproval(
      "userland:extensions/templates/workspace.templates.inspect#"
    );
    await expect(inspectionApproval).toContainText(`127.0.0.1:${address.port}`);
    await clickApproval(
      inspectionApproval.getByRole("button", { name: "Allow once", exact: true })
    );
    await expect.poll(text, { timeout: 30_000 }).toContain(`inspected:${templatePin.commit}`);
    await clickPanelSelector(app, panel.id, "#create");
    const creationApproval = await visibleConnectionApproval("workspaces.create");
    await expect(creationApproval).toContainText(`127.0.0.1:${address.port}`);
    await expect(creationApproval).toContainText(
      "Create “website-installation-acceptance” workspace"
    );
    await expect(creationApproval).toContainText(templatePin.url);
    await expect(creationApproval).toContainText(templatePin.commit);
    await clickApproval(creationApproval.getByRole("button", { name: "Allow once", exact: true }));
    await expect.poll(text).toContain("created:ws_");
    await reloadPanel(app, panel.id);
    await expect.poll(text).toContain("loaded:disconnected=true");
    await clickPanelSelector(app, panel.id, "#discover");
    await expect.poll(text).toContain("EWORKSPACE_DISCONNECTED");
    expect(await pendingConnections()).toEqual([]);
    await clickPanelSelector(app, panel.id, "#connect");
    const replacementApproval = await visibleConnectionApproval();
    await clickApproval(
      replacementApproval.getByRole("button", { name: "Connect this page", exact: true })
    );
    await expect.poll(text).toContain("connected:true");
    await clickPanelSelector(app, panel.id, "#receipt");
    const receiptApproval = await visibleConnectionApproval("workspaces.creation.read");
    await clickApproval(receiptApproval.getByRole("button", { name: "Allow once", exact: true }));
    await expect.poll(text).toContain("receipt:true");
  } finally {
    await app?.cleanup();
    if (workspacePath) removeManagedTestWorkspace(workspacePath);
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});
