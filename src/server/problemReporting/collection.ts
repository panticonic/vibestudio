import { randomUUID } from "node:crypto";
import { canonicalJson } from "@vibestudio/content-addressing";
import {
  REPORT_POLICY,
  utf8Size,
  type ProblemReportBundle,
} from "@vibestudio/service-schemas/problemReportBundle";
type Evidence = ProblemReportBundle["evidence"][number];
export interface EvidenceCollector {
  source: Evidence["source"];
  coordinate: string;
  collect(
    signal: AbortSignal,
    byteBudget: number
  ): Promise<{ value: unknown; retained: number; omitted: number; coordinate?: string }>;
}
/** Allocated bounded collectors own cancellation. No inspector is opened implicitly. */
export async function collectReportEvidence(
  collectors: readonly EvidenceCollector[],
  signal?: AbortSignal
): Promise<Evidence[]> {
  if (collectors.length > 8)
    throw new Error("At most eight exact evidence selections per collection");
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timeout = setTimeout(
    () => controller.abort(new Error("Collection deadline")),
    REPORT_POLICY.collectionMilliseconds
  );
  timeout.unref();
  const output: Evidence[] = new Array(collectors.length);
  let next = 0;
  const worker = async () => {
    while (next < collectors.length) {
      const index = next++;
      const collector = collectors[index]!;
      const base = {
        id: randomUUID(),
        source: collector.source,
        coordinate: collector.coordinate,
        capturedAt: new Date().toISOString(),
        redactions: [],
      };
      const budget = Math.floor(
        (REPORT_POLICY.evidenceBytes - 8192) / Math.max(1, collectors.length)
      );
      let removeAbort = () => {};
      try {
        const aborted = new Promise<never>((_, reject) => {
          const fail = () => reject(new Error("Collection deadline"));
          if (controller.signal.aborted) fail();
          else {
            controller.signal.addEventListener("abort", fail, { once: true });
            removeAbort = () => controller.signal.removeEventListener("abort", fail);
          }
        });
        const result = await Promise.race([collector.collect(controller.signal, budget), aborted]);
        const value = canonicalJson(result.value);
        if (result.coordinate) base.coordinate = result.coordinate;
        output[index] =
          utf8Size(value) > budget
            ? {
                ...base,
                completeness: "truncated",
                reason: "byte-budget",
                retained: 0,
                omitted: result.retained + result.omitted,
                value: "null",
              }
            : {
                ...base,
                completeness: result.omitted ? "truncated" : "complete",
                reason: result.omitted ? "source-expired" : null,
                retained: result.retained,
                omitted: result.omitted,
                value,
              };
      } catch (error) {
        const denied =
          typeof error === "object" &&
          error !== null &&
          "errorKind" in error &&
          error.errorKind === "access";
        output[index] = {
          ...base,
          completeness: denied ? "denied" : "unavailable",
          reason: denied
            ? "scope-denied"
            : controller.signal.aborted
              ? "deadline"
              : "source-disconnected",
          retained: 0,
          omitted: 0,
          value: "null",
        };
      } finally {
        removeAbort();
      }
    }
  };
  try {
    await Promise.all(
      Array.from(
        { length: Math.min(REPORT_POLICY.collectionConcurrency, collectors.length) },
        worker
      )
    );
    return output;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
    controller.abort();
  }
}

/** Counts source records, not an artificial one-record JSON envelope. Coordinates describe the returned selection. */
export function collectedPacket(
  source: "runtime" | "server-log",
  value: unknown
): { value: unknown; retained: number; omitted: number; coordinate: string } {
  if (typeof value !== "object" || value === null) throw new Error("Malformed evidence source");
  const packet = value as Record<string, unknown>;
  const records = (source === "server-log" ? packet["records"] : packet["logs"]) as {
    seq?: number;
  }[];
  if (!Array.isArray(records)) throw new Error("Malformed evidence records");
  const sequence = records
    .map((record) => record.seq)
    .filter((seq): seq is number => typeof seq === "number");
  const dropped = packet["dropped"] as { entries?: number; errors?: number } | undefined;
  const coordinate =
    source === "server-log"
      ? JSON.stringify({
          workspaceId: packet["workspaceId"],
          serverBootId: packet["serverBootId"],
          firstSeq: sequence[0] ?? null,
          lastSeq: sequence.at(-1) ?? null,
          ceilingSeq: packet["latestSeq"],
        })
      : JSON.stringify({
          entity: (packet["entity"] as { identity?: unknown } | undefined)?.identity,
          firstSeq: sequence[0] ?? null,
          lastSeq: sequence.at(-1) ?? null,
        });
  const errors = source === "runtime" && Array.isArray(packet["errors"]) ? packet["errors"] : [];
  return {
    value,
    retained: records.length + errors.length,
    omitted: Number(dropped?.entries ?? 0) + Number(dropped?.errors ?? 0),
    coordinate,
  };
}
