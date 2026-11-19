import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { constantTimeStringEqual } from "@vibestudio/shared/tokenManager";
import { readBoundedBody, sendJson, sendText } from "../hostCore/httpResponses.js";

const transition = z
  .object({
    publicationId: z.string().regex(/^[a-f0-9]{64}$/u),
    sourceNodeId: z.string().regex(/^[a-f0-9]{64}$/u),
    previousHead: z.string().regex(/^[a-f0-9]{40}$/u),
    proposedHead: z.string().regex(/^[a-f0-9]{40}$/u),
  })
  .strict()
  .refine((value) => value.previousHead !== value.proposedHead);
export type IncomingWorkspaceHistory = z.infer<typeof transition>;
export type HistoryIngressMethod =
  | "stageIncomingHistory"
  | "checkIncomingHistory"
  | "serveIncomingHistory"
  | "missingHistoryContent"
  | "checkHistoryContent"
  | "storeHistoryContent"
  | "publishIncomingHistory";
export type HistoryIngressInput = IncomingWorkspaceHistory & {
  bytes?: Uint8Array;
  digest?: string;
  group?: string;
  publisher?: string;
  proof?: unknown;
};
type Dispatch = (method: HistoryIngressMethod, transition: HistoryIngressInput) => Promise<unknown>;

export async function handleChronologHistoryIngress(
  req: IncomingMessage,
  res: ServerResponse,
  token: string | null | undefined,
  dispatch: Dispatch
): Promise<void> {
  const provided = req.headers["x-chronolog-node-token"];
  if (!token || typeof provided !== "string" || !constantTimeStringEqual(provided, token)) {
    sendText(res, 403, "Forbidden");
    return;
  }
  const url = new URL(req.url ?? "/", "http://gateway");
  const input = transition.safeParse(Object.fromEntries(url.searchParams));
  const packetBytes = req.headers["x-chronolog-packet-bytes"];
  const length = Number(packetBytes);
  const method = req.method;
  const operation = req.headers["x-chronolog-history-operation"];
  const digest = req.headers["x-chronolog-content-digest"];
  const group = req.headers["x-chronolog-group"];
  const publisher = req.headers["x-chronolog-publisher"];
  const proof = req.headers["x-chronolog-proof"];
  const principal = z.string().regex(/^[a-f0-9]{64}$/u);
  if (
    !input.success ||
    typeof packetBytes !== "string" ||
    !/^(?:0|[1-9][0-9]{0,9})$/u.test(packetBytes) ||
    length > 1_073_741_824 ||
    (operation === "blob"
      ? typeof digest !== "string" || !/^[a-f0-9]{64}$/u.test(digest)
      : digest !== undefined) ||
    !(
      (operation === "grant" && method === "PUT" && length === 0) ||
      (operation === "publish" &&
        method === "PUT" &&
        length === 0 &&
        principal.safeParse(group).success &&
        principal.safeParse(publisher).success &&
        typeof proof === "string" &&
        proof.length <= 4096) ||
      (operation === "missing" && method === "GET" && length === 0) ||
      (operation === "push" && (method === "HEAD" || method === "POST") && length > 0) ||
      (operation === "blob" && (method === "HEAD" || method === "POST"))
    )
  ) {
    sendText(res, 400, "Invalid workspace history request");
    return;
  }
  try {
    if (
      operation === "publish" &&
      typeof group === "string" &&
      typeof publisher === "string" &&
      typeof proof === "string"
    ) {
      sendJson(
        res,
        200,
        await dispatch("publishIncomingHistory", {
          ...input.data,
          group,
          publisher,
          proof: JSON.parse(proof) as unknown,
        })
      );
      return;
    }
    if (operation === "grant" || operation === "missing") {
      const action = operation === "grant" ? "stageIncomingHistory" : "missingHistoryContent";
      sendJson(res, 200, await dispatch(action, input.data));
      return;
    }
    const scope = { ...input.data, ...(typeof digest === "string" ? { digest } : {}) };
    await dispatch(operation === "blob" ? "checkHistoryContent" : "checkIncomingHistory", scope);
    if (method === "HEAD") {
      res.writeHead(204, { "Cache-Control": "no-store" });
      res.end();
      return;
    }
    const body = await readBoundedBody(req, length, () => new Error("Invalid packet length"));
    if (body.length !== length) throw new Error("Invalid packet length");
    if (operation === "blob") {
      await dispatch("storeHistoryContent", { ...scope, bytes: body });
      res.writeHead(204, { "Cache-Control": "no-store" });
      res.end();
      return;
    }
    const reply = await dispatch("serveIncomingHistory", { ...scope, bytes: body });
    if (!(reply instanceof Uint8Array)) throw new Error("Invalid native workspace history reply");
    res.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "application/octet-stream" });
    res.end(Buffer.from(reply.buffer, reply.byteOffset, reply.byteLength));
  } catch {
    sendText(res, 409, "Workspace history staging refused this transition");
  }
}
