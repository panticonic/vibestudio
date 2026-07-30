const BOOTSTRAP_UNARY_METHODS = new Set([
  "build.listUnits",
  "workspace.getConfig",
  "runtime.supervision.activate",
  "runtime.supervision.prepare",
  "runtime.supervision.rollback",
  "shellApproval.listPending",
  "shellApproval.resolveBootstrap",
]);

export function assertBootstrapRpcMessageAllowed(targetId: string, message: unknown): void {
  if (targetId !== "main") {
    throw new Error("Bootstrap launch gate can only call the host RPC endpoint");
  }
  if (!isBootstrapRpcRequest(message)) {
    throw new Error("Bootstrap launch gate can only send RPC requests");
  }
  const allowed = message.type === "request" && BOOTSTRAP_UNARY_METHODS.has(message.method);
  if (!allowed) {
    throw new Error(`Bootstrap launch gate is not allowed to call ${message.method}`);
  }
}

function isBootstrapRpcRequest(
  value: unknown
): value is { type: "request" | "stream-request"; method: string } {
  return (
    !!value &&
    typeof value === "object" &&
    ((value as { type?: unknown }).type === "request" ||
      (value as { type?: unknown }).type === "stream-request") &&
    typeof (value as { method?: unknown }).method === "string"
  );
}
