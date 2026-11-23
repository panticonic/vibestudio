import { createHash } from "node:crypto";
import type { SessionScope } from "./agent/sessionContext.js";
import { writeSystemTestArtifact, type StoredSystemTestRun } from "./systemTestStore.js";

/** Preserve opaque native records, including unfinished calls. This is evidence,
 * not an assertion that any case passed or that a model turn is trainable. */
export async function retainNativeSystemTestEvidence(
  scope: SessionScope,
  stored: StoredSystemTestRun
): Promise<void> {
  const write = (name: string, value: unknown) =>
    writeSystemTestArtifact(stored.runId, name, value, stored.artifactDir);
  const filter = { since: new Date(stored.createdAt).toISOString(), audits: true, limit: 500 };
  write("native-evidence", {
    version: 1,
    runId: stored.runId,
    scope: "workspace calls started since run creation; may include concurrent work",
    filter,
    complete: false,
  });
  const service = (await scope.client.call("workers.resolveService", [
    "vibestudio.natlang.v1",
    null,
  ])) as { kind?: string; targetId?: string };
  if (service.kind !== "durable-object" || typeof service.targetId !== "string")
    throw new Error("Native records service has no durable-object target");
  const call = (method: string, args: unknown[]) =>
    scope.client.callTarget(service.targetId!, method, args);
  const hashes = new Set<string>();
  const references = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const object = value as Record<string, unknown>;
    if (typeof object["hash"] === "string" && /^[a-f0-9]{64}$/u.test(object["hash"]))
      hashes.add(object["hash"]);
    for (const nested of Object.values(object)) references(nested);
  };
  let after: string | undefined;
  let pages = 0,
    calls = 0;
  const seen = new Set<string>();
  for (;;) {
    const page = await call("listCalls", [{ ...filter, ...(after ? { after } : {}) }]);
    if (!Array.isArray(page)) throw new Error("Invalid native records page");
    write(`native-page-${pages++}`, page);
    for (const item of page) {
      const id = item?.call_id;
      if (typeof id !== "string" || seen.has(id))
        throw new Error("Invalid or repeated native call identifier");
      seen.add(id);
      const detail = await call("getCall", [{ callId: id }]);
      write(`native-call-${createHash("sha256").update(id).digest("hex")}`, { callId: id, detail });
      references(detail);
      calls++;
      after = id;
    }
    if (page.length < filter.limit) break;
  }
  for (const hash of hashes) {
    const value = await call("getValue", [{ hash }]);
    // Preserve explicit absence; never invent an unavailable receipt.
    write(`native-value-${hash}`, { hash, value });
  }
  write("native-evidence", {
    version: 1,
    runId: stored.runId,
    scope: "workspace calls started since run creation; may include concurrent work",
    filter,
    complete: true,
    pages,
    calls,
    values: hashes.size,
  });
}
