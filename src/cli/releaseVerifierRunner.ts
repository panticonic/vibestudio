import * as fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { deserializeRpcFailure, serializeRpcFailure } from "@vibestudio/rpc";
import type { BuildBundleResult, BuildResultWire } from "@vibestudio/service-schemas/build";
import type { RpcClient } from "./rpcClient.js";

const RESULT_PREFIX = "VIBESTUDIO_RELEASE_RPC_RESULT:";
const CONCURRENCY = 6;

type ClientFactoryModule = typeof import("./client.js");
type BuildOutcome =
  | { status: "fulfilled"; source: string; buildKey: string | undefined }
  | { status: "rejected"; source: string; failure: unknown };

/** Join concurrent calls over one installed CLI identity and one RPC client. */
export async function verifyReleaseBuildBatch(
  getBuild: (source: string) => Promise<BuildResultWire | BuildBundleResult>,
  sources: readonly string[],
  signal?: AbortSignal
): Promise<BuildOutcome[]> {
  const outcomes = new Array<BuildOutcome>(sources.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, sources.length) }, async () => {
      while (next < sources.length) {
        if (signal?.aborted) return;
        const index = next++;
        const source = sources[index]!;
        try {
          const result = await getBuild(source);
          const buildKey = "buildKey" in result ? result.buildKey : undefined;
          outcomes[index] = { status: "fulfilled", source, buildKey };
        } catch (error) {
          outcomes[index] = { status: "rejected", source, failure: error };
        }
      }
    })
  );
  if (signal?.aborted) {
    for (let index = 0; index < sources.length; index++) {
      if (!outcomes[index]) {
        outcomes[index] = {
          status: "rejected",
          source: sources[index]!,
          failure: signal.reason,
        };
      }
    }
  }
  return outcomes;
}

async function run(inputPath: string): Promise<void> {
  const cancellation = new AbortController();
  let cancellationFailure: unknown;
  let cancellationClose: Promise<void> | undefined;
  let client: RpcClient | undefined;
  let release: (() => Promise<void>) | undefined;
  const onMessage = (message: unknown) => {
    if (
      typeof message !== "object" ||
      message === null ||
      !("type" in message) ||
      message.type !== "cancel" ||
      !("failure" in message)
    )
      return;
    cancellationFailure = deserializeRpcFailure(message.failure);
    cancellation.abort(cancellationFailure);
    if (client) {
      cancellationClose ??= client.close().then(
        () => undefined,
        () => undefined
      );
    }
  };
  process.on("message", onMessage);
  const results: {
    outcomes?: Array<
      | { status: "fulfilled"; source: string; buildKey: string | undefined }
      | { status: "rejected"; source: string; failure: unknown }
    >;
    operationFailure?: unknown;
    cleanupFailure?: unknown;
  } = {};
  try {
    const input = JSON.parse(await fs.readFile(inputPath, "utf8")) as {
      cliEntry: string;
      sources: string[];
    };
    if (
      typeof input.cliEntry !== "string" ||
      !Array.isArray(input.sources) ||
      input.sources.some((source) => typeof source !== "string")
    )
      throw new Error("Invalid release verifier runner input");

    if (cancellation.signal.aborted) throw cancellationFailure;
    const cli = (await import(
      pathToFileURL(path.resolve(input.cliEntry)).href
    )) as ClientFactoryModule;
    if (cancellation.signal.aborted) throw cancellationFailure;
    client = cli.createSelectedWorkspaceClient();
    release = client.retainConnection();
    if (cancellation.signal.aborted) {
      cancellationClose ??= client.close().then(
        () => undefined,
        () => undefined
      );
      throw cancellationFailure;
    }
    results.outcomes = await verifyReleaseBuildBatch(
      (source) => client!.mainCall("build.getBuild", [source]),
      input.sources,
      cancellation.signal
    );
    if (cancellationFailure !== undefined) results.operationFailure = cancellationFailure;
  } catch (error) {
    results.operationFailure = cancellationFailure ?? error;
  }
  process.off("message", onMessage);
  if (release) {
    try {
      await release();
    } catch (error) {
      results.cleanupFailure = error;
    }
  } else if (cancellationClose) {
    await cancellationClose;
  }
  if (cancellationFailure !== undefined && results.operationFailure === undefined) {
    results.operationFailure = cancellationFailure;
  }

  const fatal =
    results.operationFailure && results.cleanupFailure
      ? new AggregateError(
          [results.operationFailure, results.cleanupFailure],
          "Release RPC batch and client cleanup failed",
          { cause: results.operationFailure }
        )
      : results.operationFailure;
  const serialized = {
    outcomes: results.outcomes?.map((outcome) =>
      outcome.status === "rejected"
        ? { ...outcome, failure: serializeRpcFailure(outcome.failure) }
        : outcome
    ),
    ...(fatal === undefined ? {} : { fatal: serializeRpcFailure(fatal) }),
    ...(results.operationFailure === undefined && results.cleanupFailure !== undefined
      ? { cleanupFailure: serializeRpcFailure(results.cleanupFailure) }
      : {}),
  };
  process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(serialized)}\n`);
}

async function main(): Promise<void> {
  try {
    const inputPath = process.argv[2];
    if (!inputPath) throw new Error("Release verifier runner requires its input file");
    await run(inputPath);
  } catch (error) {
    process.stdout.write(
      `${RESULT_PREFIX}${JSON.stringify({ fatal: serializeRpcFailure(error) })}\n`
    );
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) void main();

export { RESULT_PREFIX };
