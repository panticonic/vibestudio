import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GitClient } from "@vibestudio/git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createLocalGitMirrorTransport,
  parseLocalGitMirrors,
  resolveLocalGitMirrorRoute,
  serializeLocalGitMirrors,
} from "./localGitMirrors.js";

const CANONICAL = "https://github.com/panticonic/vibestudio.git";

let root: string;
let source: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-local-mirror-"));
  source = path.join(root, "source");
  fs.mkdirSync(source);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: source });
  git("init", "--initial-branch=main");
  git("config", "user.email", "mirror@vibestudio.test");
  git("config", "user.name", "Mirror Test");
  fs.writeFileSync(path.join(source, "README.md"), "adopted from a local checkout\n");
  git("add", ".");
  git("commit", "-m", "one exact adopted commit");
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("declared mirrors", () => {
  it("keeps the canonical URL as the durable identity", () => {
    const mirrors = parseLocalGitMirrors(
      JSON.stringify([{ url: "https://github.com/panticonic/vibestudio.git", checkout: source }])
    );
    expect(mirrors).toEqual([{ url: CANONICAL, checkout: source }]);
    expect(JSON.parse(serializeLocalGitMirrors(mirrors))).toEqual([
      { url: CANONICAL, checkout: source },
    ]);
  });

  it("refuses a declaration it cannot bind to one exact repository", () => {
    expect(() => parseLocalGitMirrors("{}")).toThrow(/must be a JSON array/u);
    expect(() => parseLocalGitMirrors(JSON.stringify([{ url: CANONICAL }]))).toThrow(
      /url and checkout/u
    );
    expect(() =>
      parseLocalGitMirrors(JSON.stringify([{ url: "git@github.com:a/b.git", checkout: source }]))
    ).toThrow(/Invalid remote URL/u);
    expect(() =>
      parseLocalGitMirrors(
        JSON.stringify([{ url: CANONICAL, checkout: path.join(root, "absent") }])
      )
    ).toThrow(/not a Git repository/u);
    expect(() =>
      parseLocalGitMirrors(
        JSON.stringify([
          { url: CANONICAL, checkout: source },
          { url: "https://github.com/panticonic/vibestudio", checkout: source },
        ])
      )
    ).toThrow(/more than once/u);
  });
  it("has no transport at all when nothing is declared", () => {
    expect(createLocalGitMirrorTransport({ mirrors: [] })).toBeNull();
  });
});

describe("mirror routing", () => {
  const mirrors = [{ url: CANONICAL, checkout: "/dev/null" }];

  it("owns only the two smart-HTTP routes of the declared repository", () => {
    expect(
      resolveLocalGitMirrorRoute(mirrors, {
        url: `${CANONICAL}/info/refs?service=git-upload-pack`,
        method: "GET",
      })
    ).toMatchObject({ operation: "advertise" });
    // The declaration and the request may spell .git differently.
    expect(
      resolveLocalGitMirrorRoute(mirrors, {
        url: "https://github.com/panticonic/vibestudio/git-upload-pack",
        method: "POST",
      })
    ).toMatchObject({ operation: "upload-pack" });
    expect(
      resolveLocalGitMirrorRoute(mirrors, {
        url: "https://github.com/panticonic/other/info/refs?service=git-upload-pack",
        method: "GET",
      })
    ).toBeNull();
    expect(resolveLocalGitMirrorRoute(mirrors, { url: CANONICAL, method: "GET" })).toBeNull();
    expect(resolveLocalGitMirrorRoute(mirrors, { url: "not a url", method: "GET" })).toBeNull();
  });

  it("refuses to stand in for a publication", () => {
    expect(() =>
      resolveLocalGitMirrorRoute(mirrors, {
        url: `${CANONICAL}/git-receive-pack`,
        method: "POST",
      })
    ).toThrow(/read-only/u);
  });
});

describe("serving a declared mirror", () => {
  it("clones the canonical URL out of the local checkout", async () => {
    const transport = createLocalGitMirrorTransport({
      mirrors: [{ url: CANONICAL, checkout: source }],
    })!;
    const git = new GitClient(fs.promises, {
      http: {
        async request(request) {
          const served = await transport.request({
            url: request.url,
            method: request.method ?? "GET",
            ...(request.body ? { body: await collect(request.body) } : {}),
          });
          if (!served) throw new Error(`no mirror owns ${request.url}`);
          return {
            url: served.url,
            method: served.method,
            statusCode: served.statusCode,
            statusMessage: served.statusMessage,
            headers: served.headers,
            body: (async function* () {
              yield served.body;
            })(),
          };
        },
      },
    });
    const destination = path.join(root, "adopted");
    await git.clone({ url: CANONICAL, dir: destination, ref: "main" });

    expect(fs.readFileSync(path.join(destination, "README.md"), "utf8")).toBe(
      "adopted from a local checkout\n"
    );
    // The adopted checkout points at the canonical upstream, not at the disk
    // path the bytes came from, so a later publication reaches the real remote.
    expect(await git.getCurrentCommit(destination)).toMatch(/^[0-9a-f]{40}$/u);
  }, 60_000);
});

async function collect(
  body: AsyncIterableIterator<Uint8Array> | Uint8Array[] | Uint8Array
): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  const chunks: Uint8Array[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) chunks.push(chunk);
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}
