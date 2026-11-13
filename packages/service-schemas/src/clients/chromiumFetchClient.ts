import type { RpcCaller } from "@vibestudio/rpc";
import { base64ToBytes } from "@vibestudio/rpc";
import { mainRpcMethods } from "../mainRpc.js";

export type ChromiumFetchSession = "public" | "browser";

const textDecoder = new TextDecoder();
const READ_CHUNK_BYTES = 256 * 1024;

/**
 * A `fetch` over the managed Chromium host: the page loads in a real browser
 * (cookie-free for `public`; the user's imported cookies, behind the host's
 * approval gate, for `browser`) and its body streams back in owner-bound
 * chunks. Cancelling the request's signal closes the host response.
 */
export function createChromiumFetch(
  rpc: Pick<RpcCaller, "call">,
  session: ChromiumFetchSession
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const opened = await rpc.call(
      "main",
      mainRpcMethods[
        session === "browser" ? "chromiumFetch.openBrowser" : "chromiumFetch.openPublic"
      ],
      [url]
    );
    let offset = 0;
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      await rpc
        .call("main", mainRpcMethods["chromiumFetch.close"], [opened.responseId])
        .catch(() => undefined);
    };
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (init?.signal?.aborted) {
          await close();
          controller.error(init.signal.reason ?? new Error("Chromium fetch aborted"));
          return;
        }
        try {
          const chunk = await rpc.call("main", mainRpcMethods["chromiumFetch.read"], [
            opened.responseId,
            offset,
            READ_CHUNK_BYTES,
          ]);
          const bytes = base64ToBytes(chunk.bytesBase64);
          offset += bytes.byteLength;
          if (bytes.byteLength > 0) controller.enqueue(bytes);
          if (chunk.done) {
            closed = true;
            controller.close();
          }
        } catch (error) {
          await close();
          controller.error(error);
        }
      },
      cancel: close,
    });
    const consume = () => new Response(body).arrayBuffer();
    return {
      ok: opened.status >= 200 && opened.status < 300,
      status: opened.status,
      statusText: opened.statusText,
      url: opened.url,
      headers: new Headers(opened.headers),
      body,
      arrayBuffer: consume,
      text: async () => textDecoder.decode(await consume()),
    } as Response;
  }) as typeof fetch;
}
