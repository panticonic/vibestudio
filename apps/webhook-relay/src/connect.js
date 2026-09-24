import {
  connectWorkspace,
  disconnectWorkspace,
  workspaceConnection,
} from "/runtime.js";

const button = document.querySelector("#workspace-connect-button");
const status = document.querySelector("#workspace-connection-status");

function renderConnection() {
  const connection = workspaceConnection;

  if (!connection.available) {
    button.textContent = "Open in Vibestudio to connect";
    button.disabled = true;
    status.textContent = "Open this page in Vibestudio to connect it to a workspace.";
  } else if (connection.connected) {
    button.textContent = "Disconnect";
    button.disabled = false;
    status.textContent = "Connected to this workspace.";
  } else if (connection.status === "connecting") {
    button.textContent = "Waiting for approval";
    button.disabled = true;
    status.textContent = "Approve this connection in Vibestudio.";
  } else {
    button.textContent = "Connect to workspace";
    button.disabled = connection.status === "disconnecting";
    status.textContent = connection.error ?? "This page starts without workspace access.";
  }
}

workspaceConnection.subscribe(renderConnection);
button.addEventListener("click", async () => {
  if (workspaceConnection.connected) {
    try {
      await disconnectWorkspace();
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
    }
    return;
  }

  button.disabled = true;
  status.textContent = "Requesting a connection to this workspace…";
  try {
    await connectWorkspace();
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    renderConnection();
  }
});

renderConnection();
