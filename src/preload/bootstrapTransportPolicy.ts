const BOOTSTRAP_RPC_METHODS = new Set([
  "shellApproval.listPending",
  "shellApproval.resolveBootstrap",
  "workspace.hostTargets.launch",
]);

export function assertBootstrapRpcMessageAllowed(targetId: string, message: unknown): void {
  if (targetId !== "main") {
    throw new Error("Bootstrap launch gate can only call the host RPC endpoint");
  }
  if (!isRpcRequest(message)) {
    throw new Error("Bootstrap launch gate can only send RPC requests");
  }
  if (!BOOTSTRAP_RPC_METHODS.has(message.method)) {
    throw new Error(`Bootstrap launch gate is not allowed to call ${message.method}`);
  }
}

function isRpcRequest(value: unknown): value is { type: "request"; method: string } {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { type?: unknown }).type === "request" &&
    typeof (value as { method?: unknown }).method === "string"
  );
}
