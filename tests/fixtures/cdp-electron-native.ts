import { app, BaseWindow, WebContentsView } from "electron";
import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { CdpHostProvider, type CdpHostProviderSocket } from "../../src/main/cdpHostProvider";

class LocalSocket extends EventEmitter implements CdpHostProviderSocket {
  readyState = 1;
  replies = new Map<string, { result?: unknown; error?: string }>();
  send(data: string): void {
    const message = JSON.parse(data);
    if (message.requestId) this.replies.set(message.requestId, message);
  }
  close(): void {
    this.readyState = 3;
    this.emit("close");
  }
}

app.setPath("userData", process.env["VIBESTUDIO_CDP_NATIVE_PROFILE"]!);
void app.whenReady().then(async () => {
  const window = new BaseWindow({ width: 1000, height: 800, show: true });
  const shell = new WebContentsView();
  window.contentView.addChildView(shell);
  shell.setBounds({ x: 0, y: 0, width: 1000, height: 800 });
  const target = new WebContentsView({ webPreferences: { backgroundThrottling: false } });
  window.contentView.addChildView(target, 0);
  target.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  target.setVisible(false);
  const socket = new LocalSocket();
  const provider = new CdpHostProvider({
    serverUrl: "ws://unused.test",
    hostConnectionId: "native-fixture",
    transport: {
      kind: "authenticated-websocket",
      authToken: "fixture",
      socketFactory: () => socket,
    },
    getViewManager: () => ({
      getWebContents: () => target.webContents,
      openDevTools: () => {},
      setAutomationSurfaceActive: async (_id, active) => {
        target.setBounds({ x: 0, y: 0, width: 817, height: 740 });
        target.setVisible(active);
      },
      captureView: async (_id, capture) => capture(target.webContents),
    }),
  });
  let request = 0;
  async function command(method: string, params?: Record<string, unknown>) {
    const requestId = String(++request);
    await provider.handleProviderMessageForTest({
      type: "cdp:command",
      targetId: "panel",
      requestId,
      method,
      params,
    });
    const reply = socket.replies.get(requestId);
    assert.ok(reply, `Missing reply for ${method}`);
    assert.equal(reply.error, undefined);
    return reply.result as { result: { value: unknown } };
  }
  async function clickAndObserve() {
    const point = (
      await command("Runtime.evaluate", {
        expression:
          "(()=>{const b=document.querySelector('button').getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2}})()",
        returnByValue: true,
      })
    ).result.value as { x: number; y: number };
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await command("Input.dispatchMouseEvent", {
        type,
        ...point,
        button: type === "mouseMoved" ? "none" : "left",
        clickCount: 1,
      });
    }
    return (await command("Runtime.evaluate", { expression: "window.clicks", returnByValue: true }))
      .result.value;
  }
  const html = `<button style="position:absolute;left:10%;top:30%" onclick="clicks.push(event.isTrusted)">Action</button><script>window.clicks=[]</script>`;
  try {
    await shell.webContents.loadURL("data:text/html,<h1>Covering shell</h1>");
    await target.webContents.loadURL(`data:text/html,${encodeURIComponent(html)}`);
    provider.start();
    socket.emit("open");
    provider.registerTarget("panel", target.webContents.id);
    await provider.handleProviderMessageForTest({
      type: "cdp:control",
      targetId: "panel",
      active: true,
    });
    assert.deepEqual(await clickAndObserve(), [true]);

    // Hide the stale document while rebuilding. The shell's next slot bind may
    // still be pending when DOM boot completes and automation resumes.
    target.setVisible(false);
    // Rebuild-style navigation retains the native view and automation clients.
    await target.webContents.loadURL(
      `data:text/html,${encodeURIComponent(html + "<!-- rebuilt -->")}`
    );
    assert.deepEqual(await clickAndObserve(), [true]);
    console.log(JSON.stringify({ initialTrustedClicks: 1, rebuiltTrustedClicks: 1 }));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    provider.stop();
    target.webContents.close();
    shell.webContents.close();
    window.destroy();
    app.quit();
  }
});
