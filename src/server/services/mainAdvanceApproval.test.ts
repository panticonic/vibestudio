import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ReviewedUnit } from "@vibestudio/shared/approvals";
import {
  createVerifiedCaller,
  type HostAuthorityEffect,
  type ServiceContext,
} from "@vibestudio/shared/serviceDispatcher";
import type { UnitChangeApprovalProvider } from "@vibestudio/unit-host";
import { EMPTY_STATE_HASH } from "@vibestudio/content-addressing";
import { mirrorWorktreeTree, putBytes } from "./blobstoreService.js";
import YAML from "yaml";
import {
  canonicalTemplateNodeId,
  normalizeTemplateGitUrl,
  templateAliasFromUrl,
} from "@vibestudio/workspace/templateCoordinates";
import type { WorkspaceTemplateState } from "@vibestudio/workspace-contracts/types";
import { WORKSPACE_SYSTEM_EPOCH } from "@vibestudio/shared/vcs/systemEpoch";
import {
  createMainAdvanceApprovalGate,
  createMainRefAdvanceGate,
  type InstallReviewPresentation,
  type MainAdvanceApprovalCandidate,
  type RefAdvanceGateContext,
  type RepoDeletionApprovalCandidate,
  type SemanticAdvanceApprovalCandidate,
} from "./mainAdvanceApproval.js";

type TemplateStateNode = WorkspaceTemplateState["nodes"][number];

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempStatePath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-main-advance-"));
  roots.push(root);
  return root;
}

const unit: ReviewedUnit = {
  unitKind: "extension",
  unitName: "@workspace-extensions/tools",
  displayName: "Tools",
  version: "1.0.0",
  source: { kind: "workspace-repo", repo: "extensions/tools", ref: "main" },
  capabilities: [],
};

/** A protected publication candidate as the ref gate produces it. */
function candidate(
  overrides: Partial<MainAdvanceApprovalCandidate> = {}
): MainAdvanceApprovalCandidate {
  return {
    caller: panelCaller(),
    repoPaths: ["meta"],
    changedPaths: ["meta/vibestudio.yml"],
    stateHash: "state:next",
    publicationId: "publication:next",
    ...overrides,
  };
}

function panelCaller() {
  return createVerifiedCaller("panel-1", "panel", {
    callerId: "panel-1",
    callerKind: "panel",
    repoPath: "panels/test",
    effectiveVersion: "ev-panel",
  });
}

function extensionCaller() {
  return createVerifiedCaller("@workspace-extensions/template-composer", "extension", {
    callerId: "@workspace-extensions/template-composer",
    callerKind: "extension",
    repoPath: "extensions/template-composer",
    effectiveVersion: "ev-composer",
  });
}

function gateDeps(opts: { decision?: "once" | "session" | "version" | "deny" } = {}) {
  const authorizeEffect = vi.fn(async (_ctx: ServiceContext, effect: HostAuthorityEffect) => {
    if ((opts.decision ?? "once") === "deny") {
      throw new Error(effect.challenge?.deniedReason ?? "Authority denied");
    }
  });
  return {
    authorizeEffect,
    getProviders: () => [] as UnitChangeApprovalProvider<ReviewedUnit>[],
  };
}

describe("createMainAdvanceApprovalGate", () => {
  it("gates extension-authored main advances as ordinary verified userland code", async () => {
    const deps = gateDeps();
    const gate = createMainAdvanceApprovalGate(deps);

    await gate.approve(candidate({ caller: extensionCaller() }));

    expect(deps.authorizeEffect).toHaveBeenCalledWith(
      expect.objectContaining({
        caller: expect.objectContaining({
          runtime: {
            id: "@workspace-extensions/template-composer",
            kind: "extension",
          },
        }),
      }),
      expect.objectContaining({
        capability: "git.publish",
        resourceKey: "workspace-source-change:publication:publication:next",
      })
    );
  });

  it("approves main meta advances with the semantic install-review prompt", async () => {
    const deps = gateDeps({ decision: "session" });
    const provider: UnitChangeApprovalProvider<ReviewedUnit> = {
      unitChangeApprovalForCommit: vi.fn(async () => ({
        units: [unit],
        identityKeys: ["identity:unit"],
      })),
      acceptPreapprovedTrust: vi.fn(),
    };
    const reportInstallLandingByToken = vi.fn();
    const gate = createMainAdvanceApprovalGate({
      ...deps,
      getProviders: () => [provider],
      reportInstallLandingByToken,
    });

    const completion = await gate.approve(candidate());

    expect(provider.unitChangeApprovalForCommit).toHaveBeenCalledWith("state:next", {
      changedPaths: ["meta/vibestudio.yml"],
    });
    expect(deps.authorizeEffect).toHaveBeenCalledWith(
      expect.objectContaining({ authorityAcquisition: "wait" }),
      expect.objectContaining({
        capability: "git.publish",
        resourceKey: "workspace-source-change:publication:publication:next",
        challenge: expect.objectContaining({
          installReview: expect.objectContaining({
            mode: "part-changed",
            reportsLanding: true,
            landingToken: "publication:next",
            configWrite: {
              repoPath: "meta",
              summary: "meta/vibestudio.yml changed",
            },
            units: [unit],
          }),
        }),
      })
    );
    expect(provider.acceptPreapprovedTrust).not.toHaveBeenCalled();
    await completion?.committed();
    expect(provider.acceptPreapprovedTrust).toHaveBeenCalledWith(["identity:unit"], "publication");
    expect(reportInstallLandingByToken).toHaveBeenCalledWith("publication:next", {
      landed: ["extensions/tools@"],
    });
  });

  it("records admission for an interactive chrome publication without prompting", async () => {
    const deps = gateDeps();
    const provider: UnitChangeApprovalProvider<ReviewedUnit> = {
      unitChangeApprovalForCommit: vi.fn(async () => ({
        units: [unit],
        identityKeys: ["identity:unit"],
      })),
      acceptPreapprovedTrust: vi.fn(),
    };
    const gate = createMainAdvanceApprovalGate({ ...deps, getProviders: () => [provider] });

    const completion = await gate.approve(
      candidate({ caller: createVerifiedCaller("shell", "shell") })
    );

    // The click IS the consent, so no prompt — but the units it introduced are
    // admitted rather than left to fall through to per-unit prompts later.
    expect(deps.authorizeEffect).not.toHaveBeenCalled();
    expect(provider.acceptPreapprovedTrust).not.toHaveBeenCalled();
    await completion?.committed();
    expect(provider.acceptPreapprovedTrust).toHaveBeenCalledWith(["identity:unit"], "chrome");
  });

  it("does not admit a reviewed unit when the protected publication fails", async () => {
    const deps = gateDeps();
    const reportInstallLandingByToken = vi.fn();
    const provider: UnitChangeApprovalProvider<ReviewedUnit> = {
      unitChangeApprovalForCommit: vi.fn(async () => ({
        units: [unit],
        identityKeys: ["identity:unit"],
      })),
      acceptPreapprovedTrust: vi.fn(),
    };
    const gate = createMainAdvanceApprovalGate({
      ...deps,
      getProviders: () => [provider],
      reportInstallLandingByToken,
    });
    const completion = await gate.approve(candidate());
    const failure = new Error("protected refs rejected the publication");

    await completion?.failed(failure);

    expect(provider.acceptPreapprovedTrust).not.toHaveBeenCalled();
    expect(reportInstallLandingByToken).toHaveBeenCalledWith("publication:next", {
      landed: [],
      failed: [
        {
          identityKey: "extensions/tools@",
          reason: failure.message,
        },
      ],
      workspaceUnchanged: true,
    });
  });

  it("gates a headless-host publication, which has no user and no click", async () => {
    const deps = gateDeps();
    const provider: UnitChangeApprovalProvider<ReviewedUnit> = {
      unitChangeApprovalForCommit: vi.fn(async () => ({ units: [], identityKeys: [] })),
      acceptPreapprovedTrust: vi.fn(),
    };
    const gate = createMainAdvanceApprovalGate({ ...deps, getProviders: () => [provider] });

    await expect(
      gate.approve(candidate({ caller: createVerifiedCaller("headless-host", "shell") }))
    ).rejects.toThrow(/not supported|Unknown caller identity/u);
    expect(provider.acceptPreapprovedTrust).not.toHaveBeenCalled();
  });

  it("routes retries through canonical authority so its grant store decides reuse", async () => {
    const deps = gateDeps({ decision: "once" });
    const provider: UnitChangeApprovalProvider<ReviewedUnit> = {
      unitChangeApprovalForCommit: vi.fn(async () => ({
        units: [unit],
        identityKeys: ["identity:unit"],
      })),
      acceptPreapprovedTrust: vi.fn(),
    };
    const gate = createMainAdvanceApprovalGate({
      ...deps,
      getProviders: () => [provider],
    });
    const cand = candidate();

    const first = await gate.approve(cand);
    const second = await gate.approve(cand);
    await first?.committed();
    await second?.committed();

    expect(deps.authorizeEffect).toHaveBeenCalledTimes(2);
    expect(provider.acceptPreapprovedTrust).toHaveBeenCalledTimes(2);
  });

  it("combines a non-meta main advance and affected unit trust in one prompt", async () => {
    const deps = gateDeps({ decision: "version" });
    const provider: UnitChangeApprovalProvider<ReviewedUnit> = {
      unitChangeApprovalForCommit: vi.fn(async () => ({ units: [unit], identityKeys: [] })),
      acceptPreapprovedTrust: vi.fn(),
    };
    const gate = createMainAdvanceApprovalGate({ ...deps, getProviders: () => [provider] });

    const completion = await gate.approve(
      candidate({ repoPaths: ["apps/shell"], changedPaths: ["apps/shell/index.tsx"] })
    );

    expect(deps.authorizeEffect).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        resourceKey: "workspace-source-change:publication:publication:next",
        challenge: expect.objectContaining({
          installReview: expect.objectContaining({
            mode: "part-changed",
            units: [unit],
            configWrite: null,
          }),
        }),
      })
    );
    expect(provider.unitChangeApprovalForCommit).toHaveBeenCalledWith("state:next", {
      changedPaths: ["apps/shell/index.tsx"],
    });
    await completion?.committed();
    expect(provider.acceptPreapprovedTrust).toHaveBeenCalledWith([], "publication");
  });

  it("approves a content-identical semantic advance with its exact event edge", async () => {
    const deps = gateDeps();
    const gate = createMainAdvanceApprovalGate(deps);

    await gate.approveSemanticAdvance({
      caller: panelCaller(),
      previousEventId: "event:before",
      publishedEventId: "event:after",
      via: "do:Agent:one",
    });

    expect(deps.authorizeEffect).toHaveBeenCalledWith(
      expect.objectContaining({ authorityAcquisition: "wait" }),
      expect.objectContaining({
        capability: "git.publish",
        challenge: expect.objectContaining({
          dedupKey: "workspace-semantic-advance:event:after",
          title: "Advance workspace history",
          description:
            "This advances workspace main to a new semantic event without changing protected repository content.",
          details: [
            { label: "Via", value: "do:Agent:one" },
            { label: "Previous event", value: "event:before" },
            { label: "Published event", value: "event:after" },
          ],
        }),
      })
    );
  });

  it("bypasses the prompt for a chrome-authorized RESOLVED caller (on-behalf-of, not the writer DO)", async () => {
    // §10 attribution + §5 chrome bypass: a shell-originated push flows through
    // the same vcs DO as a panel push, but the gate keys on the host-RESOLVED
    // on-behalf-of caller. A chrome/shell principal keeps its user-level trust,
    // so no approval is queued — regardless of the (untrusted) writer DO.
    const deps = gateDeps({ decision: "deny" });
    const gate = createMainAdvanceApprovalGate(deps);
    const shell = createVerifiedCaller("shell:device-1", "shell");

    await gate.approve(
      candidate({
        caller: shell,
        via: "do:workers/workspace-source:GadWorkspaceDO:workspace",
        repoPaths: ["apps/shell"],
        changedPaths: ["apps/shell/index.tsx"],
      })
    );

    expect(deps.authorizeEffect).not.toHaveBeenCalled();
  });

  it("does not let meta session grants skip mixed workspace changes", async () => {
    // Defensive guard: production candidates are per-repo (all-meta or
    // no-meta — the ref gate re-roots every path with the one advancing
    // repo), but if a mixed candidate ever appeared, a `meta` session grant
    // must NOT silently cover the non-meta paths. The summary reports the
    // meta paths only (the unreachable mixed-path summary branch was
    // deleted in P5b).
    const deps = gateDeps({ decision: "once" });
    const gate = createMainAdvanceApprovalGate({
      ...deps,
      getProviders: () => [
        {
          unitChangeApprovalForCommit: vi.fn(async () => ({ units: [], identityKeys: [] })),
          acceptPreapprovedTrust: vi.fn(),
        },
      ],
    });

    await gate.approve(
      candidate({ changedPaths: ["meta/vibestudio.yml", "apps/shell/index.tsx"] })
    );

    expect(deps.authorizeEffect).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        challenge: expect.objectContaining({
          installReview: expect.objectContaining({
            configWrite: {
              repoPath: "meta",
              summary: "meta/vibestudio.yml changed",
            },
          }),
        }),
      })
    );
  });

  it("does not prompt (or forward a diff payload) for an advance with no changed paths", async () => {
    const deps = gateDeps({ decision: "once" });
    const gate = createMainAdvanceApprovalGate(deps);

    await gate.approve(
      candidate({
        repoPaths: ["apps/shell"],
        changedPaths: [],
        diffReview: [
          {
            repoPath: "apps/shell",
            oldState: "state:a",
            newState: "state:b",
            diffStat: { filesChanged: 0 },
            changedFiles: [],
          },
        ],
      })
    );

    expect(deps.authorizeEffect).not.toHaveBeenCalled();
  });

  it("forwards the diff-review payload onto the git.publish prompt", async () => {
    const deps = gateDeps({ decision: "once" });
    const gate = createMainAdvanceApprovalGate(deps);
    const signal = new AbortController().signal;
    const diffReview = [
      {
        repoPath: "apps/shell",
        oldState: "state:a",
        newState: "state:b",
        diffStat: { filesChanged: 1, insertions: 2, deletions: 1 },
        changedFiles: [
          { path: "index.tsx", kind: "changed" as const, oldHash: "h1", newHash: "h2" },
        ],
      },
    ];

    await gate.approve(
      candidate({
        repoPaths: ["apps/shell"],
        changedPaths: ["apps/shell/index.tsx"],
        diffReview,
        signal,
      })
    );

    expect(deps.authorizeEffect).toHaveBeenCalledWith(
      expect.objectContaining({ authorityAcquisition: "wait", signal }),
      expect.objectContaining({
        resourceKey: "workspace-source-change:publication:publication:next",
        challenge: expect.objectContaining({
          dedupKey: "workspace-publication:publication:next",
          resource: expect.objectContaining({ value: "apps/shell main" }),
          diffReview,
        }),
      })
    );
  });

  it("rejects denied main meta advances", async () => {
    const gate = createMainAdvanceApprovalGate({
      ...gateDeps({ decision: "deny" }),
      getProviders: () => [
        {
          unitChangeApprovalForCommit: vi.fn(async () => ({ units: [], identityKeys: [] })),
          acceptPreapprovedTrust: vi.fn(),
        },
      ],
    });

    await expect(gate.approve(candidate())).rejects.toThrow("Workspace main update denied");
  });

  it("rejects denied non-meta main advances", async () => {
    const gate = createMainAdvanceApprovalGate(gateDeps({ decision: "deny" }));

    await expect(
      gate.approve(
        candidate({
          repoPaths: ["panels/spectrolite"],
          changedPaths: ["panels/spectrolite/index.tsx"],
        })
      )
    ).rejects.toThrow("Workspace main update denied");
  });

  describe("approveRepoDeletion", () => {
    const deletionCandidate = {
      caller: panelCaller(),
      repoPath: "panels/old",
      fileCount: 3,
      stateHash: "state:doomed",
    };

    it("prompts with the dedicated severe per-repo deletion capability", async () => {
      const deps = gateDeps({ decision: "once" });
      const gate = createMainAdvanceApprovalGate(deps);

      await gate.approveRepoDeletion(deletionCandidate);

      expect(deps.authorizeEffect).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          capability: "workspace-repo-delete",
          tier: "critical",
          resourceKey: "workspace-repo-delete:panels/old",
          challenge: expect.objectContaining({ severity: "severe" }),
        })
      );
    });

    it("throws when the user denies the deletion", async () => {
      const gate = createMainAdvanceApprovalGate(gateDeps({ decision: "deny" }));
      await expect(gate.approveRepoDeletion(deletionCandidate)).rejects.toThrow(
        /Deletion of panels\/old denied/
      );
    });

    it("uses a capability distinct from ordinary git.publish", async () => {
      const deps = gateDeps({ decision: "deny" });
      const gate = createMainAdvanceApprovalGate(deps);

      await expect(gate.approveRepoDeletion(deletionCandidate)).rejects.toThrow(/denied/);
      expect(deps.authorizeEffect).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ capability: "workspace-repo-delete" })
      );
    });
  });

  /**
   * Template operations (§5.3, §5.4, §7.2, §7.3, §13.9).
   *
   * Every case here drives the presentation with relationship state alone.
   * That state may select template-specific framing, while the independently
   * derived changed units and permission review remain authoritative.
   */
  describe("template operations", () => {
    const NEWS_URL = "git+https://github.com/panticonic/news";
    const OTHER_URL = "git+https://github.com/panticonic/weather";

    function node(input: {
      url: string;
      ref: string;
      commit: string;
      parents?: string[];
      presentation?: { name?: string; description?: string };
    }): TemplateStateNode {
      return {
        nodeId: canonicalTemplateNodeId(input.url, input.commit),
        alias: templateAliasFromUrl(input.url),
        pin: {
          url: normalizeTemplateGitUrl(input.url),
          ref: input.ref,
          commit: input.commit,
          snapshot: `v1-sha256:${"a".repeat(64)}`,
        },
        parents: input.parents ?? [],
        fragment: `systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}\n`,
        ...(input.presentation ? { presentation: input.presentation } : {}),
        suggestions: {},
      };
    }

    /** The relationship state the composer commits alongside the workspace. */
    function stateYaml(input: {
      nodes: TemplateStateNode[];
      repositories: Record<string, string>;
    }): string {
      const state: WorkspaceTemplateState = {
        version: 1 as const,
        roots: input.nodes
          .filter((candidate) => candidate.parents.length === 0)
          .map((candidate) => ({ url: candidate.pin.url }))
          .sort((left, right) => left.url.localeCompare(right.url)),
        overrides: {},
        nodes: input.nodes,
        repositories: Object.fromEntries(
          Object.entries(input.repositories).map(([repoPath, nodeId]) => [
            repoPath,
            {
              contributions: [{ nodeId, subtreeDigest: `v1-sha256:${"c".repeat(64)}` as const }],
            },
          ])
        ),
      };
      return YAML.stringify(state);
    }

    const newsNode = node({ url: NEWS_URL, ref: "v1.2.0", commit: "1".repeat(40) });
    const newsNodeUpdated = node({ url: NEWS_URL, ref: "v1.4.0", commit: "2".repeat(40) });

    function templateUnit(repo: string, name: string): ReviewedUnit {
      return {
        unitKind: "worker",
        unitName: name,
        displayName: name,
        version: "1.0.0",
        source: { kind: "workspace-repo", repo, ref: "main" },
        ev: `ev-${repo}`,
        capabilities: [],
      };
    }

    /** The gate with current (`null`) and candidate workspace template state. */
    function templateGate(input: {
      current: string | null;
      next: string | null;
      units?: ReviewedUnit[];
      unchangedCount?: number;
      previousRequests?: Map<string, readonly []>;
    }) {
      const deps = gateDeps({ decision: "version" });
      const provider: UnitChangeApprovalProvider<ReviewedUnit> = {
        unitChangeApprovalForCommit: vi.fn(async () => ({
          units: input.units ?? [],
          identityKeys: (input.units ?? []).map((u) => `identity:${u.source.repo}`),
          unchangedCount: input.unchangedCount ?? 0,
          ...(input.previousRequests ? { previousRequests: input.previousRequests } : {}),
        })),
        acceptPreapprovedTrust: vi.fn(),
      };
      const gate = createMainAdvanceApprovalGate({
        ...deps,
        getProviders: () => [provider],
        readTemplateState: async (stateHash) => (stateHash === null ? input.current : input.next),
        admittedOriginKeys: () => new Set<string>(),
      });
      return { deps, provider, gate };
    }

    /** The installReview the gate handed the dispatcher. */
    function reviewOf(deps: { authorizeEffect: { mock: { calls: unknown[][] } } }) {
      const effect = deps.authorizeEffect.mock.calls.at(-1)![1] as {
        challenge: {
          title: string;
          installReview?: InstallReviewPresentation;
          dedupKey?: string | null;
        };
      };
      return effect.challenge;
    }

    it("recognizes an install from the state the publication would leave behind", async () => {
      const { deps, gate } = templateGate({
        current: null,
        next: stateYaml({
          nodes: [newsNode],
          repositories: {
            "panels/news": newsNode.nodeId,
            "workers/news-agent": newsNode.nodeId,
          },
        }),
        units: [
          templateUnit("panels/news", "@workspace/news"),
          templateUnit("workers/news-agent", "@workspace/news-agent"),
        ],
      });

      await gate.approve(
        candidate({ repoPaths: ["panels/news"], changedPaths: ["panels/news/x.ts"] })
      );

      const challenge = reviewOf(deps);
      expect(challenge.installReview?.mode).toBe("install");
      // §7.2's header: a URL-derived title, the origin, and human refs only.
      expect(challenge.installReview?.template).toEqual({
        title: "news",
        purpose: "",
        origin: expect.objectContaining({
          // The state's normalized identity URL, never abbreviated away — the
          // same string `UnitOriginResolver` gives every other surface.
          url: "git+https://github.com/panticonic/news",
          originKey: "github.com/panticonic",
          version: "v1.2.0",
          isHostBuild: false,
          firstEncounter: true,
        }),
        fromVersion: null,
        toVersion: "v1.2.0",
      });
      expect(challenge.installReview?.template?.origin.selfName).toBeUndefined();
      // Parts the template delivers carry the template's origin, not ours.
      expect(challenge.installReview?.origins?.get("panels/news")).toMatchObject({
        url: "git+https://github.com/panticonic/news",
        version: "v1.2.0",
      });
      expect(challenge.installReview?.sections?.get("panels/news")).toBe("template");
      expect(challenge.installReview?.sections?.get("workers/news-agent")).toBe("template");
      // One decision, one publication: every repository in the batch coalesces.
      expect(challenge.dedupKey).toBe("workspace-publication:publication:next");
      expect(challenge.title).toBe("Add news");
    });

    describe("what a template says it is called (§7.2, §7.6.3)", () => {
      const namedNews = node({
        url: NEWS_URL,
        ref: "v1.2.0",
        commit: "1".repeat(40),
        presentation: {
          name: "News",
          description: "Read and discuss personalized news briefings.",
        },
      });

      it("heads the card with the template's own name and sentence", async () => {
        const { deps, gate } = templateGate({
          current: null,
          next: stateYaml({
            nodes: [namedNews],
            repositories: { "panels/news": namedNews.nodeId },
          }),
          units: [templateUnit("panels/news", "@workspace/news")],
        });

        await gate.approve(
          candidate({ repoPaths: ["panels/news"], changedPaths: ["panels/news/x.ts"] })
        );

        const review = reviewOf(deps).installReview!;
        // §7.2's header verbatim: `Add News` over the template's own sentence.
        expect(reviewOf(deps).title).toBe("Add News");
        expect(review.template?.title).toBe("News");
        expect(review.template?.purpose).toBe("Read and discuss personalized news briefings.");
      });

      it("keeps the URL as identity while the name rides along as a claim", async () => {
        const { deps, gate } = templateGate({
          current: null,
          next: stateYaml({
            nodes: [namedNews],
            repositories: { "panels/news": namedNews.nodeId },
          }),
          units: [templateUnit("panels/news", "@workspace/news")],
        });

        await gate.approve(
          candidate({ repoPaths: ["panels/news"], changedPaths: ["panels/news/x.ts"] })
        );

        const review = reviewOf(deps).installReview!;
        // The name never becomes any part of who this is: not the URL, not the
        // first-encounter key, not the emphasized domain.
        expect(review.template?.origin).toMatchObject({
          url: "git+https://github.com/panticonic/news",
          originKey: "github.com/panticonic",
          registrableDomain: "github.com",
          selfName: "News",
          isHostBuild: false,
        });
        // Parts carry their owning node's claim the same way.
        expect(review.origins?.get("panels/news")).toMatchObject({
          originKey: "github.com/panticonic",
          selfName: "News",
        });
      });

      it("a template calling itself Vibestudio is titled, never identified, as one", async () => {
        const impostorUrl = "git+https://github.com/attacker/news";
        const impostor = node({
          url: impostorUrl,
          ref: "v9.9.9",
          commit: "3".repeat(40),
          presentation: { name: "Vibestudio", description: "The official base." },
        });
        const { deps, gate } = templateGate({
          current: null,
          next: stateYaml({
            nodes: [impostor],
            repositories: { "panels/news": impostor.nodeId },
          }),
          units: [templateUnit("panels/news", "@workspace/news")],
        });

        await gate.approve(
          candidate({ repoPaths: ["panels/news"], changedPaths: ["panels/news/x.ts"] })
        );

        const review = reviewOf(deps).installReview!;
        const origin = review.template!.origin;
        // The heading is attributed to the template, so it may say this. Every
        // identity field still says attacker, and `isHostBuild` — the one flag
        // that means "this is our own code" — is unmoved.
        expect(review.template?.title).toBe("Vibestudio");
        expect(origin.isHostBuild).toBe(false);
        expect(origin.originKey).toBe("github.com/attacker");
        expect(origin.url).toBe("git+https://github.com/attacker/news");
        expect(origin.registrableDomain).toBe("github.com");
        expect(review.origins?.get("panels/news")).toMatchObject({
          originKey: "github.com/attacker",
          isHostBuild: false,
        });
      });

      it.each([
        ["a control character", "News\u0007Alert"],
        ["a right-to-left override", "News \u202Etxt.exe"],
        ["a zero-width joiner", "New\u200Bs"],
        ["an interpunct that forges the origin line", "News \u00B7 github.com/vibestudio"],
        ["a name longer than a heading", "N".repeat(61)],
      ])("renders nothing rather than a name carrying %s", async (_case, hostile) => {
        const hostileNode = node({
          url: NEWS_URL,
          ref: "v1.2.0",
          commit: "1".repeat(40),
          presentation: { name: hostile },
        });
        const { deps, gate } = templateGate({
          current: null,
          next: stateYaml({
            nodes: [hostileNode],
            repositories: { "panels/news": hostileNode.nodeId },
          }),
          units: [templateUnit("panels/news", "@workspace/news")],
        });

        await gate.approve(
          candidate({ repoPaths: ["panels/news"], changedPaths: ["panels/news/x.ts"] })
        );

        const review = reviewOf(deps).installReview!;
        // Falls back to the URL stem: a worse heading, and an honest one.
        expect(review.template?.title).toBe("news");
        expect(review.template?.purpose).toBe("");
        expect(review.template?.origin.selfName).toBeUndefined();
        expect(review.origins?.get("panels/news")?.selfName).toBeUndefined();
      });
    });

    it("puts a fix to a part the template does not own in the repair section", async () => {
      const { deps, gate } = templateGate({
        current: null,
        next: stateYaml({
          nodes: [newsNode],
          repositories: { "panels/news": newsNode.nodeId },
        }),
        units: [
          templateUnit("panels/news", "@workspace/news"),
          // A part already in the workspace that the same publication also
          // changes: the build gate's in-context fix (§5.3).
          templateUnit("panels/chat", "@workspace/chat"),
        ],
      });

      await gate.approve(
        candidate({ repoPaths: ["meta"], changedPaths: ["meta/templates.state.yml"] })
      );

      const review = reviewOf(deps).installReview!;
      expect(review.sections?.get("panels/news")).toBe("template");
      expect(review.sections?.get("panels/chat")).toBe("repair");
      // A repair is not attributed to the template that arrived beside it.
      expect(review.origins?.get("panels/chat")?.url).not.toBe(
        "git+https://github.com/panticonic/news"
      );
    });

    it("presents an update differentially, with both human refs and no commit", async () => {
      const previousRequests = new Map<string, readonly []>([["panels/news", []]]);
      const { deps, gate } = templateGate({
        current: stateYaml({
          nodes: [newsNode],
          repositories: { "panels/news": newsNode.nodeId },
        }),
        next: stateYaml({
          nodes: [newsNodeUpdated],
          repositories: { "panels/news": newsNodeUpdated.nodeId },
        }),
        units: [templateUnit("panels/news", "@workspace/news")],
        previousRequests,
        unchangedCount: 9,
      });

      await gate.approve(
        candidate({ repoPaths: ["panels/news"], changedPaths: ["panels/news/x.ts"] })
      );

      const review = reviewOf(deps).installReview!;
      expect(review.mode).toBe("update");
      expect(review.template?.fromVersion).toBe("v1.2.0");
      expect(review.template?.toVersion).toBe("v1.4.0");
      // The differential list is exactly what the provider found changed, and
      // the rest is a count (§5.4).
      expect(review.units).toHaveLength(1);
      expect(review.unchangedPartCount).toBe(9);
      expect(review.previousRequests?.get("panels/news")).toEqual([]);
      expect(JSON.stringify(review.template)).not.toContain("1".repeat(40));
      expect(JSON.stringify(review.template)).not.toContain("2".repeat(40));
    });

    it("gives an effective-version-only update one line instead of no card at all", async () => {
      const { deps, provider, gate } = templateGate({
        current: stateYaml({
          nodes: [newsNode],
          repositories: { "panels/news": newsNode.nodeId },
        }),
        next: stateYaml({
          nodes: [newsNodeUpdated],
          repositories: { "panels/news": newsNodeUpdated.nodeId },
        }),
        units: [],
        unchangedCount: 12,
      });

      // A repository advance with no meta write and no authority change: the
      // ordinary path returns silently here, and a template update must not.
      const completion = await gate.approve(
        candidate({ repoPaths: ["panels/news"], changedPaths: ["panels/news/x.ts"] })
      );

      const review = reviewOf(deps).installReview!;
      expect(review.mode).toBe("update");
      expect(review.units).toHaveLength(0);
      expect(review.unchangedPartCount).toBe(12);
      await completion?.committed();
      expect(provider.acceptPreapprovedTrust).toHaveBeenCalledWith([], "publication");
    });

    it("recognizes a removal from the root the publication drops", async () => {
      const { deps, gate } = templateGate({
        current: stateYaml({
          nodes: [newsNode],
          repositories: { "panels/news": newsNode.nodeId },
        }),
        next: null,
      });

      await gate.approve(
        candidate({ repoPaths: ["meta"], changedPaths: ["meta/templates.state.yml"] })
      );

      const review = reviewOf(deps).installReview!;
      expect(review.mode).toBe("remove");
      expect(review.template?.fromVersion).toBe("v1.2.0");
      expect(review.template?.toVersion).toBeNull();
      expect(reviewOf(deps).title).toBe("Remove news");
    });

    it("severs the relationship with one gated review, not a deletion prompt", async () => {
      // §U2: removal deletes nothing. The composer's removal plan orphans the
      // repositories it owned and rewrites `meta/` — it drops no repository — so
      // this publication reaches the gate as a single meta advance and must be
      // asked as one ordinary gated question. A per-repo deletion cascade here
      // would be the workspace telling the user their parts are going away in
      // exactly the operation whose copy promises they are not.
      const { deps, gate } = templateGate({
        current: stateYaml({
          nodes: [newsNode],
          repositories: {
            "panels/news": newsNode.nodeId,
            "workers/news-agent": newsNode.nodeId,
          },
        }),
        next: null,
      });

      await gate.approve(
        candidate({ repoPaths: ["meta"], changedPaths: ["meta/templates.state.yml"] })
      );

      expect(deps.authorizeEffect).toHaveBeenCalledTimes(1);
      const effect = deps.authorizeEffect.mock.calls.at(-1)![1] as HostAuthorityEffect;
      expect(effect.capability).toBe("git.publish");
      expect(effect.tier).toBe("gated");
      expect(effect.challenge?.severity).toBeUndefined();
      const review = reviewOf(deps).installReview!;
      expect(review.mode).toBe("remove");
      // No part is named as going anywhere, so no admission and no grant is
      // implicated: severing is a change to a relationship, not to a part.
      expect(review.units).toEqual([]);
    });

    it("leaves an ordinary publication on the part-changed card", async () => {
      const state = stateYaml({
        nodes: [newsNode],
        repositories: { "panels/news": newsNode.nodeId },
      });
      const { deps, gate } = templateGate({
        current: state,
        // Same closure on both sides: nothing about template relationships moved.
        next: state,
        units: [templateUnit("panels/news", "@workspace/news")],
      });

      await gate.approve(
        candidate({ repoPaths: ["panels/news"], changedPaths: ["panels/news/x.ts"] })
      );

      const review = reviewOf(deps).installReview!;
      expect(review.mode).toBe("part-changed");
      expect(review.template).toBeUndefined();
      expect(review.sections).toBeUndefined();
    });

    it("uses structurally valid candidate state as descriptive install framing", async () => {
      const edited = YAML.parse(
        stateYaml({ nodes: [newsNode], repositories: { "panels/news": newsNode.nodeId } })
      ) as { nodes: TemplateStateNode[] };
      edited.nodes[0]!.pin.ref = "v9.9.9";
      const { deps, gate } = templateGate({
        current: null,
        next: YAML.stringify(edited),
        units: [templateUnit("panels/news", "@workspace/news")],
      });

      await gate.approve(
        candidate({
          caller: extensionCaller(),
          repoPaths: ["panels/news"],
          changedPaths: ["panels/news/x.ts"],
        })
      );

      const review = reviewOf(deps).installReview!;
      expect(review.mode).toBe("install");
      expect(review.template?.toVersion).toBe("v9.9.9");
    });

    it("names no single template when a publication moves two of them", async () => {
      const otherNode = node({ url: OTHER_URL, ref: "v0.3.0", commit: "3".repeat(40) });
      const { deps, gate } = templateGate({
        current: null,
        next: stateYaml({
          nodes: [newsNode, otherNode],
          repositories: {
            "panels/news": newsNode.nodeId,
            "panels/weather": otherNode.nodeId,
          },
        }),
        units: [templateUnit("panels/news", "@workspace/news")],
      });

      await gate.approve(
        candidate({ repoPaths: ["meta"], changedPaths: ["meta/templates.state.yml"] })
      );

      expect(reviewOf(deps).installReview!.mode).toBe("part-changed");
    });

    it("discards the whole operation, repairs included, when the decision is no", async () => {
      const { deps, provider, gate } = templateGate({
        current: null,
        next: stateYaml({
          nodes: [newsNode],
          repositories: { "panels/news": newsNode.nodeId },
        }),
        units: [
          templateUnit("panels/news", "@workspace/news"),
          templateUnit("panels/chat", "@workspace/chat"),
        ],
      });
      deps.authorizeEffect.mockImplementation(async () => {
        throw new Error("Workspace main update denied");
      });

      await expect(
        gate.approve(candidate({ repoPaths: ["panels/news"], changedPaths: ["panels/news/x.ts"] }))
      ).rejects.toThrow(/denied/u);
      // Declining fails the publication itself, so nothing is admitted — not
      // the template's parts and not the repairs riding with them (§5.3).
      expect(provider.acceptPreapprovedTrust).not.toHaveBeenCalled();
    });
  });

  // Phase 4/5: `approveRepoRestore` + the dedicated restore capability are gone.
  // A restore re-creates the ref (`expectedOld: null`) and flows through the
  // generic advance prompt as an add-repo (see the createMainRefAdvanceGate
  // suite's "re-creation … ordinary content advance" case).
});

describe("createMainRefAdvanceGate (the reshaped batch approval gate)", () => {
  /** Mirror a repo-relative file listing into a scratch blob store and return
   *  its state hash — the CAS'd trees the gate diffs. */
  async function stageTree(
    blobsDir: string,
    files: Array<{ path: string; body: string }>
  ): Promise<string> {
    fs.mkdirSync(path.join(blobsDir, "tmp"), { recursive: true });
    const listing = [];
    for (const file of files) {
      const { digest } = await putBytes(blobsDir, Buffer.from(file.body, "utf8"));
      listing.push({ path: file.path, contentHash: digest, mode: 33188 });
    }
    const mirrored = await mirrorWorktreeTree(blobsDir, listing);
    return mirrored.stateHash;
  }

  function refGateDeps(blobsDir: string) {
    const approvals: MainAdvanceApprovalCandidate[] = [];
    const semanticAdvances: SemanticAdvanceApprovalCandidate[] = [];
    const deletions: Array<{ repoPath: string; fileCount: number; stateHash: string }> = [];
    // Phase 4/5: restore is no longer a distinct classification — `restores`
    // stays empty (the gate never calls a restore hook); a re-creation lands in
    // `approvals` as an ordinary advance. Kept for the "re-creation" assertion.
    const restores: Array<{ repoPath: string; fileCount: number; stateHash: string }> = [];
    // Full candidates (incl. the diff-review payload) captured separately so the
    // existing summary assertions on `deletions` stay exact.
    const deletionCandidates: RepoDeletionApprovalCandidate[] = [];
    const initializations: boolean[] = [];
    const gate = createMainRefAdvanceGate({
      blobsDir,
      approvalGate: {
        approve: async (candidate) => {
          approvals.push(candidate);
          return undefined;
        },
        approveSemanticAdvance: async (candidate) => {
          semanticAdvances.push(candidate);
        },
        approveRepoDeletion: async (c) => {
          deletions.push({ repoPath: c.repoPath, fileCount: c.fileCount, stateHash: c.stateHash });
          deletionCandidates.push(c);
        },
      },
      // Trees are staged locally above; like the real vcsHost implementation,
      // the empty state needs no store round trip — just the empty tree node.
      ensureStateMirrored: async (stateHash) => {
        if (stateHash === EMPTY_STATE_HASH) await mirrorWorktreeTree(blobsDir, []);
      },
      workspaceViewWithReposAt: async () => "state:composed-fallback",
      onWorkspaceInitialized: () => {
        initializations.push(true);
      },
    });
    return {
      gate,
      approvals,
      semanticAdvances,
      deletions,
      restores,
      deletionCandidates,
      initializations,
    };
  }

  type Entry = {
    repoPath?: string;
    old?: string | null;
    next: string | null;
    priorDeleted?: boolean;
  };

  function batch(
    entries: Entry[],
    context: unknown,
    operation: "push" | "merge" | "import" | "delete" | "restore" = "push"
  ) {
    return {
      entries: entries.map((e) => ({
        repoPath: e.repoPath ?? "panels/x",
        old: e.old ?? null,
        next: e.next,
        priorDeleted: e.priorDeleted ?? false,
      })),
      publication: {
        publicationId: "publication:test",
        previousEventId: "event:before",
        publishedEventId: "event:after",
      },
      operation,
      reason: "test",
      writer: "do:workers/workspace-source:GadWorkspaceDO:workspace",
      onBehalfOf: null,
      ...(context !== undefined ? { gateContext: context } : {}),
    };
  }

  it("fails CLOSED when the batch carries no gate context", async () => {
    const blobsDir = path.join(tempStatePath(), "blobs");
    const { gate, approvals } = refGateDeps(blobsDir);
    const next = await stageTree(blobsDir, [{ path: "a.txt", body: "a\n" }]);

    await expect(gate(batch([{ next }], undefined))).rejects.toThrow(/no gate context/);
    expect(approvals).toHaveLength(0);
  });

  it("only the exact workspace-initialization publication bypasses approval", async () => {
    const blobsDir = path.join(tempStatePath(), "blobs");
    const { gate, approvals } = refGateDeps(blobsDir);
    const next = await stageTree(blobsDir, [{ path: "a.txt", body: "a\n" }]);

    await gate(batch([{ next }], { kind: "workspace-initialization" }));
    expect(approvals).toHaveLength(0);
  });

  it("records that the ungated creation publication owes a creation review", async () => {
    const blobsDir = path.join(tempStatePath(), "blobs");
    const { gate, initializations } = refGateDeps(blobsDir);
    const next = await stageTree(blobsDir, [{ path: "a.txt", body: "a\n" }]);

    await gate(batch([{ next }], { kind: "workspace-initialization" }));

    expect(initializations).toEqual([true]);
  });

  it("fails closed for the former generic system authority", async () => {
    const blobsDir = path.join(tempStatePath(), "blobs");
    const { gate } = refGateDeps(blobsDir);
    const next = await stageTree(blobsDir, [{ path: "a.txt", body: "a\n" }]);

    await expect(gate(batch([{ next }], { kind: "system" }))).rejects.toThrow(/no gate context/);
  });

  it("uses the narrow validator for an epoch-transition publication", async () => {
    const blobsDir = path.join(tempStatePath(), "blobs");
    const transitionValidator = vi.fn(async () => undefined);
    const ordinaryValidator = vi.fn(async () => {
      throw new Error("ordinary parser must not inspect a future manifest");
    });
    const transitionGate = createMainRefAdvanceGate({
      blobsDir,
      approvalGate: {
        approve: async () => undefined,
        approveSemanticAdvance: async () => undefined,
        approveRepoDeletion: async () => undefined,
      },
      ensureStateMirrored: async () => undefined,
      workspaceViewWithReposAt: async () => "state:future-workspace",
      validateCandidateWorkspaceState: ordinaryValidator,
      validateEpochTransitionCandidate: transitionValidator,
    });
    await transitionGate(
      batch([], {
        kind: "caller",
        caller: panelCaller(),
        epochTransition: true,
      })
    );

    expect(transitionValidator).toHaveBeenCalledWith(
      "state:future-workspace",
      [],
      undefined,
      expect.any(Function)
    );
    expect(ordinaryValidator).not.toHaveBeenCalled();
  });

  it("approves a content-identical semantic main advance", async () => {
    const blobsDir = path.join(tempStatePath(), "blobs");
    const { gate, semanticAdvances } = refGateDeps(blobsDir);

    await gate(batch([], { kind: "caller", caller: panelCaller(), via: "agent:one" }));

    expect(semanticAdvances).toEqual([
      {
        caller: panelCaller(),
        previousEventId: "event:before",
        publishedEventId: "event:after",
        via: "agent:one",
      },
    ]);
  });

  it("computes the approval's changed paths from the server-side tree diff, re-rooted to the repo", async () => {
    const blobsDir = path.join(tempStatePath(), "blobs");
    const { gate, approvals } = refGateDeps(blobsDir);
    const oldState = await stageTree(blobsDir, [
      { path: "kept.txt", body: "same\n" },
      { path: "changed.txt", body: "v1\n" },
      { path: "removed.txt", body: "bye\n" },
    ]);
    const next = await stageTree(blobsDir, [
      { path: "kept.txt", body: "same\n" },
      { path: "changed.txt", body: "v2\n" },
      { path: "added.txt", body: "hi\n" },
    ]);
    const context: RefAdvanceGateContext = {
      kind: "caller",
      caller: panelCaller(),
    };

    await gate(batch([{ old: oldState, next }], context));

    expect(approvals).toHaveLength(1);
    const candidate = approvals[0]!;
    // Server-computed: exactly the tree delta, never anything the caller
    // proposed; kept.txt (identical) is absent.
    expect([...candidate.changedPaths].sort()).toEqual([
      "panels/x/added.txt",
      "panels/x/changed.txt",
      "panels/x/removed.txt",
    ]);
    expect(candidate.repoPaths).toEqual(["panels/x"]);
    // No candidate view supplied → the gate composes one itself.
    expect(candidate.stateHash).toBe("state:composed-fallback");
  });

  it("rejects a candidate workspace invariant before approval", async () => {
    const blobsDir = path.join(tempStatePath(), "blobs");
    const next = await stageTree(blobsDir, [{ path: "vibestudio.yml", body: "changed\n" }]);
    const approve = vi.fn();
    const beginCandidateReview = vi.fn();
    const failCandidateReview = vi.fn();
    const validateCandidateWorkspaceState = vi.fn(async () => {
      throw new Error("workspace-source coordinates changed");
    });
    const gate = createMainRefAdvanceGate({
      blobsDir,
      approvalGate: {
        approve,
        approveSemanticAdvance: vi.fn(),
        approveRepoDeletion: vi.fn(),
      },
      ensureStateMirrored: vi.fn(async () => undefined),
      workspaceViewWithReposAt: vi.fn(async () => "state:candidate"),
      beginCandidateReview,
      failCandidateReview,
      validateCandidateWorkspaceState,
    });

    await expect(
      gate(
        batch([{ repoPath: "meta", old: null, next }], {
          kind: "caller",
          caller: panelCaller(),
        })
      )
    ).rejects.toThrow("workspace-source coordinates changed");
    expect(validateCandidateWorkspaceState).toHaveBeenCalledWith(
      "state:candidate",
      ["meta"],
      undefined,
      expect.any(Function)
    );
    expect(beginCandidateReview).toHaveBeenCalledWith(
      expect.objectContaining({
        publicationId: "publication:test",
        stateHash: "state:candidate",
      })
    );
    expect(beginCandidateReview.mock.invocationCallOrder[0]).toBeLessThan(
      validateCandidateWorkspaceState.mock.invocationCallOrder[0]!
    );
    expect(failCandidateReview).toHaveBeenCalledWith(
      "publication:test",
      expect.objectContaining({ message: "workspace-source coordinates changed" })
    );
    expect(approve).not.toHaveBeenCalled();
  });

  it("a main creation (old null) diffs against the empty tree", async () => {
    const blobsDir = path.join(tempStatePath(), "blobs");
    const { gate, approvals } = refGateDeps(blobsDir);
    const next = await stageTree(blobsDir, [
      { path: "a.txt", body: "a\n" },
      { path: "b/c.txt", body: "c\n" },
    ]);

    await gate(
      batch([{ old: null, next }], {
        kind: "caller",
        caller: panelCaller(),
      } satisfies RefAdvanceGateContext)
    );

    expect(approvals).toHaveLength(1);
    expect([...approvals[0]!.changedPaths].sort()).toEqual(["panels/x/a.txt", "panels/x/b/c.txt"]);
  });

  it("passes a supplied candidate workspace view through (batches share one)", async () => {
    const blobsDir = path.join(tempStatePath(), "blobs");
    const { gate, approvals } = refGateDeps(blobsDir);
    const next = await stageTree(blobsDir, [{ path: "a.txt", body: "a\n" }]);

    await gate(
      batch([{ next }], {
        kind: "caller",
        caller: panelCaller(),
        candidateWorkspaceState: "state:group-candidate",
      } satisfies RefAdvanceGateContext)
    );

    expect(approvals[0]!.stateHash).toBe("state:group-candidate");
  });

  it("routes a delete entry (next null) to the severe repo-deletion capability", async () => {
    const blobsDir = path.join(tempStatePath(), "blobs");
    const { gate, approvals, deletions } = refGateDeps(blobsDir);
    const oldState = await stageTree(blobsDir, [
      { path: "a.txt", body: "a\n" },
      { path: "b.txt", body: "b\n" },
    ]);

    await gate(
      batch([{ repoPath: "panels/old", old: oldState, next: null }], {
        kind: "caller",
        caller: panelCaller(),
      } satisfies RefAdvanceGateContext)
    );

    expect(approvals).toHaveLength(0);
    expect(deletions).toEqual([{ repoPath: "panels/old", fileCount: 2, stateHash: oldState }]);
  });

  it("a template removal touches meta only, so nothing routes to the deletion gate", async () => {
    // The established fact behind §U2, asserted at the layer that would break
    // it: removal's publication carries no `next: null` entry, because the
    // composer's plan orphans repositories rather than dropping them. The severe
    // deletion capability is reachable only from a genuine repository deletion.
    const blobsDir = path.join(tempStatePath(), "blobs");
    const { gate, approvals, deletions } = refGateDeps(blobsDir);
    const before = await stageTree(blobsDir, [
      { path: "templates.state.yml", body: "version: 1\n" },
      { path: "templates/t-abc.yml", body: "systemEpoch: 1\n" },
    ]);
    const after = await stageTree(blobsDir, [{ path: "vibestudio.yml", body: "id: w\n" }]);

    await gate(
      batch([{ repoPath: "meta", old: before, next: after }], {
        kind: "caller",
        caller: extensionCaller(),
      } satisfies RefAdvanceGateContext)
    );

    expect(deletions).toEqual([]);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.repoPaths).toEqual(["meta"]);
  });

  it("treats a re-creation (old null, non-null next) as an ordinary content advance", async () => {
    // Phase 5: the host no longer classifies restores. A previously-deleted
    // repo's re-creation is just an expectedOld:null → tree advance; the
    // restore saga (archive lookup, restore capability) lives in the DO now.
    const blobsDir = path.join(tempStatePath(), "blobs");
    const { gate, approvals, restores } = refGateDeps(blobsDir);
    const next = await stageTree(blobsDir, [{ path: "a.txt", body: "a\n" }]);

    await gate(
      batch([{ repoPath: "panels/old", old: null, next }], {
        kind: "caller",
        caller: panelCaller(),
      } satisfies RefAdvanceGateContext)
    );

    expect(restores).toHaveLength(0);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.repoPaths).toEqual(["panels/old"]);
    expect([...approvals[0]!.changedPaths]).toEqual(["panels/old/a.txt"]);
  });

  it("a mixed batch (advance + delete) yields one advance prompt and one deletion prompt", async () => {
    const blobsDir = path.join(tempStatePath(), "blobs");
    const { gate, approvals, deletions } = refGateDeps(blobsDir);
    const advNext = await stageTree(blobsDir, [{ path: "x.txt", body: "x\n" }]);
    const delOld = await stageTree(blobsDir, [{ path: "y.txt", body: "y\n" }]);

    await gate(
      batch(
        [
          { repoPath: "panels/keep", old: null, next: advNext },
          { repoPath: "panels/drop", old: delOld, next: null },
        ],
        {
          kind: "caller",
          caller: panelCaller(),
          candidateWorkspaceState: "state:batch-view",
        } satisfies RefAdvanceGateContext
      )
    );

    expect(approvals.map((c) => c.repoPaths)).toEqual([["panels/keep"]]);
    expect(approvals[0]!.stateHash).toBe("state:batch-view");
    expect(deletions.map((d) => d.repoPath)).toEqual(["panels/drop"]);
  });

  it("authorizes a multi-repository advance as one atomic publication", async () => {
    const blobsDir = path.join(tempStatePath(), "blobs");
    const { gate, approvals } = refGateDeps(blobsDir);
    const panel = await stageTree(blobsDir, [{ path: "index.tsx", body: "export {}\n" }]);
    const worker = await stageTree(blobsDir, [{ path: "index.ts", body: "export {}\n" }]);

    await gate(
      batch(
        [
          { repoPath: "panels/task-board", next: panel },
          { repoPath: "workers/task-board-store", next: worker },
        ],
        {
          kind: "caller",
          caller: panelCaller(),
          candidateWorkspaceState: "state:task-board-publication",
        } satisfies RefAdvanceGateContext
      )
    );

    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      repoPaths: ["panels/task-board", "workers/task-board-store"],
      publicationId: "publication:test",
      stateHash: "state:task-board-publication",
    });
    expect(approvals[0]!.changedPaths).toEqual([
      "panels/task-board/index.tsx",
      "workers/task-board-store/index.ts",
    ]);
  });

  describe("diff-review payload (§5.1)", () => {
    const HEX64 = /^[0-9a-f]{64}$/;
    const callerContext = (
      extra: Partial<Extract<RefAdvanceGateContext, { kind: "caller" }>> = {}
    ): RefAdvanceGateContext => ({
      kind: "caller",
      caller: panelCaller(),
      ...extra,
    });

    it("attaches per-entry kinds/hashes and accurate line counts for an advance", async () => {
      const blobsDir = path.join(tempStatePath(), "blobs");
      const { gate, approvals } = refGateDeps(blobsDir);
      const oldState = await stageTree(blobsDir, [
        { path: "kept.txt", body: "same\n" },
        { path: "changed.txt", body: "l1\nl2\nl3\n" },
        { path: "removed.txt", body: "bye\n" },
      ]);
      const next = await stageTree(blobsDir, [
        { path: "kept.txt", body: "same\n" },
        { path: "changed.txt", body: "l1\nL2\nl3\n" },
        { path: "added.txt", body: "new\n" },
      ]);

      await gate(batch([{ old: oldState, next }], callerContext()));

      const review = approvals[0]!.diffReview!;
      expect(review).toHaveLength(1);
      const entry = review[0]!;
      expect(entry.repoPath).toBe("panels/x");
      expect(entry.oldState).toBe(oldState);
      expect(entry.newState).toBe(next);
      // filesChanged is exact; line totals are the accurate per-file sums:
      //   changed.txt +1/-1, added.txt +1, removed.txt -1.
      expect(entry.diffStat).toEqual({ filesChanged: 3, insertions: 2, deletions: 2 });

      const byPath = Object.fromEntries(entry.changedFiles.map((f) => [f.path, f]));
      expect(byPath["added.txt"]!.kind).toBe("added");
      expect(byPath["added.txt"]!.newHash).toMatch(HEX64);
      expect(byPath["added.txt"]!.oldHash).toBeUndefined();
      expect(byPath["removed.txt"]!.kind).toBe("removed");
      expect(byPath["removed.txt"]!.oldHash).toMatch(HEX64);
      expect(byPath["removed.txt"]!.newHash).toBeUndefined();
      expect(byPath["changed.txt"]!.kind).toBe("changed");
      expect(byPath["changed.txt"]!.oldHash).toMatch(HEX64);
      expect(byPath["changed.txt"]!.newHash).toMatch(HEX64);
      expect(byPath["changed.txt"]!.oldHash).not.toBe(byPath["changed.txt"]!.newHash);
      // The diff-review payload is the SAME array across the whole batch.
      expect(approvals[0]!.diffReview).toBe(review);
    });

    it("attaches an all-removed payload with newState null for a delete entry", async () => {
      const blobsDir = path.join(tempStatePath(), "blobs");
      const { gate, deletionCandidates } = refGateDeps(blobsDir);
      const oldState = await stageTree(blobsDir, [
        { path: "a.txt", body: "a\n" },
        { path: "b.txt", body: "b\n" },
      ]);

      await gate(batch([{ repoPath: "panels/old", old: oldState, next: null }], callerContext()));

      const entry = deletionCandidates[0]!.diffReview![0]!;
      expect(entry.repoPath).toBe("panels/old");
      expect(entry.oldState).toBe(oldState);
      expect(entry.newState).toBeNull();
      expect(entry.changedFiles.every((f) => f.kind === "removed")).toBe(true);
      expect(entry.changedFiles.every((f) => f.oldHash && !f.newHash)).toBe(true);
      // All-removed text: two one-line files → 0 insertions, 2 deletions.
      expect(entry.diffStat).toEqual({ filesChanged: 2, insertions: 0, deletions: 2 });
    });

    it("flags binary and oversized files and omits the entry's line totals", async () => {
      const blobsDir = path.join(tempStatePath(), "blobs");
      const { gate, approvals } = refGateDeps(blobsDir);
      const bigBody = "x".repeat(1024 * 1024 + 16); // > 1 MiB → tooLarge
      const next = await stageTree(blobsDir, [
        { path: "text.txt", body: "hi\n" },
        { path: "bin.dat", body: "a\x00b\n" },
        { path: "big.txt", body: bigBody },
      ]);

      await gate(batch([{ old: null, next }], callerContext()));

      const entry = approvals[0]!.diffReview![0]!;
      const byPath = Object.fromEntries(entry.changedFiles.map((f) => [f.path, f]));
      expect(byPath["bin.dat"]!.binary).toBe(true);
      expect(byPath["big.txt"]!.tooLarge).toBe(true);
      expect(byPath["text.txt"]!.binary).toBeUndefined();
      expect(byPath["text.txt"]!.tooLarge).toBeUndefined();
      // A skipped (binary/oversized) file forfeits the whole entry's line totals.
      expect(entry.diffStat).toEqual({ filesChanged: 3 });
      expect(entry.diffStat.insertions).toBeUndefined();
    });

    it("truncates the file list at the cap while keeping filesChanged exact", async () => {
      const blobsDir = path.join(tempStatePath(), "blobs");
      const { gate, approvals } = refGateDeps(blobsDir);
      const files = Array.from({ length: 501 }, (_, i) => ({
        path: `f${String(i).padStart(4, "0")}.txt`,
        body: `line-${i}\n`,
      }));
      const next = await stageTree(blobsDir, files);

      await gate(batch([{ old: null, next }], callerContext()));

      const entry = approvals[0]!.diffReview![0]!;
      expect(entry.changedFiles).toHaveLength(500);
      expect(entry.truncated).toBe(true);
      expect(entry.diffStat.filesChanged).toBe(501);
      // A truncated list can't carry accurate totals → omitted.
      expect(entry.diffStat.insertions).toBeUndefined();
    });
  });
});
