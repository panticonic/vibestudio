import { describe, expect, it } from "vitest";
import { WorkspaceConfigSchema } from "./workspaceConfigSchema.js";

const BASE = { id: "test", systemEpoch: 56 } as const;

function configWithUpstream(upstream: Record<string, unknown>) {
  return {
    ...BASE,
    git: {
      remotes: {
        panels: {
          news: {
            origin: {
              url: "https://github.com/acme/news.git",
              branch: "main",
            },
          },
        },
      },
      upstreams: {
        panels: {
          news: upstream,
        },
      },
    },
  };
}

describe("workspace Git upstream contract", () => {
  it("accepts ordinary upstream tracking with a logical credential", () => {
    expect(
      WorkspaceConfigSchema.parse(
        configWithUpstream({
          remote: "origin",
          branch: "main",
          credential: "github-panels",
        })
      ).git?.upstreams?.["panels"]?.["news"]
    ).toEqual({
      remote: "origin",
      branch: "main",
      credential: "github-panels",
    });
  });

  it("rejects host-owned seed acquisition declarations", () => {
    expect(
      WorkspaceConfigSchema.safeParse(
        configWithUpstream({
          remote: "origin",
          seed: {
            ref: "refs/tags/v1.4.0",
            commit: "7a6f4c9d7d9d5d1b3b7a4cf97f046dd05f6b0d92",
            snapshot: `v1-sha256:${"d".repeat(64)}`,
          },
        })
      ).success
    ).toBe(false);
  });

  it("rejects concrete credentialId and nullable credential compatibility forms", () => {
    expect(
      WorkspaceConfigSchema.safeParse(
        configWithUpstream({ remote: "origin", credentialId: "concrete-install-id" })
      ).success
    ).toBe(false);
    expect(
      WorkspaceConfigSchema.safeParse(configWithUpstream({ remote: "origin", credential: null }))
        .success
    ).toBe(false);
  });
});

describe("workspace Durable Object service context", () => {
  it("accepts creator-context factory services and rejects unknown placement modes", () => {
    const service = {
      source: "workers/pubsub-channel",
      name: "channel",
      action: "send messages",
      presentation: { domain: "sharing", verb: "act", substanceKind: "send" },
      authority: { principals: ["user"] },
    } as const;
    expect(
      WorkspaceConfigSchema.parse({
        ...BASE,
        services: [
          { ...service, durableObject: { className: "PubSubChannel", context: "creator" } },
        ],
      }).services?.[0]
    ).toMatchObject({ durableObject: { context: "creator" } });
    expect(
      WorkspaceConfigSchema.safeParse({
        ...BASE,
        services: [
          { ...service, durableObject: { className: "PubSubChannel", context: "caller" } },
        ],
      }).success
    ).toBe(false);
  });
});
