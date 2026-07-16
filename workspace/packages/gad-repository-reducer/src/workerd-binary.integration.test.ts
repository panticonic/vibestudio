import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { asGadCommitIntentId } from "@workspace/gad-repository-contract";
import {
  GAD_REPOSITORY_REDUCER_PROTOCOL_VERSION,
  GadWorkerdHostClientV1,
  type GadWorkerdPublicationIntentV1,
  type GadRepositoryReducerRequestV1,
  type GadWorkerdHostTransportV1,
  type WorkerdDatabaseReducerRunOptions,
  type WorkerdDatabaseReducerRunResult,
} from "./index.js";

const WORKERD_BINARY = process.env["WORKERD_DATABASE_REDUCER_BIN"];
const RUN_BINARY_TEST = WORKERD_BINARY !== undefined && existsSync(WORKERD_BINARY);
const SOURCE_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SOURCE_DIR, "../../../..");
const activeProcesses = new Set<ChildProcessWithoutNullStreams>();
const processStderr = new Map<ChildProcessWithoutNullStreams, string>();

afterEach(async () => {
  await Promise.all([...activeProcesses].map(stopWorkerd));
});

describe("Gad real workerd database-reducer fixture", () => {
  const binaryIt = RUN_BINARY_TEST ? it : it.skip;

  binaryIt(
    "runs, follows, and separately publishes a Gad import in a real standard reducer",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "gad-workerd-binary-"));
      try {
        bundleWorker(join(SOURCE_DIR, "workerd-binary-fixture.ts"), join(root, "gad-reducer.mjs"));
        writeFileSync(join(root, "caller.mjs"), CALLER_WORKER);
        mkdirSync(join(root, "cas"));
        mkdirSync(join(root, "workspaces"));
        const port = await unusedPort();
        writeFileSync(join(root, "workerd.capnp"), workerdConfig(root, port));
        const child = startWorkerd(WORKERD_BINARY!, join(root, "workerd.capnp"));
        await waitForWorkerd(port, child);

        let identity: NativeExecutionIdentity | null = null;
        const transport: GadWorkerdHostTransportV1 = {
          run: async (request) => {
            const result = await postJson<NativeRunResult>(
              port,
              "/run",
              serializeOptions(request.options)
            );
            identity = {
              invocationId: result.executionId,
              requestFingerprint: result.requestFingerprint,
            };
            return decodeNativeRunResult(result);
          },
          follow: async () => {
            if (identity === null) throw new Error("BINARY_FIXTURE_HAS_NO_RUN_IDENTITY");
            const followed = await postJson<NativeFollowResult>(port, "/follow", identity);
            expect(followed.metadataError).toBe("none");
            expect(followed.state).toBe("succeeded");
            if (followed.success === null) throw new Error("BINARY_FIXTURE_FOLLOW_MISSING_SUCCESS");
            return decodeNativeRunResult(followed.success);
          },
          publish: async () => {
            throw new Error("BINARY_FIXTURE_PUBLICATION_USES_NATIVE_CALLER_SURFACE");
          },
        };
        const client = new GadWorkerdHostClientV1(transport);
        const request = importRequest();
        const clientRequest = { request, databases: [] };
        const response = await client.run(clientRequest);

        expect(response.result.repository.commitHash).toMatch(/^[0-9a-f]{40}$/u);
        expect(response.result.repository.database.hashAlgorithm).toBe(0x30_0101);
        expect(response.result.repository.database.digestHex).toMatch(/^[0-9a-f]{40}$/u);
        expect(response.result.repositoryManifest.database.outputName).toBe("repository");
        expect(response.result.repositoryManifest.headCommitIntentId).toBe("intent.binary.import");
        expect(response.result.working).toBeNull();
        expect(response.transportOutputs).toHaveLength(1);
        expect(response.transportOutputs[0]?.database.repositoryRoot.hashAlgorithm).toBe(
          "dolt-blake3-160"
        );

        const followed = await client.follow(clientRequest);
        expect(followed).not.toBeNull();
        expect(followed?.result.repository).toEqual(response.result.repository);
        expect(followed?.transportOutputs).toEqual(response.transportOutputs);

        const intent = client.createPublicationIntent(response);
        expect(intent.targetRef).toBe(PUBLICATION_REF);
        expect(intent.selectedTransportOutput).toEqual(response.transportOutputs[0]);
        if (identity === null) throw new Error("BINARY_FIXTURE_HAS_NO_RUN_IDENTITY");

        const publication = nativePublicationRequest(identity, intent, [0x47, 0x41, 0x44], {
          kind: "missing",
        });
        const published = await postJson<NativePublicationResult>(port, "/publish", publication);
        expect(published).toMatchObject({
          metadataError: "none",
          replay: "fresh",
          outcome: "updated",
          ref: { current: { generation: "1" } },
        });
        expect(published.ref?.current?.value.length).toBeGreaterThan(0);

        const replayed = await postJson<NativePublicationResult>(port, "/publish", publication);
        expect(replayed).toEqual({ ...published, replay: "replayed" });

        const current = published.ref?.current;
        if (current === null || current === undefined) {
          throw new Error("BINARY_FIXTURE_PUBLICATION_HAS_NO_CURRENT_REF");
        }
        const conflict = await postJson<NativePublicationResult>(
          port,
          "/publish",
          nativePublicationRequest(identity, intent, [0x47, 0x41, 0x45], {
            kind: "exact",
            value: current.value,
            generation: "2",
          })
        );
        expect(conflict).toMatchObject({
          metadataError: "none",
          replay: "fresh",
          outcome: "conflict",
          ref: { current: { value: current.value, generation: "1" } },
        });

        // Publication moves only the caller-owned ref. The exact completion and its immutable
        // database output remain followable after both the replay and the rejected movement.
        const afterPublication = await client.follow(clientRequest);
        expect(afterPublication?.result.repository).toEqual(response.result.repository);
        expect(afterPublication?.transportOutputs).toEqual(response.transportOutputs);
      } finally {
        await Promise.all([...activeProcesses].map(stopWorkerd));
        rmSync(root, { recursive: true, force: true });
      }
    },
    60_000
  );
});

const PUBLICATION_REF = "gad/refs/main";

interface NativeRunResult extends Omit<WorkerdDatabaseReducerRunResult, "canonicalOutput"> {
  readonly canonicalOutput: number[];
  readonly executionId: number[];
  readonly requestFingerprint: number[];
}

interface NativeExecutionIdentity {
  readonly invocationId: readonly number[];
  readonly requestFingerprint: readonly number[];
}

interface NativeFollowResult {
  readonly metadataError: string;
  readonly state: string;
  readonly success: NativeRunResult | null;
  readonly terminalFailure: readonly number[] | null;
}

type NativeRefExpectation =
  | { readonly kind: "missing" }
  | {
      readonly kind: "exact";
      readonly value: readonly number[];
      readonly generation: string;
    };

interface NativePublicationRequest extends NativeExecutionIdentity {
  readonly publicationKey: readonly number[];
  readonly refKey: readonly number[];
  readonly expected: NativeRefExpectation;
  readonly outputDatabase: string;
}

interface NativePublicationResult {
  readonly metadataError: string;
  readonly replay: "fresh" | "replayed";
  readonly outcome: "updated" | "conflict" | null;
  readonly ref: {
    readonly key: number[];
    readonly current: { readonly value: number[]; readonly generation: string } | null;
  } | null;
  readonly exactMovementRecord: number[] | null;
}

function decodeNativeRunResult(result: NativeRunResult): WorkerdDatabaseReducerRunResult {
  return { ...result, canonicalOutput: Uint8Array.from(result.canonicalOutput) };
}

function nativePublicationRequest(
  identity: NativeExecutionIdentity,
  intent: GadWorkerdPublicationIntentV1,
  publicationKey: readonly number[],
  expected: NativeRefExpectation
): NativePublicationRequest {
  return {
    ...identity,
    publicationKey,
    refKey: [...new TextEncoder().encode(intent.targetRef)],
    expected,
    outputDatabase: intent.selectedTransportOutput.logicalName,
  };
}

function importRequest(): GadRepositoryReducerRequestV1 {
  const intent = {
    commitIntentId: asGadCommitIntentId("intent.binary.import"),
    operation: "import" as const,
    message: "Gad workerd binary import",
    actorRef: "actor:binary-fixture",
    invocationId: "invocation:binary-fixture",
    turnId: "turn:binary-fixture",
    logicalTime: "2026-07-15T00:00:00.000Z",
    groupId: null,
    rebasedFromIntentId: null,
  };
  return {
    protocolVersion: GAD_REPOSITORY_REDUCER_PROTOCOL_VERSION,
    inputs: { repository: null, working: null, merges: [] },
    operation: {
      kind: "import",
      fixtureName: "workerd-binary-import",
      repository: {
        schemaVersion: 1,
        files: [],
        edits: [],
        hunks: [],
        commitIntents: [intent],
        headCommitIntentId: intent.commitIntentId,
      },
      working: null,
    },
    publication: {
      targetRef: PUBLICATION_REF,
      expected: null,
      reason: "Publish imported repository from the caller",
    },
  };
}

function bundleWorker(entry: string, output: string): void {
  const executable = join(REPOSITORY_ROOT, "node_modules", ".bin", "esbuild");
  const built = spawnSync(
    executable,
    [
      entry,
      "--bundle",
      "--format=esm",
      "--platform=browser",
      "--target=es2022",
      `--outfile=${output}`,
      "--conditions=workerd,worker,browser",
    ],
    { cwd: REPOSITORY_ROOT, encoding: "utf8" }
  );
  if (built.status !== 0) throw new Error(`esbuild failed: ${built.stderr || built.stdout}`);
}

function startWorkerd(binary: string, config: string): ChildProcessWithoutNullStreams {
  const child = spawn(binary, ["serve", config], { cwd: dirname(config) });
  child.stdout.resume();
  processStderr.set(child, "");
  child.stderr.on("data", (chunk: Buffer) => {
    processStderr.set(child, `${processStderr.get(child) ?? ""}${chunk.toString()}`.slice(-16_384));
  });
  activeProcesses.add(child);
  return child;
}

async function stopWorkerd(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (!activeProcesses.delete(child)) return;
  if (child.exitCode !== null) {
    processStderr.delete(child);
    return;
  }
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolveClose) => child.once("close", () => resolveClose())),
    new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 2_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
  processStderr.delete(child);
}

async function waitForWorkerd(port: number, child: ChildProcessWithoutNullStreams): Promise<void> {
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-16_384);
  });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`workerd exited before readiness: ${stderr}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      // The socket is not accepting requests yet.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`workerd readiness timeout: ${stderr}`);
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("TCP port allocation failed");
  await new Promise<void>((resolveClose, rejectClose) =>
    server.close((error) => (error ? rejectClose(error) : resolveClose()))
  );
  return address.port;
}

async function postJson<Result>(port: number, path: string, value: unknown): Promise<Result> {
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(value),
    });
  } catch (error) {
    const stderr = activeWorkerdStderr();
    throw new Error(`workerd fixture request failed${stderr.length > 0 ? `:\n${stderr}` : ""}`, {
      cause: error,
    });
  }
  const text = await response.text();
  if (!response.ok) {
    const stderr = activeWorkerdStderr();
    throw new Error(
      `workerd fixture ${response.status}: ${text}${stderr.length > 0 ? `\n${stderr}` : ""}`
    );
  }
  return JSON.parse(text) as Result;
}

function activeWorkerdStderr(): string {
  return [...activeProcesses]
    .map((child) => processStderr.get(child) ?? "")
    .filter((value) => value.length > 0)
    .join("\n");
}

function serializeOptions(options: WorkerdDatabaseReducerRunOptions): unknown {
  return { ...options, canonicalInput: [...options.canonicalInput] };
}

function workerdConfig(root: string, port: number): string {
  const q = (value: string): string => JSON.stringify(value);
  return (
    `using Workerd = import "/workerd/workerd.capnp";\n` +
    `const config :Workerd.Config = (\n` +
    `  databaseReducerLocal = (storeId = "gad-workerd-fixture", ` +
    `casDirectory = ${q(join(root, "cas"))}, ` +
    `metadataSnapshot = ${q(join(root, "executions.snapshot"))}, ` +
    `refSnapshot = ${q(join(root, "refs.snapshot"))}, ` +
    `workspaceDirectory = ${q(join(root, "workspaces"))}, ` +
    `refPublicationPolicies = [(` +
    `callerServiceName = "caller", bindingName = "GAD", ` +
    `targetReducerServiceName = "gad", refKeys = [${q(PUBLICATION_REF)}])]),\n` +
    `  services = [\n` +
    `    (name = "gad", reducerWorker = (profile = standard, worker = (` +
    `compatibilityDate = "2026-07-15", modules = [` +
    `(name = "gad-reducer.mjs", esModule = embed "gad-reducer.mjs")]))),\n` +
    `    (name = "caller", worker = (compatibilityDate = "2026-07-15", modules = [` +
    `(name = "caller.mjs", esModule = embed "caller.mjs")], bindings = [` +
    `(name = "GAD", databaseReducer = "gad")]))\n` +
    `  ],\n` +
    `  sockets = [(name = "http", address = "127.0.0.1:${port}", service = "caller")],\n` +
    `);\n`
  );
}

const CALLER_WORKER = `export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");
    try {
      if (url.pathname === "/run") {
        const body = await request.json();
        body.canonicalInput = new Uint8Array(body.canonicalInput);
        const value = await env.GAD.run(body);
        return Response.json(serializeRun(value));
      }
      if (url.pathname === "/follow") {
        const body = await request.json();
        const value = await env.GAD.follow({
          invocationId: new Uint8Array(body.invocationId),
          requestFingerprint: new Uint8Array(body.requestFingerprint),
        });
        return Response.json({
          ...value,
          success: value.success === null ? null : serializeRun(value.success),
          terminalFailure: value.terminalFailure === null ? null : [...value.terminalFailure],
        });
      }
      if (url.pathname === "/publish") {
        const body = await request.json();
        const expected = body.expected.kind === "missing"
          ? {kind: "missing"}
          : {
              kind: "exact",
              value: new Uint8Array(body.expected.value),
              generation: BigInt(body.expected.generation),
            };
        const value = await env.GAD.publishOutput({
          invocationId: new Uint8Array(body.invocationId),
          requestFingerprint: new Uint8Array(body.requestFingerprint),
          publicationKey: new Uint8Array(body.publicationKey),
          refKey: new Uint8Array(body.refKey),
          expected,
          outputDatabase: body.outputDatabase,
        });
        return Response.json({
          ...value,
          ref: value.ref === null ? null : {
            key: [...value.ref.key],
            current: value.ref.current === null ? null : {
              value: [...value.ref.current.value],
              generation: String(value.ref.current.generation),
            },
          },
          exactMovementRecord: value.exactMovementRecord === null
            ? null
            : [...value.exactMovementRecord],
        });
      }
      return new Response("not found", {status: 404});
    } catch (error) {
      return Response.json({error: error instanceof Error ? error.message : String(error)}, {status: 500});
    }
  }
};

function serializeRun(value) {
  return {
    ...value,
    canonicalOutput: [...value.canonicalOutput],
    executionId: [...value.executionId],
    requestFingerprint: [...value.requestFingerprint],
    lease: {
      ...value.lease,
      expiresAtUnixMilliseconds: String(value.lease.expiresAtUnixMilliseconds),
      generation: String(value.lease.generation),
    },
  };
}
`;
