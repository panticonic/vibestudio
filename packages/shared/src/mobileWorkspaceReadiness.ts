/** Evidence parsed from one native logcat epoch window. */
export function workspaceReadinessFromLog(log: string, sinceMs = 0) {
  const relevant = log
    .split(/\r?\n/u)
    .filter((line) => {
      const timestamp = /^\s*(\d+(?:\.\d+)?)\s/u.exec(line)?.[1];
      return !timestamp || Number(timestamp) * 1000 >= sinceMs;
    })
    .join("\n");
  const panelHostReady = relevant.includes("phase=workspace-shell-ready");
  const workspaceConnected = relevant.includes("phase=workspace-iroh-connected");
  const panelWebViewLoaded = relevant.includes("phase=workspace-panel-webview-loaded");
  const failure = relevant.match(
    /invalid distance code|phase=workspace-(?:login-error|panel-webview-error|panel-webview-http-error|panel-activate-failed)[^\r\n]*/iu
  )?.[0];
  return {
    ready: panelHostReady && workspaceConnected && !failure,
    workspaceConnected,
    panelHostReady,
    panelWebViewLoaded,
    issues: failure ? [failure] : [],
  };
}
