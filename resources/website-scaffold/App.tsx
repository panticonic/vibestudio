import { useEffect, useRef, useState } from "react";
import {
  connectWorkspace,
  disconnectWorkspace,
  templates,
  workspaces,
  contextId,
  workspaceConnection,
  rpc,
  createConversationClient,
} from "@workspace/runtime";

/** Shared application source: installed panel entry and ordinary static website entry both render this. */
export default function App() {
  const operation = useRef(0);
  const [connected, setConnected] = useState(workspaceConnection.connected);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [templateUrl, setTemplateUrl] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [pending, setPending] = useState<Parameters<typeof workspaces.create>[0] | null>(null);
  const [receiptMissing, setReceiptMissing] = useState(false);
  const [channelId, setChannelId] = useState("");
  const [message, setMessage] = useState("");
  const [conversation, setConversation] = useState<unknown[]>([]);
  const [listening, setListening] = useState(false);
  const conversationClient = useRef(createConversationClient(rpc));
  const subscriptionAbort = useRef<AbortController | null>(null);
  const conversationGeneration = useRef(0);
  function invalidateConversation() {
    ++conversationGeneration.current;
    subscriptionAbort.current?.abort();
    subscriptionAbort.current = null;
    setListening(false);
    setConversation([]);
  }
  const creationKey = () => `vibestudio:creation:${contextId}`;
  function readPending() {
    const saved = localStorage.getItem(creationKey());
    const request = saved ? JSON.parse(saved) : null;
    if (
      request &&
      (typeof request.operationId !== "string" || typeof request.workspace !== "string")
    )
      throw new Error(
        "Saved creation request is invalid; inspect the stored request before retrying"
      );
    setPending(request);
    setReceiptMissing(false);
  }
  const [inspection, setInspection] = useState<Awaited<
    ReturnType<typeof templates.inspect>
  > | null>(null);
  useEffect(() => {
    if (workspaceConnection.connected) {
      try {
        readPending();
      } catch (error) {
        setStatus(String(error));
      }
    }
    const unsubscribe = workspaceConnection.subscribe(() => {
      setConnected(workspaceConnection.connected);
      if (!workspaceConnection.connected) {
        ++operation.current;
        invalidateConversation();
        setBusy(false);
        setInspection(null);
        setPending(null);
        setStatus("Workspace access ended. Connect again to continue.");
      }
    });
    return () => {
      ++operation.current;
      ++conversationGeneration.current;
      subscriptionAbort.current?.abort();
      subscriptionAbort.current = null;
      unsubscribe();
    };
  }, []);
  async function connect() {
    const current = ++operation.current;
    setBusy(true);
    setStatus("Waiting for workspace connection approval…");
    try {
      await connectWorkspace();
      if (current === operation.current) {
        readPending();
        setStatus("Connected. Resource requests are approved separately.");
      }
    } catch (error) {
      if (current === operation.current)
        setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      if (current === operation.current) setBusy(false);
    }
  }
  async function inspectTemplate() {
    const current = ++operation.current;
    setBusy(true);
    try {
      const result = await templates.inspect({ url: templateUrl });
      // A result from a retired document must not repopulate the current UI.
      if (current === operation.current && workspaceConnection.connected) {
        setInspection(result);
        setStatus("Template source verified. Installing it is a separate reviewed action.");
      }
    } catch (error) {
      if (current === operation.current)
        setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      if (current === operation.current) setBusy(false);
    }
  }
  async function createWorkspace() {
    if (!inspection || pending) return;
    return submitCreation({
      operationId: crypto.randomUUID(),
      workspace: workspaceName.trim(),
      rootTemplate: inspection.pin,
    });
  }
  async function submitCreation(request: Parameters<typeof workspaces.create>[0]) {
    const current = ++operation.current;
    const key = creationKey();
    setReceiptMissing(false);
    setBusy(true);
    try {
      // Persist exact inputs before the effect; a lost reply must not mint a new ID.
      localStorage.setItem(key, JSON.stringify(request));
      setPending(request);
      const receipt = await workspaces.create(request);
      if (current === operation.current && workspaceConnection.connected) {
        localStorage.removeItem(key);
        setPending(null);
        setStatus(
          `Workspace ${receipt.name}: ${receipt.state}. Open it from the workspace chooser.`
        );
      }
    } catch (error) {
      if (current === operation.current) setStatus(String(error));
    } finally {
      if (current === operation.current) setBusy(false);
    }
  }
  async function reconcileCreation() {
    if (!pending) return;
    const current = ++operation.current;
    const key = creationKey();
    setBusy(true);
    try {
      const receipt = await workspaces.receipt({ operationId: pending.operationId });
      if (current !== operation.current || !workspaceConnection.connected) return;
      if (!receipt) {
        setReceiptMissing(true);
        setStatus(
          "No receipt exists in this connection. Retry the saved exact request to create it here, using the same operation ID."
        );
      } else {
        localStorage.removeItem(key);
        setPending(null);
        setStatus(
          `Workspace ${receipt.name}: ${receipt.state}. This result was recovered without creating another workspace.`
        );
      }
    } catch (error) {
      if (current === operation.current) setStatus(String(error));
    } finally {
      if (current === operation.current) setBusy(false);
    }
  }
  async function loadConversation() {
    if (!channelId.trim()) return;
    const current = conversationGeneration.current;
    setBusy(true);
    try {
      const result = await conversationClient.current.history(channelId.trim());
      if (current !== conversationGeneration.current) return;
      setConversation(Array.isArray(result) ? result : [result]);
      setStatus("Conversation history loaded from the connected workspace.");
    } catch (error) {
      if (current === conversationGeneration.current)
        setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      if (current === conversationGeneration.current) setBusy(false);
    }
  }
  async function sendMessage() {
    if (!channelId.trim() || !message.trim()) return;
    const current = conversationGeneration.current;
    setBusy(true);
    try {
      await conversationClient.current.send(channelId.trim(), message.trim());
      if (current !== conversationGeneration.current) return;
      setMessage("");
      setStatus("Message accepted by the ordinary workspace conversation.");
    } catch (error) {
      if (current === conversationGeneration.current)
        setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      if (current === conversationGeneration.current) setBusy(false);
    }
  }
  async function listenToConversation() {
    if (!channelId.trim()) return;
    subscriptionAbort.current?.abort();
    const abort = new AbortController();
    subscriptionAbort.current = abort;
    const current = conversationGeneration.current;
    setListening(true);
    try {
      await conversationClient.current.subscribe(
        channelId.trim(),
        "website-participant",
        { name: "website chat", transport: "rpc" },
        (record: unknown) => {
          if (current === conversationGeneration.current && !abort.signal.aborted)
            setConversation((items) => [...items, record]);
        },
        { signal: abort.signal }
      );
    } catch (error) {
      if (!abort.signal.aborted && current === conversationGeneration.current)
        setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      if (subscriptionAbort.current === abort) {
        subscriptionAbort.current = null;
        setListening(false);
      }
    }
  }
  function stopListening() {
    subscriptionAbort.current?.abort();
  }
  return (
    <main>
      <p className="eyebrow">Vibestudio enabled</p>
      <h1>A website, connected to your workspace.</h1>
      <p>
        This page starts with no workspace access. Connecting requires your approval in Vibestudio.
      </p>
      {!workspaceConnection.available ? (
        <p>
          Open this URL in a Vibestudio browser panel to connect. You can still read the page in any
          browser.
        </p>
      ) : !connected ? (
        <button disabled={busy} onClick={() => void connect()}>
          Connect to workspace
        </button>
      ) : (
        <div className="actions">
          <label>
            Template source URL
            <input
              type="url"
              value={templateUrl}
              onChange={(event) => setTemplateUrl(event.target.value)}
              placeholder="https://github.com/owner/template"
            />
          </label>
          <button disabled={busy || !templateUrl.trim()} onClick={() => void inspectTemplate()}>
            Inspect template
          </button>
          {workspaceConnection.kind === "website" && (
            <button
              onClick={() => {
                subscriptionAbort.current?.abort();
                void disconnectWorkspace().catch((error: unknown) => setStatus(String(error)));
              }}
            >
              Disconnect
            </button>
          )}
        </div>
      )}
      <p role="status" aria-live="polite">
        {status}
      </p>
      {connected && pending && (
        <section>
          <h2>Unresolved workspace creation</h2>
          <p>{pending.workspace}</p>
          <p>
            Operation: <code>{pending.operationId}</code>
          </p>
          <button disabled={busy} onClick={() => void reconcileCreation()}>
            Check previous creation
          </button>
          {receiptMissing && (
            <button disabled={busy} onClick={() => void submitCreation(pending)}>
              Retry exact request
            </button>
          )}
        </section>
      )}
      {inspection && (
        <section>
          <h2>{inspection.presentation?.name ?? "Verified template"}</h2>
          <p>{inspection.presentation?.description}</p>
          <p>
            {inspection.repositories.length} repositories · {inspection.files.length} files
          </p>
          <p>
            Exact Git commit: <code>{inspection.pin.commit}</code>
          </p>
          <label>
            New workspace name
            <input
              value={workspaceName}
              onChange={(event) => setWorkspaceName(event.target.value)}
            />
          </label>
          <button
            disabled={busy || !!pending || !workspaceName.trim()}
            onClick={() => void createWorkspace()}
          >
            Create workspace
          </button>
        </section>
      )}
      {connected && (
        <section aria-labelledby="conversation-heading">
          <h2 id="conversation-heading">Workspace conversation</h2>
          <p>Read, send, and stream messages in an existing workspace channel.</p>
          <label>
            Channel RPC target
            <input
              value={channelId}
              onChange={(event) => {
                invalidateConversation();
                setBusy(false);
                setChannelId(event.target.value);
              }}
            />
          </label>
          <div className="actions">
            <button disabled={busy || !channelId.trim()} onClick={() => void loadConversation()}>
              Load history
            </button>
            <button
              disabled={busy || listening || !channelId.trim()}
              onClick={() => void listenToConversation()}
            >
              {listening ? "Listening…" : "Stream updates"}
            </button>
            {listening && <button onClick={stopListening}>Stop stream</button>}
          </div>
          <label>
            Message
            <input value={message} onChange={(event) => setMessage(event.target.value)} />
          </label>
          <button
            disabled={busy || !channelId.trim() || !message.trim()}
            onClick={() => void sendMessage()}
          >
            Send message
          </button>
          <pre aria-label="Conversation events">{JSON.stringify(conversation, null, 2)}</pre>
        </section>
      )}
    </main>
  );
}
