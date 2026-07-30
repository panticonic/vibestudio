import { describe, expect, it } from "vitest";
import {
  GIT_INTEROP_PROVIDER_METHOD_NAMES,
  gitInteropMethods,
  gitInteropProviderMethods,
} from "./gitInterop.js";

const SEMANTIC_EVIDENCE = {
  applicationId: "application:import",
  workUnitId: "work-unit:import",
  externalSnapshot: {
    sourceKind: "git" as const,
    sourceUri: "https://example.test/demo.git",
    snapshotRevision: "a".repeat(40),
    sourceSubdir: null,
    canonicalSnapshot: `v1-sha256:${"c".repeat(64)}`,
    snapshotDigest: `snapshot:${"b".repeat(64)}`,
    targetRepositoryIds: ["repository:demo"],
  },
};

describe("gitInterop canonical contract", () => {
  it("exposes one exact public method table", () => {
    expect(Object.keys(gitInteropMethods)).toEqual([
      "setSharedRemote",
      "removeSharedRemote",
      "setUpstream",
      "removeUpstream",
      "detachUpstream",
      "setAutoPush",
      "upstreamStatus",
      "pushUpstream",
      "pullUpstream",
      "publishRepo",
      "commitMapping",
      "importProject",
    ]);
  });

  it("models portable logical and anonymous Git credential selection distinctly", () => {
    for (const credential of [undefined, "github-main"]) {
      const upstream = {
        remote: "origin",
        ...(credential !== undefined ? { credential } : {}),
      };
      expect(
        gitInteropMethods.setUpstream.args.safeParse(["projects/demo", upstream]).success
      ).toBe(true);
    }
  });

  it("requires truthful force-overwrite relationship metadata", () => {
    const base = {
      exported: 1,
      headCommit: "abc",
      outcome: "pushed",
    };
    expect(
      gitInteropMethods.pushUpstream.returns.safeParse({
        ...base,
        overwrites: {
          relationship: "unrelated",
          count: null,
          commits: [{ sha: "remote", summary: "Remote history" }],
          truncated: false,
        },
      }).success
    ).toBe(true);
    expect(
      gitInteropMethods.pushUpstream.returns.safeParse({
        ...base,
        overwrites: {
          relationship: "related",
          count: null,
          commits: [],
          truncated: false,
        },
      }).success
    ).toBe(false);
  });

  it("accepts only array-based status queries", () => {
    expect(gitInteropMethods.upstreamStatus.args.safeParse([[]]).success).toBe(true);
    expect(
      gitInteropMethods.upstreamStatus.args.safeParse([["projects/demo"], { branch: "release" }])
        .success
    ).toBe(true);
    expect(
      gitInteropMethods.upstreamStatus.args.safeParse([["projects/demo"], { fetch: true }]).success
    ).toBe(false);
    expect(gitInteropMethods.upstreamStatus.args.safeParse([]).success).toBe(false);
    expect(gitInteropMethods.upstreamStatus.args.safeParse(["projects/demo", {}]).success).toBe(
      false
    );
    expect(gitInteropMethods.upstreamStatus.args.safeParse([null, {}]).success).toBe(false);
    expect(gitInteropMethods.upstreamStatus.args.safeParse([undefined]).success).toBe(false);
    expect(gitInteropMethods.upstreamStatus.description).toContain(
      "git.upstreamStatus([imported.path])"
    );
  });

  it("models omitted options as shorter tuples that survive JSON transport", () => {
    const calls = [
      [gitInteropMethods.setAutoPush.args, ["projects/demo", true]],
      [gitInteropMethods.pushUpstream.args, ["projects/demo"]],
      [gitInteropMethods.pullUpstream.args, ["projects/demo"]],
      [gitInteropMethods.upstreamStatus.args, [[]]],
    ] as const;

    for (const [schema, args] of calls) {
      const parsed = schema.parse(args);
      expect(JSON.parse(JSON.stringify(parsed))).toEqual(parsed);
      expect(JSON.stringify(parsed)).not.toContain("null");
    }

    expect(gitInteropMethods.setAutoPush.args.safeParse(["projects/demo"]).success).toBe(false);
    expect(gitInteropMethods.setAutoPush.args.safeParse(["projects/demo", undefined]).success).toBe(
      false
    );
    expect(
      gitInteropMethods.pushUpstream.args.safeParse(["projects/demo", undefined]).success
    ).toBe(false);
    expect(
      gitInteropMethods.pullUpstream.args.safeParse(["projects/demo", undefined]).success
    ).toBe(false);
  });

  it("requires concrete collection results from every config mutation", () => {
    for (const method of [
      gitInteropMethods.setSharedRemote,
      gitInteropMethods.removeSharedRemote,
      gitInteropMethods.setUpstream,
      gitInteropMethods.removeUpstream,
      gitInteropMethods.setAutoPush,
    ]) {
      expect(method.returns.safeParse({}).success).toBe(true);
      expect(method.returns.safeParse(undefined).success).toBe(false);
      expect(method.returns.safeParse(null).success).toBe(false);
    }
  });

  it("accepts an import branch only inside the canonical remote object", () => {
    expect(
      gitInteropMethods.importProject.args.safeParse([
        {
          path: "projects/demo",
          remote: {
            name: "origin",
            url: "https://github.com/octo/demo.git",
            branch: "feature/import",
          },
        },
      ]).success
    ).toBe(true);
    expect(
      gitInteropMethods.importProject.args.safeParse([
        {
          path: "projects/demo",
          remote: { name: "origin", url: "https://github.com/octo/demo.git" },
          branch: "feature/import",
        },
      ]).success
    ).toBe(false);
  });

  it("returns the exact semantic candidate created by a project import", () => {
    const result = {
      path: "projects/demo",
      remote: { name: "origin", url: "https://example.test/demo.git", branch: "main" },
      candidate: {
        contextId: "git-bridge-demo",
        eventId: "event:imported",
        changed: true,
        semanticEvidence: SEMANTIC_EVIDENCE,
      },
    };
    expect(gitInteropMethods.importProject.returns.safeParse(result).success).toBe(true);
    expect(
      gitInteropMethods.importProject.returns.safeParse({
        ...result,
        candidate: {
          contextId: result.candidate.contextId,
          eventId: result.candidate.eventId,
          changed: result.candidate.changed,
        },
      }).success
    ).toBe(false);
    expect(
      gitInteropMethods.importProject.returns.safeParse({
        path: result.path,
        remote: result.remote,
      }).success
    ).toBe(false);
    expect(gitInteropMethods.importProject.description).toContain("identity-joined evidence");
  });

  it("exposes only canonical object declarations in config mutation results", () => {
    const canonical = {
      projects: {
        demo: {
          origin: { url: "https://github.com/acme/demo.git", branch: "main" },
        },
      },
    };
    expect(gitInteropMethods.setSharedRemote.returns.safeParse(canonical).success).toBe(true);
    expect(
      gitInteropMethods.setSharedRemote.returns.safeParse({
        projects: { demo: { origin: "https://github.com/acme/demo.git" } },
      }).success
    ).toBe(false);
    expect(
      gitInteropMethods.setSharedRemote.returns.safeParse({
        projects: {
          demo: { origin: { url: "https://github.com/acme/demo.git", branch: null } },
        },
      }).success
    ).toBe(false);
    expect(
      gitInteropMethods.setUpstream.returns.safeParse({
        projects: { demo: null },
      }).success
    ).toBe(false);
    expect(
      gitInteropMethods.setUpstream.returns.safeParse({
        projects: { demo: { remote: "origin" } },
      }).success
    ).toBe(true);
    expect(
      gitInteropMethods.setUpstream.returns.safeParse({
        projects: {
          demo: {
            remote: "origin",
            seed: {
              ref: "refs/tags/v1",
              commit: "a".repeat(40),
              snapshot: `v1-sha256:${"b".repeat(64)}`,
            },
          },
        },
      }).success
    ).toBe(false);
  });

  it("accepts one strict publish input and rejects legacy options", () => {
    expect(
      gitInteropMethods.publishRepo.args.safeParse([
        { repoPath: "projects/demo", provider: "github", autoPush: true },
      ]).success
    ).toBe(true);
    expect(
      gitInteropMethods.publishRepo.args.safeParse(["projects/demo", { provider: "github" }])
        .success
    ).toBe(false);
    expect(
      gitInteropMethods.publishRepo.args.safeParse([{ repoPath: "projects/demo", dryRun: true }])
        .success
    ).toBe(false);
  });

  it("requires the provider's complete publish result", () => {
    const result = {
      repoPath: "projects/demo",
      provider: "github",
      remote: "origin",
      branch: "main",
      remoteUrl: "https://github.com/octo/demo.git",
      webUrl: "https://github.com/octo/demo",
      owner: "octo",
      exported: 1,
      headCommit: "abc123",
      pushed: true,
    };
    expect(gitInteropMethods.publishRepo.returns.safeParse(result).success).toBe(true);
    const { branch: _branch, ...incomplete } = result;
    expect(gitInteropMethods.publishRepo.returns.safeParse(incomplete).success).toBe(false);
  });

  it("rejects impossible fractional or negative Git counts", () => {
    const row = {
      repoPath: "projects/demo",
      remote: "origin",
      branch: "main",
      autoPush: false,
      state: "ahead",
      relationship: "ahead",
      aheadBy: 1,
      behindBy: 0,
      remoteBranchExists: true,
      observedAt: 1,
    };
    expect(gitInteropMethods.upstreamStatus.returns.safeParse([row]).success).toBe(true);
    expect(
      gitInteropMethods.upstreamStatus.returns.safeParse([{ ...row, aheadBy: -1 }]).success
    ).toBe(false);
    expect(
      gitInteropMethods.upstreamStatus.returns.safeParse([{ ...row, behindBy: 0.5 }]).success
    ).toBe(false);
  });

  it("makes an unresolved semantic candidate discoverable in upstream status", () => {
    expect(
      gitInteropMethods.upstreamStatus.returns.safeParse([
        {
          repoPath: "projects/demo",
          remote: "origin",
          branch: "main",
          autoPush: true,
          state: "integration-required",
          candidate: { contextId: "git-bridge-demo", eventId: "event:candidate" },
        },
      ]).success
    ).toBe(true);
  });

  it("defines the complete strict host-only provider contract", () => {
    expect(Object.keys(gitInteropProviderMethods)).toEqual([
      "setSharedRemote",
      "removeSharedRemote",
      "setUpstream",
      "removeUpstream",
      "detachUpstream",
      "setAutoPush",
      "upstreamStatus",
      "pushUpstream",
      "pullUpstream",
      "publishRepo",
      "commitMapping",
      "importProject",
      "cloneRepo",
      "remoteDefaultBranch",
      "reconcileUpstreams",
    ]);
    expect(GIT_INTEROP_PROVIDER_METHOD_NAMES).toEqual(Object.keys(gitInteropProviderMethods));

    expect(
      gitInteropProviderMethods.cloneRepo.args.safeParse([
        { repoPath: "projects/demo", remoteUrl: "https://example.test/demo.git" },
      ]).success
    ).toBe(false);
    expect(
      gitInteropProviderMethods.cloneRepo.returns.safeParse({
        contextId: "git-bridge-demo",
        eventId: "event:123",
        changed: true,
        semanticEvidence: SEMANTIC_EVIDENCE,
      }).success
    ).toBe(true);
    expect(
      gitInteropProviderMethods.cloneRepo.returns.safeParse({
        contextId: "git-bridge-demo",
        eventId: "event:123",
        changed: true,
      }).success
    ).toBe(false);
    expect(
      gitInteropProviderMethods.cloneRepo.returns.safeParse({
        contextId: "git-bridge-demo",
        eventId: "event:123",
      }).success
    ).toBe(false);
    expect(
      gitInteropProviderMethods.cloneRepo.returns.safeParse({
        workspaceStateHash: "state:123",
        changed: true,
      }).success
    ).toBe(false);
    expect(
      gitInteropProviderMethods.commitMapping.returns.safeParse([
        { gitSha: "abc", eventId: "event:123", summary: "Imported snapshot" },
      ]).success
    ).toBe(true);
    expect(
      gitInteropProviderMethods.commitMapping.returns.safeParse([
        {
          gitSha: "abc",
          gadState: "state:legacy",
          gadEvent: "event:legacy",
          summary: "legacy",
        },
      ]).success
    ).toBe(false);
    expect(
      gitInteropProviderMethods.reconcileUpstreams.args.safeParse([
        [{ repoPath: "projects/demo", credentialIdOverride: "credential-1" }],
      ]).success
    ).toBe(true);
    expect(
      gitInteropProviderMethods.reconcileUpstreams.returns.safeParse({ queued: 1, ignored: false })
        .success
    ).toBe(false);
  });
});
