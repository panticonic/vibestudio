import { describe, expect, it } from "vitest";
import { resourceScopeContains } from "@vibestudio/shared/authorization";
import { workspaceFileResource } from "@vibestudio/shared/authority/workspaceFiles";
import { workspaceFileSelection, workspaceFileSelections } from "./workspaceFileAuthority.js";

const selection = (path: string, effect: "read" | "write" | "list" = "read") =>
  workspaceFileSelection({ path, effect, kind: "file" });

describe("repository file consent", () => {
  it("shares one read prompt across files, nested folders, and metadata in a repository", () => {
    const accesses = workspaceFileSelections([
      { path: "projects/demo/a.txt", effect: "read", kind: "file" },
      { path: "projects/demo/src/b.txt", effect: "read", kind: "file" },
      { path: "projects/demo/src", effect: "list", kind: "folder" },
    ]);
    expect(accesses).toHaveLength(1);
    expect(accesses[0]).toMatchObject({
      capability: "filesystem.read",
      resource: { kind: "prefix", prefix: "workspace-path/projects/demo/" },
      challenge: {
        resource: { label: "Repository", value: "/projects/demo/" },
        description:
          "Shares contents of all files in this repository with the website and agents it starts.",
      },
    });
    expect(selection("projects/demo/new/subfolder/file.txt").resource).toEqual(
      accesses[0]!.resource
    );
  });

  it("keeps repositories, read access, and write access distinct", () => {
    const read = selection("projects/demo/a.txt");
    const write = selection("projects/demo/b.txt", "write");
    expect(read.capability).toBe("filesystem.read");
    expect(write.capability).toBe("filesystem.write");
    expect(read.resource).toEqual(write.resource);
    for (const path of ["projects/other/a.txt", "projects/demo-copy/a.txt", "meta/config.json"]) {
      expect(resourceScopeContains(read.resource!, selection(path).resource!)).toBe(false);
    }
    expect(
      workspaceFileSelections([
        { path: "projects/demo/a.txt", effect: "read", kind: "file" },
        { path: "projects/other/b.txt", effect: "read", kind: "file" },
      ])
    ).toHaveLength(2);
  });

  it("uses the shared taxonomy for flat and newly created repositories", () => {
    expect(selection("meta/config.json").resource).toEqual({
      kind: "prefix",
      prefix: "workspace-path/meta/",
    });
    expect(selection("apps/new-app/src/index.ts", "write").resource).toEqual({
      kind: "prefix",
      prefix: "workspace-path/apps/new-app/",
    });
  });

  it("keeps workspace discovery separate and execution paths exact", () => {
    expect(workspaceFileSelection({ path: "", effect: "list", kind: "folder" })).toMatchObject({
      capability: "filesystem.list",
      resource: { kind: "prefix", prefix: "workspace-path/" },
    });
    // A broader approval must not broaden the prepared disk path binding.
    expect(workspaceFileResource({ path: "projects/demo/a.txt", kind: "file" })).toEqual({
      kind: "exact",
      key: "workspace-path/projects/demo/a.txt",
    });
  });
});
