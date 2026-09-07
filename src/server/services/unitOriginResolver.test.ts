import { describe, expect, it } from "vitest";
import { UnitOriginResolver } from "./unitOriginResolver.js";

function resolver(input: {
  root?: { url: string | null; ref: string | null; version: string | null } | null;
  recorded?: Record<string, { url: string | null; version?: string; selfName?: string }>;
  bootstrap?: ReadonlySet<string>;
}) {
  return new UnitOriginResolver({
    recordedSourceFor: (repoPath) => input.recorded?.[repoPath] ?? null,
    rootTemplatePin: () => input.root ?? null,
    isBootstrapRepository: async (repoPath) => (input.bootstrap ?? new Set()).has(repoPath),
    hostBuildVersion: () => "1.4.0",
    admittedOriginKeys: () => new Set(),
  });
}

describe("unit source origin", () => {
  it("uses durable VCS admission provenance for integrated source", async () => {
    const origins = await resolver({
      recorded: {
        "extensions/tools": {
          url: "https://github.com/acme/tools.git",
          version: "v2",
          selfName: "Acme Tools",
        },
      },
    }).originsFor(["extensions/tools"]);
    expect(origins.get("extensions/tools")).toMatchObject({
      url: "https://github.com/acme/tools.git",
      version: "v2",
      selfName: "Acme Tools",
      isHostBuild: false,
    });
  });
  it("uses the immutable workspace root provenance for bootstrap repositories", async () => {
    const origins = await resolver({
      root: { url: "https://github.com/acme/workspace.git", ref: "refs/tags/v3", version: "v3" },
      bootstrap: new Set(["workers/agent"]),
    }).originsFor(["workers/agent"]);
    expect(origins.get("workers/agent")).toMatchObject({
      url: "https://github.com/acme/workspace.git",
      version: "v3",
      isWorkspaceRoot: true,
    });
  });
  it("does not attribute an unproven local repository to the host build", async () => {
    const origins = await resolver({}).originsFor(["extensions/local"]);
    expect(origins.get("extensions/local")).toMatchObject({
      originStatus: "unresolved",
      isHostBuild: false,
    });
  });
});
