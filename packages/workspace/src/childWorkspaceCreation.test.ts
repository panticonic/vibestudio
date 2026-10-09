import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveOrCreateWorkspace } from "./loader.js";

const originalInstanceRoot = process.env["VIBESTUDIO_INSTANCE_ROOT"];
const tempRoots: string[] = [];

afterEach(() => {
  if (originalInstanceRoot === undefined) delete process.env["VIBESTUDIO_INSTANCE_ROOT"];
  else process.env["VIBESTUDIO_INSTANCE_ROOT"] = originalInstanceRoot;
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-startup-"));
  tempRoots.push(root);
  process.env["VIBESTUDIO_INSTANCE_ROOT"] = path.join(root, "instance");
  fs.mkdirSync(path.join(root, "build-resources"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "build-resources", "workspace-template-release.json"),
    JSON.stringify({
      format: "vibestudio-template-release/1",
      workspaceTemplates: {
        base: {
          url: "git+https://example.test/base.git",
          ref: "refs/tags/v1",
          commit: "a".repeat(40),
        },
        personal: {
          url: "git+https://example.test/personal.git",
          ref: "refs/tags/v1",
          commit: "b".repeat(40),
        },
        system: {
          url: "git+https://example.test/system.git",
          ref: "refs/tags/v1",
          commit: "c".repeat(40),
        },
      },
    })
  );
  const workspaceDir = (name: string) =>
    path.join(process.env["VIBESTUDIO_INSTANCE_ROOT"]!, "workspaces", name);
  return { root, workspaceDir };
}

describe("child workspace creation", () => {
  it("writes an explicitly selected development root into a fresh child descriptor", () => {
    const { root, workspaceDir } = setup();
    const candidate = {
      url: "git+https://example.test/base.git",
      ref: "refs/heads/candidate",
      commit: "c".repeat(40),
    };

    resolveOrCreateWorkspace({
      appRoot: root,
      name: "candidate-child",
      workspaceId: "ws_candidate",
      rootTemplate: candidate,
    });

    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(workspaceDir("candidate-child"), "state", "workspace-creation", "v1.json"),
          "utf8"
        )
      )
    ).toMatchObject({ workspaceId: "ws_candidate", rootTemplate: candidate });
  });

  it("uses the hub-owned identity when creating a child workspace disk", () => {
    const { root, workspaceDir } = setup();

    const result = resolveOrCreateWorkspace({
      appRoot: root,
      name: "dev-child",
      workspaceId: "ws_hub_owned",
    });

    expect(result.created).toBe(true);
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(workspaceDir("dev-child"), "state", "workspace-creation", "v1.json"),
          "utf8"
        )
      )
    ).toMatchObject({ workspaceId: "ws_hub_owned" });
  });
});
