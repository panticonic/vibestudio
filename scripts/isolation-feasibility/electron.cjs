const { app, BrowserWindow, net } = require('electron');
const fs = require('node:fs');
app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await w.loadURL('data:text/html,<title>isolation</title>');
  const title = await w.webContents.executeJavaScript('document.title');
  let hostDenied = false;
  try { fs.readFileSync(process.env.HOST_CANARY); } catch(e) { hostDenied = e.code === 'ENOENT'; }
  let hostNetworkDenied = false;
  try { await net.fetch(`http://127.0.0.1:${process.env.HOST_PORT}`); } catch { hostNetworkDenied = true; }
  console.log(JSON.stringify({ electron: title === 'isolation', rendererSandboxRequested: w.webContents.getLastWebPreferences().sandbox, hostCanaryDeniedFromMain: hostDenied, hostLoopbackDeniedFromChromiumNetwork: hostNetworkDenied }));
  app.quit();
}).catch(e => { console.error(e); app.exit(1); });
