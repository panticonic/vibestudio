import { mkdtempSync } from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitClient } from "@vibestudio/git";
import { DisposableGitRemoteManager } from "./disposableGitRemoteManager.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true })));
});

describe("DisposableGitRemoteManager", () => {
  it("serves a writable smart-HTTP remote and reports received commits", async () => {
    const statePath = mkdtempSync(path.join(os.tmpdir(), "vibestudio-disposable-git-"));
    roots.push(statePath);
    const manager = new DisposableGitRemoteManager(statePath);
    const remote = await manager.create({ name: "publish-check", branch: "main" });
    const source = path.join(statePath, "source");
    const http = {
      async request(request: {
        url: string;
        method?: string;
        headers?: Record<string, string>;
        body?: Uint8Array | AsyncIterable<Uint8Array>;
      }) {
        const chunks: Uint8Array[] = [];
        if (request.body instanceof Uint8Array) chunks.push(request.body);
        else if (request.body) for await (const chunk of request.body) chunks.push(chunk);
        const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
        const body = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          body.set(chunk, offset);
          offset += chunk.byteLength;
        }
        const response = await manager.handle({
          url: request.url,
          method: request.method ?? "GET",
          ...(request.headers ? { headers: request.headers } : {}),
          ...(body.byteLength ? { body } : {}),
        });
        return {
          url: response.url,
          method: response.method,
          statusCode: response.statusCode,
          statusMessage: response.statusMessage,
          headers: response.headers,
          body: (async function* () {
            yield response.body;
          })(),
        };
      },
    };
    const git = new GitClient(fsp, {
      http,
      author: { name: "System Test", email: "system-test@vibestudio.local" },
    });
    await fsp.mkdir(source, { recursive: true });
    await git.init(source, "main");
    await fsp.writeFile(path.join(source, "README.md"), "disposable remote\n");
    await git.add(source, "README.md");
    const commit = await git.commit({ dir: source, message: "Initial commit" });
    await git.push({ dir: source, url: remote.url, ref: "main", remoteRef: "main" });

    await expect(manager.inspect(remote.url)).resolves.toMatchObject({
      branch: "main",
      commitCount: 1,
      headCommit: commit,
    });
    await expect(manager.remove(remote.url)).resolves.toEqual({ removed: true });
    await expect(manager.inspect(remote.url)).rejects.toThrow(/does not exist/);
  });

  it("expires and collects stale remotes", async () => {
    const statePath = mkdtempSync(path.join(os.tmpdir(), "vibestudio-disposable-git-"));
    roots.push(statePath);
    const manager = new DisposableGitRemoteManager(statePath);
    const remote = await manager.create({ ttlMs: 1_000 });
    await manager.cleanupExpired(remote.expiresAt + 1);
    await expect(manager.inspect(remote.url)).rejects.toThrow(/does not exist/);
  });
});
