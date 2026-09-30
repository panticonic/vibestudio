import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { it, expect, vi } from "vitest";
import { z } from "zod";
import {
  ServiceDispatcher,
  ServiceError,
  createVerifiedCaller,
} from "@vibestudio/shared/serviceDispatcher";
import { testAuthority } from "@vibestudio/shared/serviceDispatcherTestUtils";
import { rpcDiagnosticIdOf } from "@vibestudio/rpc";
import {
  reportSignaturePayload,
  type ProblemReportBundle,
} from "@vibestudio/service-schemas/problemReportBundle";
import { ProblemReportingStore } from "./store";
import { ReportCapture } from "./capture";
import { ReportDelivery } from "./delivery";
import { createMachineReportSigner } from "./signing";

it("delivers opted-in unexpected service failures automatically with exact signatures, excludes expected failures, and stops when off", async () => {
  const root = mkdtempSync(join(tmpdir(), "report-capture-flow-"));
  vi.stubEnv("XDG_CONFIG_HOME", root);
  vi.useFakeTimers();
  const store = new ProblemReportingStore(join(root, "reports"));
  store.rememberOwner("alice", "Alice");
  const uploads: { report: ProblemReportBundle; headers: Record<string, string> }[] = [];
  const delivery = new ReportDelivery(
    store,
    {
      forwardHostFetch: async (input) => {
        const report = JSON.parse(String(input.body)) as ProblemReportBundle;
        const headers = input.headers!;
        uploads.push({ report, headers });
        const publicKey = await crypto.subtle.importKey(
          "raw",
          Buffer.from(headers["x-report-public-key"]!, "hex"),
          "Ed25519",
          false,
          ["verify"]
        );
        const receiptDigest = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(headers["x-report-receipt-secret"]!)
        );
        expect(
          await crypto.subtle.verify(
            "Ed25519",
            publicKey,
            Buffer.from(headers["x-report-signature"]!, "hex"),
            reportSignaturePayload(
              report.submissionId,
              headers["x-report-digest"]!,
              Buffer.from(receiptDigest).toString("hex")
            )
          )
        ).toBe(true);
        expect(input.body).not.toContain("private exception secret");
        expect(input.body).not.toContain("private input text");
        return {
          status: 201,
          statusText: "Created",
          finalUrl: input.url,
          headerPairs: [],
          body: new TextEncoder().encode(
            JSON.stringify({
              submissionId: report.submissionId,
              digest: headers["x-report-digest"],
              receiptId: randomUUID(),
              receivedAt: new Date().toISOString(),
              status: "available",
            })
          ),
        };
      },
    },
    createMachineReportSigner(join(root, "secrets"))
  );
  const capture = new ReportCapture(store, "ws", () => delivery.wake());
  const dispatcher = new ServiceDispatcher();
  dispatcher.setAuthorityResolver(({ caller, capability, resourceKey }) =>
    testAuthority(caller, capability, resourceKey)
  );
  dispatcher.setFailureObserver((failure) => capture.serviceFailure(failure));
  dispatcher.registerService({
    name: "runtime",
    authority: { principals: ["user"] },
    methods: {
      run: {
        args: z.tuple([z.boolean(), z.string()]),
        website: { kind: "closed", reason: "Host boundary test" },
        tier: { tier: "open", session: "family", rationale: "test" },
      },
    },
    handler: async (_ctx, _method, args) => {
      if (args[0]) throw new ServiceError("runtime", "run", "Expected domain refusal");
      throw new Error("private exception secret");
    },
  });
  dispatcher.markInitialized();
  const ctx = {
    caller: createVerifiedCaller("shell", "shell", null, null, {
      userId: "alice",
      handle: "Alice",
    }),
  };
  try {
    await expect(
      dispatcher.dispatch(ctx, "runtime", "run", [false, "private input text"])
    ).rejects.toMatchObject({ errorKind: "internal" });
    capture.flush();
    expect(store.history("alice", "ws")).toHaveLength(0);
    store.decide("alice", 0, "on", "shell");
    await vi.advanceTimersByTimeAsync(2);
    await expect(
      dispatcher.dispatch(ctx, "runtime", "run", [true, "private input text"])
    ).rejects.toMatchObject({ errorKind: "service" });
    capture.flush();
    expect(store.history("alice", "ws")).toHaveLength(0);
    const failure = await dispatcher
      .dispatch(ctx, "runtime", "run", [false, "private input text"])
      .catch((error) => error);
    capture.flush();
    capture.serviceFailure({
      ctx,
      service: "runtime",
      method: "run",
      error: failure,
      diagnosticId: rpcDiagnosticIdOf(failure)!,
    });
    capture.flush();
    expect(store.history("alice", "ws")).toHaveLength(1);
    await vi.waitFor(() => expect(store.history("alice", "ws")[0]?.["state"]).toBe("received"));
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.report.intent).toBe("automatic-diagnostic");
    expect(uploads[0]?.report.problem.operation).toBe("runtime.run");
    expect(uploads[0]?.report.evidence).toEqual([]);
    store.decide("alice", 1, "off", "shell");
    await dispatcher.dispatch(ctx, "runtime", "run", [false, "private input text"]).catch(() => {});
    capture.flush();
    await vi.advanceTimersByTimeAsync(60000);
    expect(uploads).toHaveLength(1);
  } finally {
    capture.stop();
    await delivery.stop();
    store.close();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});
