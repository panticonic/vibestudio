// Run on Linux with: xvfb-run -a node scripts/fullscreen-electron-smoke.mjs
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratchRoot = path.join(root, ".tmp");
await mkdir(scratchRoot, { recursive: true });
const scratch = await mkdtemp(path.join(scratchRoot, "fullscreen-smoke-"));
let childProcess;
let evidence = "";
try {
  const bootstrap = path.join(scratch, "bootstrap.html");
  const preload = path.join(scratch, "preload.cjs");
  await writeFile(bootstrap, "<!doctype html><title>Fullscreen smoke bootstrap</title>");
  await writeFile(preload, "");
  const entry = path.join(scratch, "main.cjs");
  await build({
    stdin: {
      resolveDir: root,
      sourcefile: "fullscreen-smoke.ts",
      loader: "ts",
      contents: `
import { app, BaseWindow, session } from "electron";
import { once } from "node:events";
import http from "node:http";
import assert from "node:assert/strict";
import { ViewManager } from "./src/main/viewManager.ts";
import { nativeViewMayUsePermission } from "./src/main/nativeViewPermissionPolicy.ts";

app.setPath("userData", ${JSON.stringify(path.join(scratch, "profile"))});
console.log("[fullscreen-smoke] waiting for app readiness");
let window, vm;
const ready = app.whenReady().then(() => {
  console.log("[fullscreen-smoke] creating window");
  window = new BaseWindow({ width: 1000, height: 700, show: true });
  console.log("[fullscreen-smoke] creating view manager");
  vm = new ViewManager({ window, shellPreload: ${JSON.stringify(preload)}, shellHtmlPath: ${JSON.stringify(bootstrap)} });
  console.log("[fullscreen-smoke] ready");
});
globalThis.runFullscreenSmoke = async () => {
  await ready;
  const child = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end('<!doctype html><video id="media" controls></video>');
  });
  const parent = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end('<!doctype html><video id="media" controls></video><iframe allow="fullscreen" src="http://127.0.0.1:' + child.address().port + '"></iframe>');
  });
  try {
    await new Promise(resolve => child.listen(0, "127.0.0.1", resolve));
    await new Promise(resolve => parent.listen(0, "127.0.0.1", resolve));
    const view = vm.createView({ id: "chat", type: "panel", partition: "fullscreen-smoke" });
    const contents = view.webContents;
    contents.on("console-message", event => console.log("[fullscreen-smoke] renderer: " + event.message));
    const ses = session.fromPartition("fullscreen-smoke");
    ses.setPermissionCheckHandler((wc, permission) => nativeViewMayUsePermission(vm, wc.id, permission));
    ses.setPermissionRequestHandler((wc, permission, callback) => {
      const allowed = nativeViewMayUsePermission(vm, wc.id, permission);
      callback(allowed);
    });
    const url = "http://127.0.0.1:" + parent.address().port;
    await vm.navigateView("chat", url);
    vm.createView({
      id: "@workspace-apps/shell", type: "app", hostChrome: true,
      workspaceIdentity: { workspaceId: "fullscreen-smoke", runtimeId: "@workspace-apps/shell" },
      appCapabilities: ["panel-hosting"],
    });
    vm.setHostedShellReady("@workspace-apps/shell", true, "smoke");
    vm.bindPanelSlot("@workspace-apps/shell", {
      nativeSlotId: "primary", bindingId: "chat", panelId: "chat",
      rendererInstanceId: "smoke", bindingSequence: 1, operationSequence: 1,
      bounds: { x: 80, y: 90, width: 500, height: 400 }, focused: true,
    });
    await contents.executeJavaScript("window.incarnation = crypto.randomUUID()");
    const incarnation = await contents.executeJavaScript("window.incarnation");
    const checkFullscreen = () => {
      const [width, height] = window.getContentSize();
      assert.deepEqual(view.getBounds(), { x: 0, y: 0, width, height });
      assert.equal(vm.getFullscreenPanelId(), "chat");
      assert.equal(window.contentView.children.includes(view), true);
    };
    const enter = async frame => {
      const entered = once(contents, "enter-html-full-screen");
      await frame.executeJavaScript('document.querySelector("video").requestFullscreen()', true);
      await entered;
      checkFullscreen();
    };
    const escape = async () => {
      console.log("[fullscreen-smoke] sending Escape");
      await contents.executeJavaScript('void (window.documentLeft = new Promise(resolve => { const left = () => { if (!document.fullscreenElement) { document.removeEventListener("fullscreenchange", left); resolve(); } }; document.addEventListener("fullscreenchange", left); }))');
      const left = once(contents, "leave-html-full-screen");
      contents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
      contents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
      await left;
      console.log("[fullscreen-smoke] native HTML exit; completing DOM tree, element=" + await contents.executeJavaScript("document.fullscreenElement?.tagName"));
      await contents.executeJavaScript("window.documentLeft");
      assert.equal(await contents.executeJavaScript("document.fullscreenElement === null"), true);
    };

    console.log("[fullscreen-smoke] panel presentation");
    await vm.togglePanelFullscreen("chat");
    checkFullscreen();
    const latestBounds = { x: 80, y: 90, width: 420, height: 300 };
    vm.updatePanelSlot("@workspace-apps/shell", {
      nativeSlotId: "primary", bindingId: "chat", rendererInstanceId: "smoke",
      bindingSequence: 1, operationSequence: 2, bounds: latestBounds,
    });
    checkFullscreen();
    await vm.togglePanelFullscreen("chat");
    assert.deepEqual(view.getBounds(), latestBounds);
    assert.equal(await contents.executeJavaScript("window.incarnation"), incarnation);

    await contents.executeJavaScript('document.addEventListener("keydown", event => { if (event.key === "Escape") event.preventDefault(); })');
    console.log("[fullscreen-smoke] media presentation");
    await enter(contents.mainFrame);
    await escape();
    assert.equal(vm.getFullscreenPanelId(), null);
    assert.deepEqual(view.getBounds(), latestBounds);

    console.log("[fullscreen-smoke] cross-origin nesting");
    await vm.togglePanelFullscreen("chat");
    const frame = contents.mainFrame.frames.find(frame => frame.url.startsWith("http://127.0.0.1:" + child.address().port));
    assert.ok(frame, "cross-origin media frame loaded");
    await enter(frame);
    assert.equal(await contents.executeJavaScript('document.fullscreenElement.tagName'), "IFRAME");
    await escape();
    checkFullscreen();
    await vm.toggleWindowFullscreen();
    assert.equal(vm.getFullscreenPanelId(), null);

    console.log("[fullscreen-smoke] preserving window fullscreen preference");
    await vm.toggleWindowFullscreen();
    assert.equal(window.isFullScreen(), true);
    await enter(contents.mainFrame);
    assert.equal(vm.getWindowFullscreenPreference(), true);
    await escape();
    assert.equal(vm.getFullscreenPanelId(), null);
    assert.equal(window.isFullScreen(), true);
    await vm.toggleWindowFullscreen();

    console.log("[fullscreen-smoke] navigation and hidden-page rejection");
    await enter(contents.mainFrame);
    console.log("[fullscreen-smoke] navigating fullscreen page");
    await vm.navigateView("chat", url + "/next");
    console.log("[fullscreen-smoke] navigation completed");
    assert.equal(vm.getFullscreenPanelId(), null);
    vm.setViewVisible("chat", false);
    assert.equal(nativeViewMayUsePermission(vm, contents.id, "fullscreen"), false);
    assert.equal(vm.getFullscreenPanelId(), null);
    return { passed: ["panel fullscreen", "live layout restoration", "page preservation", "media fullscreen", "Escape", "cross-origin nested media", "window toggle", "window preference preservation", "navigation", "hidden-page admission"] };
  } finally {
    vm?.destroy();
    if (window && !window.isDestroyed()) window.destroy();
    await Promise.all([child, parent].map(server => new Promise(resolve => server.close(resolve))));
  }
};
globalThis.runFullscreenSmoke().then(
  result => { console.log(JSON.stringify(result)); app.quit(); },
  error => { console.error(error); app.exit(1); }
);`,
    },
    outfile: entry,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    logLevel: "warning",
  });
  childProcess = spawn(
    path.join(root, "node_modules/electron/dist/electron"),
    ["--ozone-platform=x11", entry],
    {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  const forwardSignal = (signal) => childProcess.kill(signal);
  const interrupt = () => forwardSignal("SIGINT");
  const terminate = () => forwardSignal("SIGTERM");
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  for (const stream of [childProcess.stdout, childProcess.stderr]) {
    stream?.on("data", (chunk) => {
      const text = chunk.toString();
      evidence = (evidence + text).slice(-8000);
      process.stdout.write(text);
    });
  }
  try {
    const code = await new Promise((resolve, reject) => {
      childProcess.once("error", reject);
      childProcess.once("close", resolve);
    });
    if (code !== 0) throw new Error("Fullscreen smoke failed with exit code " + code);
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
} catch (error) {
  if (evidence) console.error(evidence);
  throw error;
} finally {
  await rm(scratch, { recursive: true, force: true });
}
