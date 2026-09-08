import { useEffect, useRef, useState } from "react";
import { connectWorkspace, disconnectWorkspace, templates, workspaceConnection } from "@workspace/runtime";

/** Shared application source: installed panel entry and ordinary static website entry both render this. */
export default function App() {
  const operation = useRef(0);
  const [connected, setConnected] = useState(workspaceConnection.connected);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [templateUrl, setTemplateUrl] = useState("");
  const [inspection, setInspection] = useState<Awaited<ReturnType<typeof templates.inspect>> | null>(null);
  useEffect(() => {
    const unsubscribe = workspaceConnection.subscribe(() => {
    setConnected(workspaceConnection.connected);
    if (!workspaceConnection.connected) {
      ++operation.current;
      setBusy(false);
      setInspection(null);
      setStatus("Workspace access ended. Connect again to continue.");
    }
    });
    return () => { ++operation.current; unsubscribe(); };
  }, []);
  async function connect() {
    const current = ++operation.current;
    setBusy(true);
    setStatus("Waiting for workspace connection approval…");
    try { await connectWorkspace(); if (current === operation.current) setStatus("Connected. Resource requests are approved separately."); }
    catch (error) { if (current === operation.current) setStatus(error instanceof Error ? error.message : String(error)); }
    finally { if (current === operation.current) setBusy(false); }
  }
  async function inspectTemplate() {
    const current = ++operation.current;
    setBusy(true);
    try {
      const result = await templates.inspect({ url: templateUrl });
      // A result from a retired document must not repopulate the current UI.
      if (current === operation.current && workspaceConnection.connected) { setInspection(result); setStatus("Template source verified. Installing it is a separate reviewed action."); }
    } catch (error) { if (current === operation.current) setStatus(error instanceof Error ? error.message : String(error)); }
    finally { if (current === operation.current) setBusy(false); }
  }
  return <main>
    <p className="eyebrow">Vibestudio enabled</p>
    <h1>A website, connected to your workspace.</h1>
    <p>This page starts with no workspace access. Connecting requires your approval in Vibestudio.</p>
    {!workspaceConnection.available ? <p>Open this URL in a Vibestudio browser panel to connect. You can still read the page in any browser.</p>
      : !connected ? <button disabled={busy} onClick={() => void connect()}>Connect to workspace</button>
      : <div className="actions">
          <label>Template source URL<input type="url" value={templateUrl} onChange={event => setTemplateUrl(event.target.value)} placeholder="https://github.com/owner/template" /></label>
          <button disabled={busy || !templateUrl.trim()} onClick={() => void inspectTemplate()}>Inspect template</button>
          {workspaceConnection.kind === "website" && <button onClick={() => void disconnectWorkspace().catch(error => setStatus(String(error)))}>Disconnect</button>}
        </div>}
    <p role="status" aria-live="polite">{status}</p>
    {inspection && <section><h2>{inspection.presentation?.name ?? "Verified template"}</h2>
      <p>{inspection.presentation?.description}</p><p>{inspection.repositories.length} repositories · {inspection.files.length} files</p>
      <p>Exact Git commit: <code>{inspection.pin.commit}</code></p>
    </section>}
  </main>;
}
