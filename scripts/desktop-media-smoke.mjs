import { build } from "esbuild";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// Isolated native test: capture only a test page/canvas; never the user's desktop
// or physical camera/microphone. No Vibestudio instance or profile is reused.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const electron = require("electron");
const screenshotPath = process.argv[2] ? resolve(process.argv[2]) : null;
const temp = await mkdtemp(join(tmpdir(), "vibestudio-media-smoke-"));
let child;
try {
  const recording = await build({
    entryPoints: [join(root, "packages/shared/src/mediaRecording.ts")],
    bundle: true,
    format: "iife",
    globalName: "Recording",
    write: false,
  });
  await build({
    entryPoints: [join(root, "src/preload/displayCapturePreload.ts")],
    outfile: join(temp, "picker-preload.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
  });
  const entry = `
import { app, BrowserWindow, session, ipcMain } from 'electron';
import { writeFile } from 'node:fs/promises';
import http from 'node:http';
import assert from 'node:assert/strict';
import { BrowserPermissionController } from ${JSON.stringify(join(root, "src/main/services/browserPermissionController.ts"))};
async function run() {
app.setPath('userData', ${JSON.stringify(join(temp, "user-data"))});
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
await app.whenReady();
const server = http.createServer((_req, res) => res.end('<html><body><canvas width="32" height="32"></canvas></body></html>'));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = 'http://127.0.0.1:' + server.address().port + '/';
const requests = [];
let approveScreens = true;
const browser = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
const contents = browser.webContents;
const controller = new BrowserPermissionController({
  nativeStorageScope: 'isolated-smoke',
  serverClient: {
    call: async (_service, method, args) => {
      if (method === 'snapshot') return { environmentKey: 'browser_smoke', grants: [] };
      assert.equal(method, 'request');
      requests.push(args[0].capabilities);
      return { decision: args[0].capabilities.includes('screen-capture') ? 'once' : 'dismiss',
        granted: approveScreens && args[0].capabilities.includes('screen-capture'), grants: [] };
    },
    onDirectEvent: () => () => {},
  },
  eventService: { emit: () => {} },
  getViewManager: () => ({ findViewIdByWebContentsId: () => 'smoke-panel',
    isContentOverlayWebContentsId: () => false, getViewInfo: () => ({ type: 'browser', capabilities: [] }),
    getViewPartition: () => controllerPartition }),
  isTargetUnderAutomation: () => false,
  requestDeviceMediaAccess: async () => true,
});
const controllerPartition = await controller.attachBrowserEnvironment();
// No physical-device status is inspected in this fake-device test.
session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
  if (permission === 'media') { requests.push(details.mediaTypes.map(kind => kind === 'audio' ? 'microphone' : 'camera')); callback(false); }
  else controller.requestPermission(wc, permission, callback, details);
});
session.defaultSession.setPermissionCheckHandler(controller.checkPermission);
let chosen = 0;
session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => { chosen++; callback({ video: contents.mainFrame }); });
try {
  await browser.loadURL(url);
  const captured = await contents.executeJavaScript(
    'navigator.mediaDevices.getDisplayMedia({video:true}).then(stream => { const count=stream.getTracks().length; stream.getTracks().forEach(track=>track.stop()); return count; })', true);
  assert.equal(captured, 1);
  assert.equal(chosen, 1);
  assert.deepEqual(requests[0], ['screen-capture']);
  const denied = await contents.executeJavaScript(
    'navigator.mediaDevices.getUserMedia({video:true,audio:true}).then(()=>false, error=>error.name === "NotAllowedError")');
  assert.equal(denied, true);
  assert.deepEqual(requests[1], ['microphone', 'camera']);
  approveScreens = false;
  const legacyDenied = await contents.executeJavaScript(
    'navigator.mediaDevices.getUserMedia({video:{mandatory:{chromeMediaSource:"desktop"}}}).then(()=>false, error=>error.name === "NotAllowedError")');
  assert.equal(legacyDenied, true);
  assert.deepEqual(requests[2], ['screen-capture']);
  assert.equal(chosen, 1);
  await contents.executeJavaScript(${JSON.stringify(recording.outputFiles[0].text)});
  const encoded = await contents.executeJavaScript(
    '(async () => { const canvas=document.querySelector("canvas"); const context=canvas.getContext("2d"); const stream=canvas.captureStream(30); const recording=Recording.recordMediaStream(stream); const timer=setInterval(()=>{context.fillStyle="red";context.fillRect(0,0,32,32)},20); const reader=recording.body.getReader(); const first=await reader.read(); await reader.cancel(); clearInterval(timer); return {bytes:first.value.byteLength, type:recording.contentType, ended:stream.getTracks().every(track=>track.readyState === "ended")}; })()');
  assert.ok(encoded.bytes > 0);
  assert.ok(encoded.type.includes('video/'));
  assert.equal(encoded.ended, true);
  const bounded = await contents.executeJavaScript(
    '(async () => { const canvas=document.querySelector("canvas"); const stream=canvas.captureStream(30); const recording=Recording.recordMediaStream(stream,{maxBufferedBytes:1}); const timer=setInterval(()=>canvas.getContext("2d").fillRect(0,0,32,32),20); let failed=false; try { await recording.body.getReader().read(); } catch(error) { failed=error.message.includes("could not keep up"); } clearInterval(timer); return {failed,ended:stream.getTracks().every(track=>track.readyState === "ended")}; })()');
  assert.deepEqual(bounded, { failed: true, ended: true });
  const thumbnail = await contents.executeJavaScript('document.querySelector("canvas").toDataURL()');
  const picker = new BrowserWindow({ show: false, width: 820, height: 640,
    webPreferences: { sandbox: true, contextIsolation: true, preload: ${JSON.stringify(join(temp, "picker-preload.cjs"))} } });
  let selection = null;
  ipcMain.handle('vibestudio:display-capture-picker', (event, action, index) => {
    assert.equal(event.sender, picker.webContents);
    if (action === 'snapshot') return { origin: 'https://meeting.example', audioAvailable: true,
      sources: [{ index: 0, name: 'Fixture display', kind: 'Screen', thumbnail }, { index: 1, name: 'Fixture meeting', kind: 'Window', thumbnail }] };
    selection = index;
  });
  try {
    await picker.loadFile(${JSON.stringify(join(root, "src/main/displayCapture.html"))});
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(await picker.webContents.executeJavaScript('document.querySelectorAll(".source").length'), 2);
    assert.equal(await picker.webContents.executeJavaScript('document.getElementById("share").disabled'), true);
    await picker.webContents.executeJavaScript('document.querySelectorAll(".source")[1].click()');
    assert.equal(await picker.webContents.executeJavaScript('document.getElementById("share").disabled'), false);
    if (${JSON.stringify(screenshotPath)}) await writeFile(${JSON.stringify(screenshotPath)}, (await picker.webContents.capturePage()).toPNG());
    await picker.webContents.executeJavaScript('document.getElementById("share").click()');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(selection, 1);
  } finally { picker.destroy(); ipcMain.removeHandler('vibestudio:display-capture-picker'); }
  console.log(JSON.stringify({ electron: process.versions.electron, screenApproval: requests[0], cameraMicrophone: requests[1], legacyDenied, encoded, bounded }));
} finally { controller.stop(); browser.destroy(); server.close(); app.quit(); }
}
run().catch(error => { console.error(error); process.exit(1); });
`;
  await writeFile(join(temp, "entry.mjs"), entry);
  await build({
    entryPoints: [join(temp, "entry.mjs")],
    outfile: join(temp, "main.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    tsconfig: join(root, "tsconfig.json"),
  });
  await writeFile(join(temp, "package.json"), JSON.stringify({ main: "main.cjs" }));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(electron, [temp], {
    env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  const exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
  const timeout = setTimeout(() => {
    process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL");
  }, 30000);
  try {
    if ((await exit) !== 0) throw new Error("Native media smoke failed");
  } finally {
    clearTimeout(timeout);
  }
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL");
    } catch {
      /* The owned process has already exited. */
    }
    await new Promise((resolve) => child.once("exit", resolve));
  }
  await rm(temp, { recursive: true, force: true });
}
