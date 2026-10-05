import type { ServerResponse } from "node:http";

/** A backpressured HTTP write belongs to the response's actual lifecycle. */
export function writeHttpBytes(res: ServerResponse, bytes: Uint8Array): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      res.off("drain", succeed);
      res.off("close", closed);
      res.off("error", fail);
    };
    const succeed = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const closed = (): void => {
      fail(
        Object.assign(new Error("HTTP response closed during stream write"), { code: "ECONNRESET" })
      );
    };
    if (res.destroyed || res.writableEnded) {
      closed();
      return;
    }
    res.once("close", closed);
    res.once("error", fail);
    try {
      if (res.write(bytes)) succeed();
      else if (!settled) res.once("drain", succeed);
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
