import { build } from "esbuild";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// Exercise the real capture owner and native view lifecycle against toy pages.
// No developer instance, user profile, or desktop screenshot is used.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const temp = await mkdtemp(join(tmpdir(), "vibestudio-frame-smoke-"));
let child;
let exited;
let timer;
try {
  await writeFile(join(temp, "preload.cjs"), "");
  await writeFile(join(temp, "shell.html"), '<body style="margin:0;background:blue">shell');
  await build({
    stdin: {
      resolveDir: root,
      contents: `
import { app, BaseWindow, nativeImage, webContents } from 'electron';
import assert from 'node:assert/strict';
import { ViewManager } from './src/main/viewManager.ts';
import { CdpHostProvider } from './src/main/cdpHostProvider.ts';
app.setPath('userData', ${JSON.stringify(join(temp, "profile"))});
async function run() {
  await app.whenReady();
  const window = new BaseWindow({ width: 600, height: 400, show: false });
  const views = new ViewManager({ window,
    shellPreload: ${JSON.stringify(join(temp, "preload.cjs"))},
    shellHtmlPath: ${JSON.stringify(join(temp, "shell.html"))},
    showWindowOnShellLoad: false });
  const provider = new CdpHostProvider({ serverUrl: 'ws://127.0.0.1:1',
    hostConnectionId: 'frame-smoke',
    transport: { kind: 'authenticated-websocket', authToken: 'unused' },
    getViewManager: () => views });
  const shell = views.getWebContents('shell');
  try {
    if (shell.isLoading()) await new Promise(resolve => shell.once('did-finish-load', resolve));
    const panel = views.createView({ id: 'frame-smoke', type: 'panel' });
    await panel.webContents.loadURL('data:text/html,<body style="margin:0;background:red">panel');
    // A hidden unslotted panel begins at zero bounds, just like a runtime
    // inspected before the hosted shell has bound it to a panel slot.
    function assertColor(shot, channel) {
      const image = nativeImage.createFromBuffer(Buffer.from(shot.data, 'base64'));
      assert.equal(image.isEmpty(), false);
      const pixels = image.toBitmap();
      const offset = Math.floor(pixels.length / 8) * 4;
      assert.equal(pixels[offset + channel], 255);
      assert.ok(shot.width > 0 && shot.height > 0);
    }
    assertColor(await provider.captureScreenshot('frame-smoke'), 2);
    assert.equal(window.isVisible(), window.isFocused());
    assert.equal(views.isViewVisible('frame-smoke'), false);
    console.log('hidden parent + unslotted zero-bounds panel: captured red panel');

    window.showInactive();
    await shell.executeJavaScript('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
    const input = views.createView({ id: 'input-smoke', type: 'panel' });
    await input.webContents.loadURL('data:text/html,<body style="margin:0;background:red">panel');
    await provider.handleProviderMessageForTest({ type: 'cdp:control', targetId: 'input-smoke', active: true });
    await input.webContents.executeJavaScript('document.body.onclick = event => { document.body.style.background = "lime"; window.trustedClick = event.isTrusted; }; undefined');
    for (const type of ['mousePressed', 'mouseReleased']) {
      await provider.handleProviderMessageForTest({ type: 'cdp:command', targetId: 'input-smoke',
        requestId: type, method: 'Input.dispatchMouseEvent',
        params: { type, x: 10, y: 10, button: 'left', clickCount: 1 } });
    }
    assert.equal(await input.webContents.executeJavaScript('window.trustedClick'), true);
    assertColor(await provider.captureScreenshot('input-smoke'), 1);
    assert.equal(views.isViewVisible('input-smoke'), false);
    assert.ok(window.contentView.children.indexOf(input) < window.contentView.children.findIndex(view => view.webContents === shell));
    await provider.handleProviderMessageForTest({ type: 'cdp:detach', targetId: 'input-smoke' });
    assert.equal(input.getVisible(), false);
    console.log('covered automation panel: trusted click, captured updated green panel, released surface');
  } finally {
    provider.stop();
    const released = Promise.all(webContents.getAllWebContents().map(contents =>
      new Promise(resolve => contents.once('destroyed', resolve))));
    views.destroy();
    // BaseWindow does not own the lifetime of its child WebContents.
    shell.close();
    await released;
    window.close();
  }
}
run().then(() => app.quit(), error => { console.error(error); app.exit(1); });
`,
    },
    outfile: join(temp, "main.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
  });
  child = spawn(require("electron"), [join(temp, "main.cjs")], {
    stdio: "inherit",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
  });
  exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  timer = setTimeout(() => child.kill("SIGTERM"), 30_000);
  const result = await exited;
  if (result.code !== 0) throw new Error(`Frame smoke failed: ${JSON.stringify(result)}`);
} finally {
  clearTimeout(timer);
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await exited;
  }
  await rm(temp, { recursive: true, force: true });
}
