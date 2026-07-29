import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@vibestudio/content-addressing";
import { GitClient } from "@vibestudio/git";
import {
  acquireTemplateSnapshot,
  discoverDirectTemplatePin,
  missingTemplateCredential,
} from "./source.js";

const COMMIT = "d".repeat(40);
const roots: string[] = [];
const bytes = Buffer.from("export default 'template';\n");

function context() {
  return {
    credentials: {
      gitHttp: vi.fn(() => ({})),
      listStoredCredentials: vi.fn(async () => [
        {
          id: "credential-1",
          label: "github-main",
          lifecycle: { state: "active", canRefresh: false },
          bindings: [
            {
              id: "git-http",
              use: "git-http",
              audience: [{ url: "https://example.test/template-news.git", match: "path-prefix" }],
              injection: {
                type: "basic-auth",
                usernameTemplate: "git",
                passwordTemplate: "{token}",
              },
            },
          ],
          audience: [],
          injection: { type: "header", name: "authorization", valueTemplate: "Bearer {token}" },
          scopes: [],
        },
      ]),
    },
    rpc: {
      call: vi.fn(async (_target: string, method: string, value: string) => {
        if (method !== "blobstore.putBase64") throw new Error(`unexpected RPC ${method}`);
        const content = Buffer.from(value, "base64");
        return { digest: sha256Hex(content), size: content.byteLength };
      }),
    },
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(GitClient.prototype, "clone").mockResolvedValue();
  vi.spyOn(GitClient.prototype, "checkout").mockResolvedValue();
  vi.spyOn(GitClient.prototype, "getCurrentBranch").mockResolvedValue("main");
  vi.spyOn(GitClient.prototype, "getCurrentCommit").mockResolvedValue(COMMIT);
  vi.spyOn(GitClient.prototype, "statusMatrix").mockResolvedValue([
    ["panels/news/index.ts", 1, 1, 1],
  ]);
  vi.spyOn(GitClient.prototype, "readCommitTree").mockResolvedValue([
    {
      path: "panels/news/index.ts",
      type: "blob",
      mode: 0o100644,
      oid: "e".repeat(40),
      bytes,
    },
  ]);
});

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("template Git source acquisition", () => {
  it("returns a structured requirement when a named credential is unavailable", async () => {
    const ctx = context();
    ctx.credentials.listStoredCredentials.mockResolvedValue([]);

    await expect(
      missingTemplateCredential(ctx as never, {
        url: "git+https://example.test/private.git",
        credential: "work-git",
      })
    ).resolves.toMatchObject({
      requirement: {
        name: "work-git",
        remoteUrl: "https://example.test/private.git",
        provider: "example.test",
      },
      errorData: {
        code: "CredentialRequirementUnsatisfied",
        use: "git-http",
      },
    });
  });

  it("freezes a direct URL once, then reuses an immutable exact-coordinate cache", async () => {
    const statePath = await fsp.mkdtemp(path.join(os.tmpdir(), "template-source-"));
    roots.push(statePath);
    const ctx = context();
    const pin = await discoverDirectTemplatePin(ctx as never, statePath, {
      url: "https://example.test/template-news.git",
      credential: "github-main",
    });

    expect(pin).toEqual({
      url: "git+https://example.test/template-news.git",
      credential: "github-main",
      ref: "refs/heads/main",
      commit: COMMIT,
      snapshot: expect.stringMatching(/^v1-sha256:[0-9a-f]{64}$/u),
    });
    expect(ctx.credentials.gitHttp).toHaveBeenCalledWith({
      logicalCredential: {
        name: "github-main",
        remoteUrl: "https://example.test/template-news.git",
      },
    });
    expect(GitClient.prototype.clone).toHaveBeenCalledTimes(1);
    const discoveryRoot = path.join(statePath, "git-checkouts", "_template-discovery");
    expect(await fsp.readdir(discoveryRoot)).toEqual([]);

    const first = await acquireTemplateSnapshot(ctx as never, statePath, pin, "t-a1");
    const second = await acquireTemplateSnapshot(ctx as never, statePath, pin, "t-a1");
    expect(first.snapshot).toBe(pin.snapshot);
    expect(second.snapshot).toBe(pin.snapshot);
    expect(GitClient.prototype.clone).toHaveBeenCalledTimes(2);
    const cacheRoot = path.join(statePath, "git-checkouts", "_templates", "t-a1");
    expect(await fsp.readdir(cacheRoot)).toEqual([
      `${COMMIT}-${pin.snapshot.slice("v1-sha256:".length)}`,
    ]);
  });

  it("does not delete a published exact coordinate when verification fails", async () => {
    const statePath = await fsp.mkdtemp(path.join(os.tmpdir(), "template-source-"));
    roots.push(statePath);
    const ctx = context();
    const snapshot = `v1-sha256:${"a".repeat(64)}` as const;
    const checkout = path.join(
      statePath,
      "git-checkouts",
      "_templates",
      "t-a1",
      `${COMMIT}-${snapshot.slice("v1-sha256:".length)}`
    );
    await fsp.mkdir(checkout, { recursive: true });
    await fsp.writeFile(path.join(checkout, "sentinel"), "published");

    await expect(
      acquireTemplateSnapshot(
        ctx as never,
        statePath,
        {
          url: "git+https://example.test/template-news.git",
          ref: "refs/heads/main",
          commit: COMMIT,
          snapshot,
        },
        "t-a1"
      )
    ).rejects.toThrow("canonical snapshot mismatch");
    expect(await fsp.readFile(path.join(checkout, "sentinel"), "utf8")).toBe("published");
    expect(GitClient.prototype.clone).not.toHaveBeenCalled();
  });
});
