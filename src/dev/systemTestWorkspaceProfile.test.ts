import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  profileIsPaired,
  selectWorkspaceForRole,
  workspaceProfileRoot,
} from "./systemTestWorkspaceProfile.js";

const roots: string[] = [];

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-profile-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("scoped workspace profile", () => {
  const workspaces = [
    { workspaceId: "ws_system", name: "system-ws_system", privateRole: "system" },
    { workspaceId: "ws_personal", name: "personal-ws_personal", privateRole: "personal" },
    { workspaceId: "ws_dev", name: "dev" },
  ];

  it("selects the instance's system workspace by its role, not its name", () => {
    expect(selectWorkspaceForRole(workspaces, "system")).toMatchObject({
      workspaceId: "ws_system",
    });
  });

  it("refuses to guess when the instance does not have exactly one", () => {
    expect(() => selectWorkspaceForRole([], "system")).toThrow(/found 0/u);
    expect(() =>
      selectWorkspaceForRole(
        [...workspaces, { ...workspaces[0]!, workspaceId: "ws_other" }],
        "system"
      )
    ).toThrow(/found 2/u);
    // The instance's own profile is already the dev workspace.
    expect(() => selectWorkspaceForRole(workspaces, "dev")).toThrow(/no selection is needed/u);
  });

  it("keeps each role's profile in its own root under the instance", () => {
    const instance = temporaryRoot();
    expect(workspaceProfileRoot(instance, "system")).toBe(
      path.join(instance, "workspace-profiles", "system")
    );
    expect(workspaceProfileRoot(instance, "system")).not.toBe(instance);
  });

  it("re-pairs only when the profile is missing or bound elsewhere", () => {
    const root = temporaryRoot();
    expect(profileIsPaired(root, "ws_system")).toBe(false);
    fs.writeFileSync(
      path.join(root, "cli-credentials.json"),
      JSON.stringify({ workspaceId: "ws_system" })
    );
    expect(profileIsPaired(root, "ws_system")).toBe(true);
    // A recreated instance mints new workspace ids; the stale profile is not reused.
    expect(profileIsPaired(root, "ws_rebuilt")).toBe(false);
    fs.writeFileSync(path.join(root, "cli-credentials.json"), "{not json");
    expect(profileIsPaired(root, "ws_system")).toBe(false);
  });
});
