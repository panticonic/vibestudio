import { z } from "zod";
import { PhoneProvisioningResultSchema } from "../phoneProvisioning.js";

export const PhoneSetupEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("progress"),
    phase: z.enum(["preparing-tools", "checking-device", "installing", "pairing"]),
    message: z.string(),
  }),
  z.object({ type: z.literal("paired"), result: PhoneProvisioningResultSchema }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type PhoneSetupEvent = z.infer<typeof PhoneSetupEventSchema>;

/** The operation owns the stream; cancellation aborts its subprocess and waits. */
export function phoneSetupStream(
  run: (emit: (event: PhoneSetupEvent) => void, signal: AbortSignal) => Promise<void>
): Response {
  const abort = new AbortController();
  const encoder = new TextEncoder();
  let operation: Promise<void>;
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const emit = (event: PhoneSetupEvent) => {
          if (!abort.signal.aborted)
            controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
        };
        operation = run(emit, abort.signal)
          .catch((error) =>
            emit({ type: "error", message: error instanceof Error ? error.message : String(error) })
          )
          .finally(() => {
            if (!abort.signal.aborted) controller.close();
          });
      },
      cancel() {
        abort.abort();
        return operation;
      },
    }),
    { headers: { "Content-Type": "application/x-ndjson" } }
  );
}

export async function consumePhoneSetup(
  response: Response,
  onEvent: (event: PhoneSetupEvent) => void = () => {}
) {
  if (!response.ok || !response.body)
    throw new Error("Phone setup could not start. Reconnect the desktop and retry.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: z.infer<typeof PhoneProvisioningResultSchema> | undefined;
  function accept(line: string) {
    if (!line.trim()) return;
    const event = PhoneSetupEventSchema.parse(JSON.parse(line));
    if (event.type === "error") throw new Error(event.message);
    if (event.type === "paired") result = event.result;
    onEvent(event);
  }
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      if (buffer.length > 128 * 1024) throw new Error("Invalid phone setup progress response");
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        accept(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
      }
      if (done) break;
    }
    accept(buffer);
    if (!result)
      throw new Error(
        "Phone setup was interrupted before pairing was confirmed. Check Devices before retrying."
      );
    return result;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
