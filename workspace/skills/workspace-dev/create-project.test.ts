import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const files = new Map<string, string | Uint8Array>();
  const dirs = new Set<string>();
  const edit = vi.fn();
  const commit = vi.fn();
  const push = vi.fn();
  return { files, dirs, edit, commit, push };
});

function normalize(p: string): string {
  return p.replace(/^\/+|\/+$/g, "").replace(/\/+/g, "/");
}

function addDir(p: string): void {
  const normalized = normalize(p);
  if (!normalized) return;
  const parts = normalized.split("/");
  for (let i = 1; i <= parts.length; i++) mocks.dirs.add(parts.slice(0, i).join("/"));
}

function addFile(p: string, content: string | Uint8Array): void {
  const normalized = normalize(p);
  const parent = normalized.split("/").slice(0, -1).join("/");
  addDir(parent);
  mocks.files.set(normalized, content);
}

vi.mock("@workspace/runtime", () => ({
  vcs: {
    edit: mocks.edit,
    commit: mocks.commit,
    push: mocks.push,
  },
  fs: {
    async exists(p: string): Promise<boolean> {
      const normalized = normalize(p);
      return mocks.files.has(normalized) || mocks.dirs.has(normalized);
    },
    async readdir(
      p: string,
      opts?: { withFileTypes?: boolean }
    ): Promise<string[] | Array<{ name: string; isDirectory(): boolean }>> {
      const normalized = normalize(p);
      const prefix = normalized ? `${normalized}/` : "";
      const names = new Map<string, boolean>();
      for (const file of mocks.files.keys()) {
        if (!file.startsWith(prefix)) continue;
        const rest = file.slice(prefix.length);
        const [name, ...tail] = rest.split("/");
        names.set(name!, tail.length > 0);
      }
      for (const dir of mocks.dirs) {
        if (!dir.startsWith(prefix) || dir === normalized) continue;
        const rest = dir.slice(prefix.length);
        const [name, ...tail] = rest.split("/");
        names.set(name!, tail.length > 0 || mocks.dirs.has(`${prefix}${name}`));
      }
      if (opts?.withFileTypes) {
        return [...names].map(([name, isDir]) => ({ name, isDirectory: () => isDir }));
      }
      return [...names.keys()];
    },
    async readFile(p: string, encoding?: string): Promise<string | Uint8Array> {
      const content = mocks.files.get(normalize(p));
      if (content === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      if (encoding && content instanceof Uint8Array) return new TextDecoder().decode(content);
      return content;
    },
    async mkdir(p: string): Promise<void> {
      addDir(p);
    },
    async writeFile(p: string, content: string | Uint8Array): Promise<void> {
      addFile(p, content);
    },
  },
}));

function resetRuntimeMocks(): void {
  mocks.files.clear();
  mocks.dirs.clear();
  mocks.edit.mockReset();
  mocks.commit.mockReset();
  mocks.push.mockReset();
  // edit → commit → push scaffold: `writeProjectFiles` records the create ops
  // as working edits, then commits and pushes the new repo. The edit mock
  // records each created file so assertions can inspect the projected content.
  mocks.edit.mockImplementation(
    async (input: {
      edits: Array<{
        kind: string;
        path: string;
        content?: { kind: "text"; text: string } | { kind: "bytes"; base64: string };
      }>;
    }) => {
      for (const edit of input.edits) {
        if ((edit.kind === "create" || edit.kind === "write") && edit.content) {
          const value =
            edit.content.kind === "text"
              ? edit.content.text
              : Uint8Array.from(atob(edit.content.base64), (c) => c.charCodeAt(0));
          addFile(edit.path, value);
        }
      }
      return {
        head: "ctx:test",
        stateHash: "state:test",
        committed: false as const,
        status: "uncommitted" as const,
        editSeq: 1,
        changedPaths: input.edits.map((edit) => edit.path),
      };
    }
  );
  mocks.commit.mockResolvedValue([
    {
      repoPath: "workers/new",
      head: "ctx:test",
      stateHash: "state:test",
      eventId: "e",
      headHash: "h",
      editCount: 1,
      status: "committed" as const,
      changedPaths: [],
    },
  ]);
  mocks.push.mockResolvedValue({ status: "pushed", repoPaths: ["workers/new"], reports: [] });
}

describe("createProject", () => {
  beforeEach(resetRuntimeMocks);

  it("scaffolds a plain project as a content repo under projects/", async () => {
    const { createProject } = await import("./create-project.js");

    const result = await createProject({
      projectType: "project",
      name: "scratch-notes",
      title: "Scratch Notes",
    });

    expect(result).toEqual({
      created: "projects/scratch-notes",
      files: ["README.md"],
    });
    expect(mocks.files.get("projects/scratch-notes/README.md")).toBe(
      "# Scratch Notes\n\nPlain workspace project.\n"
    );
    expect(mocks.files.has("projects/scratch-notes/package.json")).toBe(false);
    expect(mocks.commit).toHaveBeenCalledWith({
      message: "Scaffold project scratch-notes",
      repoPaths: ["projects/scratch-notes"],
    });
    expect(mocks.push).toHaveBeenCalledWith({ repoPaths: ["projects/scratch-notes"] });
  });

  it("rejects removed agent scaffolding", async () => {
    const { createProject } = await import("./create-project.js");

    await expect(createProject({ projectType: "agent", name: "helper" })).rejects.toThrow(
      /panel, package, skill, project, worker/
    );
    expect(mocks.edit).not.toHaveBeenCalled();
  });

  it("declares the generated panel entry explicitly", async () => {
    const { createProject } = await import("./create-project.js");

    await createProject({ projectType: "panel", name: "hello", title: "Hello" });

    expect(JSON.parse(mocks.files.get("panels/hello/package.json") as string)).toMatchObject({
      vibestudio: {
        title: "Hello",
        entry: "index.tsx",
        exposeModules: expect.arrayContaining([
          "react",
          "react/jsx-runtime",
          "@radix-ui/themes",
          "@workspace/react",
        ]),
      },
    });
  });

  it("rejects names and titles that would produce invalid generated source", async () => {
    const { createProject } = await import("./create-project.js");

    await expect(createProject({ projectType: "panel", name: "Bad Name" })).rejects.toThrow(
      /Project name/
    );
    await expect(
      createProject({ projectType: "panel", name: "valid-name", title: 'Broken " title' })
    ).rejects.toThrow(/Project title/);
    expect(mocks.edit).not.toHaveBeenCalled();
  });

  it("does not report a scaffold as published when the build gate rejects it", async () => {
    mocks.push.mockResolvedValueOnce({
      status: "build-failed",
      reports: [
        {
          repoPath: "panels/broken",
          unitName: "@workspace-panels/broken",
          kind: "panel",
          role: "pushed",
          required: true,
          status: "failed",
          builds: [
            {
              target: "runtime",
              diagnostics: [
                {
                  source: "esbuild",
                  severity: "error",
                  file: "panels/broken/index.tsx",
                  line: 3,
                  column: 7,
                  message: "Could not resolve import",
                },
              ],
            },
          ],
        },
      ],
    });
    const { createProject } = await import("./create-project.js");

    await expect(createProject({ projectType: "panel", name: "broken" })).rejects.toThrow(
      /not published to main.*panels\/broken\/index\.tsx:3:7 Could not resolve import/s
    );
  });
});

describe("forkProject", () => {
  beforeEach(resetRuntimeMocks);

  it("does not report a fork as committed when publication diverges", async () => {
    addFile(
      "packages/source/package.json",
      JSON.stringify({ name: "@workspace/source", exports: { ".": "./index.ts" } })
    );
    addFile("packages/source/index.ts", "export const source = true;\n");
    mocks.push.mockResolvedValueOnce({
      status: "diverged",
      divergences: [
        {
          repoPath: "packages/new",
          base: "base",
          mainTip: "main",
          upstreamCommits: [],
          mergeable: "clean",
        },
      ],
    });
    const { forkProject } = await import("./create-project.js");

    await expect(forkProject({ from: "packages/source", to: "packages/new" })).rejects.toThrow(
      /not published because main diverged.*packages\/new/s
    );
  });

  it("rewrites a single-class worker fork and preserves binary files", async () => {
    addDir("workers/source/.git");
    addFile("workers/source/.gad/CHECKOUT.json", "{}");
    addFile("workers/source/.env", "SECRET=yes\n");
    addFile("workers/source/debug.log", "debug\n");
    addFile("workers/source/node_modules/pkg/index.js", "module.exports = {}\n");
    addFile(
      "workers/source/package.json",
      JSON.stringify({
        name: "@workspace-workers/source",
        vibestudio: {
          type: "worker",
          entry: "source-worker.ts",
          durable: { classes: [{ className: "SourceWorker" }] },
        },
      })
    );
    addFile(
      "workers/source/source-worker.ts",
      'export class SourceWorker { readonly source = "workers/source"; }\n'
    );
    addFile("workers/source/icon.png", new Uint8Array([1, 2, 3]));

    const { forkProject } = await import("./create-project.js");
    const result = await forkProject({
      from: "workers/source",
      to: "workers/new",
      title: "New Worker",
    });

    expect(result.committed).toBe(true);
    expect(result.files).toContain("new-worker.ts");
    // The fork wrote all files through one vcs.edit, then committed + pushed.
    expect(mocks.edit).toHaveBeenCalledTimes(1);
    expect(mocks.commit).toHaveBeenCalledTimes(1);
    expect(mocks.push).toHaveBeenCalledTimes(1);
    // The fork wrote its files through one edit-first GAD transition.
    expect(JSON.parse(mocks.files.get("workers/new/package.json") as string)).toMatchObject({
      name: "@workspace-workers/new",
      vibestudio: {
        title: "New Worker",
        entry: "new-worker.ts",
        durable: { classes: [{ className: "NewWorker" }] },
      },
    });
    expect(mocks.files.get("workers/new/new-worker.ts")).toContain("class NewWorker");
    expect(mocks.files.get("workers/new/new-worker.ts")).toContain("workers/new");
    expect(mocks.files.get("workers/new/icon.png")).toBeInstanceOf(Uint8Array);
    expect(result.files).not.toContain(".gad/CHECKOUT.json");
    expect(result.files).not.toContain(".env");
    expect(result.files).not.toContain("debug.log");
    expect(result.files).not.toContain("node_modules/pkg/index.js");
    expect(mocks.files.has("workers/new/.gad/CHECKOUT.json")).toBe(false);
    expect(mocks.files.has("workers/new/.env")).toBe(false);
    expect(mocks.files.has("workers/new/debug.log")).toBe(false);
    expect(mocks.files.has("workers/new/node_modules/pkg/index.js")).toBe(false);
  });
});
