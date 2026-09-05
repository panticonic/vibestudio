/** Worker half of the owner-to-native operation protocol. It exposes only the
 * installed handler; no worker operation can cause an owner-side dispatch. */
export function serveNativeOperations(
  handler: (method: string, args: unknown[], signal: AbortSignal) => Promise<unknown>,
  stop: () => Promise<void>
): void {
  if (!process.send || !process.disconnect) throw new Error("Native operation worker requires inherited IPC");
  const disconnectIpc = process.disconnect.bind(process);
  const active = new Map<string, AbortController>();
  let stopped = false;
  let queuedBytes = 0;
  const MAX_BYTES = 32 * 1024 * 1024;
  let retirement: Promise<void> | undefined;
  const retire = (): Promise<void> => {
    if (retirement) return retirement;
    stopped = true;
    for (const controller of active.values())
      controller.abort(new Error("Native owner disconnected"));
    active.clear();
    retirement = Promise.resolve().then(stop);
    return retirement;
  };
  const disconnect = () => {
    if (process.connected) disconnectIpc();
    void retire().then(
      () => process.exit(0),
      () => process.exit(1)
    );
  };
  process.once("disconnect", disconnect);
  process.on("error", disconnect);
  process.on("message", (frame: unknown) => {
    if (stopped) return;
    if (!frame || typeof frame !== "object") {
      disconnect();
      return;
    }
    const input = frame as { type?: unknown; id?: unknown; method?: unknown; args?: unknown };
    if (
      typeof input.id !== "string" ||
      input.id.length > 128 ||
      Buffer.byteLength(JSON.stringify(frame)) > 32 * 1024 * 1024
    ) {
      disconnect();
      return;
    }
    if (input.type === "cancel-operation") {
      active.get(input.id)?.abort(new Error("Native operation cancelled"));
      return;
    }
    if (
      input.type !== "operation" ||
      typeof input.method !== "string" ||
      input.method.length > 128 ||
      !Array.isArray(input.args) ||
      active.has(input.id) ||
      active.size >= 128
    ) {
      disconnect();
      return;
    }
    const { id, method, args } = input as { id: string; method: string; args: unknown[] };
    const controller = new AbortController();
    active.set(id, controller);
    const send = (result: object) => {
      if (stopped || !process.connected) return;
      let bytes = Buffer.byteLength(JSON.stringify(result));
      if (bytes > MAX_BYTES) {
        result = {
          type: "operation-result",
          id,
          error: { message: "Native result exceeds byte limit", code: "ELIMIT" },
        };
        bytes = Buffer.byteLength(JSON.stringify(result));
      }
      if (queuedBytes + bytes > MAX_BYTES) {
        disconnect();
        return;
      }
      queuedBytes += bytes;
      try {
        process.send!(result, (error) => {
          queuedBytes -= bytes;
          if (error) disconnect();
        });
      } catch {
        queuedBytes -= bytes;
        disconnect();
      }
    };
    void Promise.resolve()
      .then(() => handler(method, args, controller.signal))
      .then(
        (value) => send({ type: "operation-result", id, value }),
        (cause) =>
          send({
            type: "operation-result",
            id,
            error: {
              message: cause instanceof Error ? cause.message : String(cause),
              ...(cause &&
              typeof cause === "object" &&
              "code" in cause &&
              typeof cause.code === "string"
                ? { code: cause.code }
                : {}),
            },
          })
      )
      .catch(disconnect)
      .finally(() => active.delete(id));
  });
}
