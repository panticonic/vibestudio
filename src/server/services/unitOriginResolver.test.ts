import { describe, expect, it } from "vitest";
import YAML from "yaml";
import {
  canonicalTemplateNodeId,
  normalizeTemplateGitUrl,
  templateAliasFromUrl,
} from "@vibestudio/workspace/templateCoordinates";
import { templateLockFingerprint } from "@vibestudio/workspace/templateLock";
import { UnitOriginResolver, type RecordedUnitSource } from "./unitOriginResolver.js";

const ACME_URL = "https://github.com/acme/studio";
/** The lock records the normalized Git form; identity strings are not rewritten. */
const ACME_LOCK_URL = normalizeTemplateGitUrl(ACME_URL);
const ACME_COMMIT = "a".repeat(40);

/** A lock exactly as the composer commits it, so the resolver's checks apply. */
function lockYaml(
  repositories: Record<string, string>,
  presentation?: { name?: string; description?: string }
): string {
  const url = normalizeTemplateGitUrl(ACME_URL);
  const nodeId = canonicalTemplateNodeId(url, ACME_COMMIT);
  const lock = {
    version: 1 as const,
    roots: [{ url }],
    overrides: {},
    conflicts: {},
    nodes: [
      {
        nodeId,
        alias: templateAliasFromUrl(url),
        pin: {
          url,
          ref: "v2.1",
          commit: ACME_COMMIT,
          snapshot: `v1-sha256:${"b".repeat(64)}` as const,
        },
        parents: [],
        fragmentDigest: `v1-sha256:${"c".repeat(64)}` as const,
        ...(presentation ? { presentation } : {}),
        suggestions: {},
      },
    ],
    repositories: Object.fromEntries(
      Object.keys(repositories).map((repoPath) => [
        repoPath,
        { nodeId, subtreeDigest: `v1-sha256:${"d".repeat(64)}` as const },
      ])
    ),
    verification: "verified" as const,
  };
  return YAML.stringify({ ...lock, fingerprint: templateLockFingerprint(lock) });
}

function resolver(opts: {
  lock?: string | null;
  root?: { url: string | null; ref: string | null; version: string | null } | null;
  admitted?: ReadonlySet<string>;
  recorded?: Record<string, RecordedUnitSource>;
  bootstrapRepos?: ReadonlySet<string>;
}): UnitOriginResolver {
  return new UnitOriginResolver({
    readWorkspaceFile: async () => opts.lock ?? null,
    ...(opts.recorded
      ? { recordedSourceFor: (repoPath: string) => opts.recorded![repoPath] ?? null }
      : {}),
    rootTemplatePin: () => opts.root ?? null,
    isBootstrapRepository: async (repoPath) =>
      (opts.bootstrapRepos ?? new Set(["apps/shell"])).has(repoPath),
    hostBuildVersion: () => "1.4.0",
    admittedOriginKeys: () => opts.admitted ?? new Set(),
    onWarning: () => {},
  });
}

describe("where a unit's bytes came from", () => {
  it("reads ownership from the template lock, and names the pin's human ref", async () => {
    const origins = await resolver({
      lock: lockYaml({ "extensions/acme-tools": "" }),
    }).originsFor(["extensions/acme-tools"]);

    const origin = origins.get("extensions/acme-tools")!;
    expect(origin.isHostBuild).toBe(false);
    expect(origin.url).toBe(ACME_LOCK_URL);
    expect(origin.originKey).toBe("github.com/acme");
    expect(origin.version).toBe("v2.1");
    // Never a commit id or a content digest, at any level.
    expect(JSON.stringify(origin)).not.toMatch(/[0-9a-f]{40}/u);
  });

  it("attributes anything the lock does not claim to the root this workspace was built from", async () => {
    const origins = await resolver({
      lock: lockYaml({ "extensions/acme-tools": "" }),
      root: { url: "https://github.com/other/root", ref: "v9", version: "v9" },
    }).originsFor(["extensions/acme-tools", "apps/shell"]);

    expect(origins.get("apps/shell")!.originKey).toBe("github.com/other");
    expect(origins.get("extensions/acme-tools")!.originKey).toBe("github.com/acme");
  });

  it("calls it our own build only when nothing else claims it", async () => {
    const origins = await resolver({}).originsFor(["apps/shell"]);

    expect(origins.get("apps/shell")).toMatchObject({
      isHostBuild: true,
      originKey: "vibestudio",
      version: "1.4.0",
      firstEncounter: false,
    });
  });

  it("does not call a locally added repository part of the host build", async () => {
    const origins = await resolver({}).originsFor(["extensions/local-tools"]);

    expect(origins.get("extensions/local-tools")).toMatchObject({
      originStatus: "unresolved",
      isHostBuild: false,
    });
  });

  it("marks provenance unresolved when a lock could not be verified", async () => {
    const corrupt = YAML.stringify({
      version: 1,
      fingerprint: `v1-sha256:${"0".repeat(64)}`,
      roots: [],
      overrides: {},
      conflicts: {},
      nodes: [],
      repositories: { "extensions/acme-tools": { nodeId: "x", subtreeDigest: "y" } },
      verification: "verified",
    });
    const origins = await resolver({ lock: corrupt }).originsFor(["extensions/acme-tools"]);

    // Unverifiable bytes establish nothing, so the answer must not fall back
    // to the host build and mislabel third-party code as Vibestudio.
    expect(origins.get("extensions/acme-tools")).toMatchObject({
      originKey: "source unavailable",
      originStatus: "unresolved",
      isHostBuild: false,
    });
  });

  it("does not retain stale ownership after a later lock read failure", async () => {
    let lock: string | null = lockYaml({ "extensions/acme-tools": "" });
    const instance = new UnitOriginResolver({
      readWorkspaceFile: async () => lock,
      rootTemplatePin: () => null,
      isBootstrapRepository: async (repoPath) => repoPath === "apps/shell",
      hostBuildVersion: () => "1.4.0",
      admittedOriginKeys: () => new Set(),
      onWarning: () => {},
    });

    await instance.originsFor(["extensions/acme-tools", "apps/shell"]);
    lock = "not valid template lock";
    const origins = await instance.originsFor(["extensions/acme-tools"]);

    expect(origins.get("extensions/acme-tools")?.originStatus).toBe("unresolved");
    expect(instance.originallyInstalledFrom("extensions/acme-tools")).toBeNull();
  });

  it("marks provenance unresolved when the lock cannot be read", async () => {
    const instance = new UnitOriginResolver({
      readWorkspaceFile: async () => {
        throw new Error("workspace read failed");
      },
      rootTemplatePin: () => ({ url: "https://github.com/other/root", ref: "v9", version: "v9" }),
      isBootstrapRepository: async () => true,
      hostBuildVersion: () => "1.4.0",
      admittedOriginKeys: () => new Set(),
      onWarning: () => {},
    });

    const origins = await instance.originsFor(["extensions/acme-tools"]);

    expect(origins.get("extensions/acme-tools")?.originStatus).toBe("unresolved");
  });

  it("carries the template's self-given name as a claim, never as identity", async () => {
    const origins = await resolver({
      lock: lockYaml({ "extensions/acme-tools": "" }, { name: "Acme Studio" }),
    }).originsFor(["extensions/acme-tools"]);

    const origin = origins.get("extensions/acme-tools")!;
    expect(origin.selfName).toBe("Acme Studio");
    expect(origin.originKey).toBe("github.com/acme");
    expect(origin.isHostBuild).toBe(false);
  });

  it("drops a self-given name that could impersonate another part of the surface", async () => {
    const origins = await resolver({
      lock: lockYaml(
        { "extensions/acme-tools": "" },
        { name: "Acme \u00B7 github.com/vibestudio" }
      ),
    }).originsFor(["extensions/acme-tools"]);

    expect(origins.get("extensions/acme-tools")!.selfName).toBeUndefined();
    expect(origins.get("extensions/acme-tools")!.originKey).toBe("github.com/acme");
  });

  it("keeps a removed template's parts attributed to it, because removal deletes nothing", async () => {
    // §U2/§7.7: severing the relationship drops the lock, and with it the only
    // live statement of who owns these repositories. The admission record is the
    // durable one, and it is what keeps `Originally installed from Acme Studio
    // v2.1` true for a part that is now the user's to manage.
    const origins = await resolver({
      lock: null,
      recorded: {
        "extensions/acme-tools": {
          url: ACME_LOCK_URL,
          version: "v2.1",
          selfName: "Acme Studio",
        },
      },
    }).originsFor(["extensions/acme-tools", "apps/shell"]);

    expect(origins.get("extensions/acme-tools")).toMatchObject({
      url: ACME_LOCK_URL,
      originKey: "github.com/acme",
      version: "v2.1",
      selfName: "Acme Studio",
      isHostBuild: false,
    });
    // A repository no record ever claimed is still ours; the fallback did not
    // become the default.
    expect(origins.get("apps/shell")!.isHostBuild).toBe(true);
  });

  it("prefers a live lock over the recorded source, so a re-install re-attributes", async () => {
    const origins = await resolver({
      lock: lockYaml({ "extensions/acme-tools": "" }),
      recorded: {
        "extensions/acme-tools": { url: "https://github.com/stale/source", version: "v0.1" },
      },
    }).originsFor(["extensions/acme-tools"]);

    expect(origins.get("extensions/acme-tools")!.originKey).toBe("github.com/acme");
  });

  it("marks a first encounter only for a source the user has not run before", async () => {
    const lock = lockYaml({ "extensions/acme-tools": "" });
    const unfamiliar = await resolver({ lock }).originsFor(["extensions/acme-tools"]);
    expect(unfamiliar.get("extensions/acme-tools")!.firstEncounter).toBe(true);

    const familiar = await resolver({
      lock,
      admitted: new Set(["github.com/acme"]),
    }).originsFor(["extensions/acme-tools"]);
    expect(familiar.get("extensions/acme-tools")!.firstEncounter).toBe(false);
  });

  it("answers the admission store from what the review already resolved", async () => {
    const instance = resolver({ lock: lockYaml({ "extensions/acme-tools": "" }) });
    // Nothing has been resolved yet, so nothing is claimed.
    expect(instance.recordedOriginFor("extensions/acme-tools")).toBeNull();

    await instance.originsFor(["extensions/acme-tools", "apps/shell"]);

    // The ref and the name ride along, because after a removal the lock that
    // holds them is gone and the record is the only place they can be read.
    expect(instance.recordedOriginFor("extensions/acme-tools")).toEqual({
      originKey: "github.com/acme",
      url: ACME_LOCK_URL,
      version: "v2.1",
      isWorkspaceRoot: true,
    });
    expect(instance.recordedOriginFor("apps/shell")).toEqual({
      originKey: "vibestudio",
      url: null,
      version: "1.4.0",
      isWorkspaceRoot: true,
    });
  });

  it("records the owning template's self-given name, so a removal can still print it", async () => {
    const instance = resolver({
      lock: lockYaml({ "extensions/acme-tools": "" }, { name: "News" }),
    });
    await instance.originsFor(["extensions/acme-tools"]);

    expect(instance.recordedOriginFor("extensions/acme-tools")).toEqual({
      originKey: "github.com/acme",
      url: ACME_LOCK_URL,
      version: "v2.1",
      selfName: "News",
      isWorkspaceRoot: true,
    });
  });
});

describe("where a part was originally installed from", () => {
  it("says nothing while a live template still owns the repository", async () => {
    const instance = resolver({
      lock: lockYaml({ "extensions/acme-tools": "" }, { name: "News" }),
      recorded: {
        "extensions/acme-tools": { url: ACME_LOCK_URL, version: "v1.2.0", selfName: "News" },
      },
    });
    await instance.refresh();

    // Current ownership is a present-tense fact the card already shows; adding
    // a history line for a live relationship would say it is also a past one.
    expect(instance.originallyInstalledFrom("extensions/acme-tools")).toBeNull();
  });

  it("keeps a removed template's parts attributed to it, by name and version", async () => {
    // The lock no longer claims the repository: the template was removed, which
    // severs the relationship and deletes nothing (§U2).
    const instance = resolver({
      lock: lockYaml({ "apps/shell": "" }),
      recorded: {
        // The ref exactly as it was recorded — rendered verbatim, never
        // reformatted, and never a commit.
        "extensions/acme-tools": { url: ACME_LOCK_URL, version: "1.2.0", selfName: "News" },
      },
    });
    await instance.refresh();

    expect(instance.originallyInstalledFrom("extensions/acme-tools")).toBe("News 1.2.0");
    // And the origin line itself still names the source rather than re-attributing
    // the part to the host's own build.
    const origins = await instance.originsFor(["extensions/acme-tools"]);
    expect(origins.get("extensions/acme-tools")!.isHostBuild).toBe(false);
  });

  it("falls back to the URL stem when a template never named itself", async () => {
    const instance = resolver({
      lock: lockYaml({ "apps/shell": "" }),
      recorded: { "extensions/acme-tools": { url: ACME_LOCK_URL, version: "v1.2.0" } },
    });
    await instance.refresh();

    expect(instance.originallyInstalledFrom("extensions/acme-tools")).toBe("studio v1.2.0");
  });

  it("says nothing for a part with no recorded source", async () => {
    const instance = resolver({ lock: lockYaml({ "apps/shell": "" }) });
    await instance.refresh();

    expect(instance.originallyInstalledFrom("extensions/acme-tools")).toBeNull();
  });
});
