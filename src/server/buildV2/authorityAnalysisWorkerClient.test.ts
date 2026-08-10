import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AuthorityAnalysisWorkerClient,
  resolveAuthorityAnalysisWorkerEntry,
} from "./authorityAnalysisWorkerClient.js";

describe("AuthorityAnalysisWorkerClient", () => {
  const clients: AuthorityAnalysisWorkerClient[] = [];

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
  });

  it("resolves the source-owned worker when the application root is a workspace clone", () => {
    const unrelatedAppRoot = mkdtempSync(join(tmpdir(), "vibestudio-app-root-"));

    expect(resolveAuthorityAnalysisWorkerEntry(unrelatedAppRoot)).toMatch(
      /src\/server\/buildV2\/authorityAnalysisWorkerBootstrap\.mjs$/u
    );
  });

  it("executes the compiler snapshot outside the server thread", async () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), "vibestudio-authority-worker-"));
    const unitDir = join(sourceRoot, "panels", "example");
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(
      join(unitDir, "package.json"),
      JSON.stringify({ name: "@workspace-panels/example", type: "module" })
    );
    writeFileSync(
      join(unitDir, "index.ts"),
      `declare const workers: { resolveService(query: string): Promise<unknown> };
       export const service = workers.resolveService("example.notes.v1");`
    );
    const client = new AuthorityAnalysisWorkerClient();
    clients.push(client);

    const snapshot = await client.compilerSnapshot({
      sourceRoot,
      units: [
        {
          name: "@workspace-panels/example",
          relativePath: "panels/example",
          effectiveVersion: "ev-example",
        },
      ],
      nodeModulesPaths: [join(process.cwd(), "node_modules")],
    });

    expect(snapshot.factsByConsumer.get("@workspace-panels/example")).toEqual([
      expect.objectContaining({
        serviceQueries: { kind: "literals", values: new Set(["example.notes.v1"]) },
      }),
    ]);
  });

  it("settles in-flight requests when the worker goes away", async () => {
    // A stranded request has no clock to rescue it: the publication review
    // lifecycle is deliberately timeout-free, so an unsettled analysis would
    // leave the review "preparing" forever.
    const client = new AuthorityAnalysisWorkerClient();
    const inFlight = client.factLookups("workspace-under-test", [
      {
        epoch: { analyzerVersion: "userland-authority-v5" },
        unitName: "@workspace-panels/example",
        effectiveVersion: "ev-example",
      },
    ]);
    const settled = inFlight.then(
      () => "resolved",
      () => "rejected"
    );

    await client.close();

    await expect(settled).resolves.toBe("rejected");
  });

  it("recovers after the worker is replaced", async () => {
    const client = new AuthorityAnalysisWorkerClient();
    clients.push(client);
    const identities = [
      {
        epoch: { analyzerVersion: "userland-authority-v5" },
        unitName: "@workspace-panels/example",
        effectiveVersion: "ev-example",
      },
    ];

    const before = await client.factLookups("workspace-under-test", identities);
    await client.close();
    const after = await client.factLookups("workspace-under-test", identities);

    expect(before).toHaveLength(1);
    expect(after).toHaveLength(1);
  });
});
