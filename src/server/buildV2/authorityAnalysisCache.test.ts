import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AuthorityAnalysisCache,
  authorityModuleClosureDigest,
  type AuthorityConsumerIdentity,
  type AuthorityIndexIdentity,
} from "./authorityAnalysisCache.js";
import {
  authorityDependencyIndexDigest,
  type AuthorityDependencyIndex,
} from "./authorityDependencyIndex.js";
import type { WorkspaceServiceCallFact } from "./userlandAuthorityAnalyzer.js";

const epoch = { analyzerVersion: "analyzer:v1", rpcSchemaVersion: "schema:v1" };
const factEpoch = { analyzerVersion: epoch.analyzerVersion };

function hash(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function fact(): WorkspaceServiceCallFact {
  return {
    id: "panels/example/index.ts:1:resolution",
    kind: "resolution",
    serviceQueries: { kind: "literals", values: new Set(["channel", "pubsub"]) },
    methods: { kind: "literals", values: new Set() },
    objectKeys: { kind: "not-applicable" },
    arguments: [],
    origin: {
      unitName: "@workspace-panels/example",
      file: "panels/example/index.ts",
      line: 1,
      column: 1,
    },
  };
}

function index(identity: AuthorityIndexIdentity, consumer: AuthorityConsumerIdentity) {
  const withoutDigest: Omit<AuthorityDependencyIndex, "digest"> = {
    stateHash: identity.stateHash,
    epoch: identity.epoch,
    complete: true,
    consumerInputs: new Map([
      [
        consumer.unitName,
        {
          effectiveVersion: consumer.effectiveVersion,
          moduleClosureDigest: consumer.moduleClosureDigest,
          serviceQueries: new Set(["channel", "pubsub"]),
        },
      ],
    ]),
    providersByQuery: new Map(),
    consumersByQuery: new Map([
      ["channel", new Set([consumer.unitName])],
      ["pubsub", new Set([consumer.unitName])],
    ]),
    consumersByProviderUnit: new Map(),
    blockingConsumers: new Set(),
  };
  return { ...withoutDigest, digest: authorityDependencyIndexDigest(withoutDigest) };
}

describe("durable authority analysis cache", () => {
  let root: string;
  let filePath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-authority-cache-"));
    filePath = path.join(root, "authority.json");
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("atomically restores a complete exact index and reusable unit facts", () => {
    const consumer: AuthorityConsumerIdentity = {
      epoch: factEpoch,
      unitName: "@workspace-panels/example",
      effectiveVersion: "ev:example",
      moduleClosureDigest: authorityModuleClosureDigest({
        epoch: factEpoch,
        unitName: "@workspace-panels/example",
        effectiveVersion: "ev:example",
        compilerDependencies: [],
      }),
    };
    const identity: AuthorityIndexIdentity = {
      stateHash: "state:published",
      epoch,
      environmentDigest: "environment:v1",
      consumerSource: "analyzer-facts",
      graphDigest: "graph:v1",
    };
    const first = new AuthorityAnalysisCache(filePath);
    first.commit(identity, index(identity, consumer), [
      { identity: consumer, dependencies: [], facts: [fact()] },
    ]);

    const afterRestart = new AuthorityAnalysisCache(filePath);
    const restoredFacts = afterRestart.fact(consumer)?.facts;
    expect(restoredFacts?.[0]?.serviceQueries).toEqual({
      kind: "literals",
      values: new Set(["channel", "pubsub"]),
    });
    expect(
      afterRestart.index(
        identity,
        new Map([
          [
            consumer.unitName,
            {
              effectiveVersion: consumer.effectiveVersion,
              moduleClosureDigest: consumer.moduleClosureDigest,
            },
          ],
        ])
      )
    ).toEqual(index(identity, consumer));
  });

  it("retains interleaved commits through one instance per workspace", () => {
    // `commit` is a read-modify-write over the workspace-local file. Two
    // instances over the same file each hold their own in-memory copy, so the
    // second write drops the first's entries. The analysis worker therefore
    // keeps exactly one instance per workspace and serializes executions; this
    // pins the property that reuse is what makes overlapping commits safe.
    const consumerFor = (unitName: string): AuthorityConsumerIdentity => ({
      epoch: factEpoch,
      unitName,
      effectiveVersion: `ev:${unitName}`,
      moduleClosureDigest: authorityModuleClosureDigest({
        epoch: factEpoch,
        unitName,
        effectiveVersion: `ev:${unitName}`,
        compilerDependencies: [],
      }),
    });
    const identityFor = (stateHash: string): AuthorityIndexIdentity => ({
      stateHash,
      epoch,
      environmentDigest: "environment:v1",
      consumerSource: "analyzer-facts",
      graphDigest: `graph:${stateHash}`,
    });
    const published = consumerFor("@workspace-panels/published");
    const candidate = consumerFor("@workspace-panels/candidate");
    const publishedIdentity = identityFor("state:published");
    const candidateIdentity = identityFor("state:candidate");

    const shared = new AuthorityAnalysisCache(filePath, path.join(root, "facts"));
    shared.commit(publishedIdentity, index(publishedIdentity, published), [
      { identity: published, dependencies: [], facts: [fact()] },
    ]);
    shared.commit(candidateIdentity, index(candidateIdentity, candidate), [
      { identity: candidate, dependencies: [], facts: [fact()] },
    ]);

    const afterRestart = new AuthorityAnalysisCache(filePath, path.join(root, "facts"));
    expect(afterRestart.fact(published)?.facts).toHaveLength(1);
    expect(afterRestart.fact(candidate)?.facts).toHaveLength(1);
    for (const [identity, consumer] of [
      [publishedIdentity, published],
      [candidateIdentity, candidate],
    ] as const) {
      expect(
        afterRestart.index(
          identity,
          new Map([
            [
              consumer.unitName,
              {
                effectiveVersion: consumer.effectiveVersion,
                moduleClosureDigest: consumer.moduleClosureDigest,
              },
            ],
          ])
        )
      ).toEqual(index(identity, consumer));
    }
  });

  it("shares content-addressed facts and complete indexes across workspace caches", () => {
    const consumer: AuthorityConsumerIdentity = {
      epoch: factEpoch,
      unitName: "@workspace-panels/example",
      effectiveVersion: "ev:example",
      moduleClosureDigest: "closure:shared",
    };
    const identity: AuthorityIndexIdentity = {
      stateHash: "state:first-workspace",
      epoch,
      environmentDigest: "environment:v1",
      consumerSource: "analyzer-facts",
      graphDigest: "graph:v1",
    };
    const sharedFacts = path.join(root, "shared-facts");
    const first = new AuthorityAnalysisCache(path.join(root, "workspace-a.json"), sharedFacts);
    first.commit(identity, index(identity, consumer), [
      { identity: consumer, dependencies: [], facts: [fact()] },
    ]);

    const second = new AuthorityAnalysisCache(path.join(root, "workspace-b.json"), sharedFacts);
    expect(second.fact(consumer)?.facts).toEqual([fact()]);
    expect(
      second.factForConsumer({
        epoch: consumer.epoch,
        unitName: consumer.unitName,
        effectiveVersion: consumer.effectiveVersion,
      })?.facts
    ).toEqual([fact()]);
    expect(
      second.index(
        identity,
        new Map([
          [
            consumer.unitName,
            {
              effectiveVersion: consumer.effectiveVersion,
              moduleClosureDigest: consumer.moduleClosureDigest,
            },
          ],
        ])
      )
    ).toEqual(index(identity, consumer));
  });

  it("reuses provider-independent facts across an RPC schema epoch change", () => {
    const consumer: AuthorityConsumerIdentity = {
      epoch: factEpoch,
      unitName: "@workspace-panels/example",
      effectiveVersion: "ev:example",
      moduleClosureDigest: "closure:shared",
    };
    const identity: AuthorityIndexIdentity = {
      stateHash: "state:published",
      epoch,
      environmentDigest: "environment:v1",
      consumerSource: "analyzer-facts",
      graphDigest: "graph:v1",
    };
    const cache = new AuthorityAnalysisCache(filePath);
    cache.commit(identity, index(identity, consumer), [
      { identity: consumer, dependencies: [], facts: [fact()] },
    ]);

    expect(
      cache.factForConsumer({
        epoch: factEpoch,
        unitName: consumer.unitName,
        effectiveVersion: consumer.effectiveVersion,
      })?.facts
    ).toEqual([fact()]);
    expect(
      cache.index(
        {
          ...identity,
          epoch: { ...identity.epoch, rpcSchemaVersion: "schema:v2" },
        },
        new Map()
      )
    ).toBeNull();
  });

  it("restores a declaration index without requiring analyzer facts", () => {
    const consumer: AuthorityConsumerIdentity = {
      epoch: factEpoch,
      unitName: "@workspace-panels/example",
      effectiveVersion: "ev:example",
      moduleClosureDigest: "manifest:declarations",
    };
    const identity: AuthorityIndexIdentity = {
      stateHash: "state:published",
      epoch,
      environmentDigest: "environment:v1",
      consumerSource: "manifest-declarations",
      graphDigest: "graph:v1",
    };
    const sharedFacts = path.join(root, "shared-facts");
    new AuthorityAnalysisCache(path.join(root, "workspace-a.json"), sharedFacts).commit(
      identity,
      index(identity, consumer),
      []
    );

    expect(
      new AuthorityAnalysisCache(path.join(root, "workspace-b.json"), sharedFacts).index(
        identity,
        new Map([[consumer.unitName, { effectiveVersion: consumer.effectiveVersion }]])
      )
    ).toEqual(index(identity, consumer));
  });

  it("revalidates exact compiler dependencies without a global root fingerprint", () => {
    const dependencyPath = path.join(root, "external.d.ts");
    fs.writeFileSync(dependencyPath, "export interface Value { current: true }");
    const dependencies = [
      { path: dependencyPath, contentHash: hash(fs.readFileSync(dependencyPath, "utf8")) },
    ];
    const consumer: AuthorityConsumerIdentity = {
      epoch: factEpoch,
      unitName: "@workspace-panels/example",
      effectiveVersion: "ev:example",
      moduleClosureDigest: authorityModuleClosureDigest({
        epoch: factEpoch,
        unitName: "@workspace-panels/example",
        effectiveVersion: "ev:example",
        compilerDependencies: dependencies,
      }),
    };
    const identity: AuthorityIndexIdentity = {
      stateHash: "state:published",
      epoch,
      environmentDigest: "environment:v1",
      consumerSource: "analyzer-facts",
      graphDigest: "graph-without-global-root-deps",
    };
    const cache = new AuthorityAnalysisCache(filePath);
    cache.commit(identity, index(identity, consumer), [
      { identity: consumer, dependencies, facts: [fact()] },
    ]);
    const base = {
      epoch: consumer.epoch,
      unitName: consumer.unitName,
      effectiveVersion: consumer.effectiveVersion,
    };
    expect(cache.factForConsumer(base)?.facts).toEqual([fact()]);
    expect(
      cache.index(
        identity,
        new Map([[consumer.unitName, { effectiveVersion: consumer.effectiveVersion }]])
      )
    ).not.toBeNull();

    fs.writeFileSync(dependencyPath, "export interface Value { current: false }");

    expect(cache.factForConsumer(base)).toBeNull();
    expect(
      cache.index(
        identity,
        new Map([[consumer.unitName, { effectiveVersion: consumer.effectiveVersion }]])
      )
    ).toBeNull();
  });

  it("rejects index reuse when environment, graph, or covered closure identity changes", () => {
    const consumer: AuthorityConsumerIdentity = {
      epoch: factEpoch,
      unitName: "@workspace-panels/example",
      effectiveVersion: "ev:example",
      moduleClosureDigest: "closure:v1",
    };
    const identity: AuthorityIndexIdentity = {
      stateHash: "state:published",
      epoch,
      environmentDigest: "environment:v1",
      consumerSource: "analyzer-facts",
      graphDigest: "graph:v1",
    };
    const cache = new AuthorityAnalysisCache(filePath);
    cache.commit(identity, index(identity, consumer), [
      { identity: consumer, dependencies: [], facts: [fact()] },
    ]);

    expect(cache.index({ ...identity, environmentDigest: "environment:v2" }, new Map())).toBeNull();
    expect(cache.index({ ...identity, graphDigest: "graph:v2" }, new Map())).toBeNull();
    expect(
      cache.index(
        identity,
        new Map([
          [
            consumer.unitName,
            { effectiveVersion: consumer.effectiveVersion, moduleClosureDigest: "closure:v2" },
          ],
        ])
      )
    ).toBeNull();
  });

  it("treats corrupt storage as cache amnesia", () => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "{not-json");
    const cache = new AuthorityAnalysisCache(filePath);
    const consumer: AuthorityConsumerIdentity = {
      epoch: factEpoch,
      unitName: "unit",
      effectiveVersion: "ev",
      moduleClosureDigest: "closure",
    };
    expect(cache.fact(consumer)).toBeNull();
  });

  it("commits service-query sets to the authority index digest", () => {
    const consumer: AuthorityConsumerIdentity = {
      epoch: factEpoch,
      unitName: "@workspace-panels/example",
      effectiveVersion: "ev:example",
      moduleClosureDigest: "closure:v1",
    };
    const identity: AuthorityIndexIdentity = {
      stateHash: "state:published",
      epoch,
      environmentDigest: "environment:v1",
      consumerSource: "analyzer-facts",
      graphDigest: "graph:v1",
    };
    const first = index(identity, consumer);
    const changedWithoutDigest: Omit<AuthorityDependencyIndex, "digest"> = {
      stateHash: first.stateHash,
      epoch: first.epoch,
      complete: first.complete,
      consumerInputs: new Map([
        [
          consumer.unitName,
          {
            effectiveVersion: consumer.effectiveVersion,
            moduleClosureDigest: consumer.moduleClosureDigest,
            serviceQueries: new Set(["different-service"]),
          },
        ],
      ]),
      providersByQuery: first.providersByQuery,
      consumersByQuery: first.consumersByQuery,
      consumersByProviderUnit: first.consumersByProviderUnit,
      blockingConsumers: first.blockingConsumers,
    };
    expect(authorityDependencyIndexDigest(changedWithoutDigest)).not.toBe(first.digest);
  });

  it("rejects persistence when any consumer blocked analysis", () => {
    const consumer: AuthorityConsumerIdentity = {
      epoch: factEpoch,
      unitName: "@workspace-panels/broken",
      effectiveVersion: "ev:broken",
      moduleClosureDigest: "closure:broken",
    };
    const identity: AuthorityIndexIdentity = {
      stateHash: "state:blocked",
      epoch,
      environmentDigest: "environment:v1",
      consumerSource: "analyzer-facts",
      graphDigest: "graph:v1",
    };
    const blocked = {
      ...index(identity, consumer),
      blockingConsumers: new Set([consumer.unitName]),
    };

    expect(() => new AuthorityAnalysisCache(filePath).commit(identity, blocked, [])).toThrow(
      "Cannot persist an incomplete or mismatched authority index"
    );
    expect(fs.existsSync(filePath)).toBe(false);
  });
});
