import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeLaunchProfile } from "./profile.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Claude launch profile", () => {
  it("keeps the purpose credential in memory and writes only a private non-secret profile", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "claude-profile-"));
    roots.push(root);
    const pluginDir = path.join(root, "plugin");
    await mkdir(path.join(pluginDir, ".claude-plugin"), { recursive: true });
    await writeFile(path.join(pluginDir, ".claude-plugin", "plugin.json"), "{}\n");

    const written = await writeLaunchProfile({
      statePath: path.join(root, "state"),
      entityId: "entity-1",
      generationId: "agent-2",
      pluginDir,
      env: {
        VIBESTUDIO_SERVER_URL: "http://127.0.0.1:5000",
        VIBESTUDIO_AGENT_TOKEN: "agent:agent-2:super-secret",
        VIBESTUDIO_ENTITY_ID: "entity-1",
        VIBESTUDIO_CONTEXT_ID: "context-1",
        VIBESTUDIO_CHANNEL_ID: "channel-1",
        VIBESTUDIO_VESSEL_REF: "do:vessel",
        VIBESTUDIO_PLUGIN_DIR: pluginDir,
      },
    });

    expect(written.profileDir).toBe(
      path.join(root, "state", "agent-launch", "entity-1", "agent-2")
    );
    expect(written.env.VIBESTUDIO_AGENT_TOKEN).toBe("agent:agent-2:super-secret");
    const profilePath = path.join(written.profileDir, "profile.json");
    const persisted = await readFile(profilePath, "utf8");
    expect(persisted).not.toContain("super-secret");
    expect(persisted).not.toContain("VIBESTUDIO_AGENT_TOKEN");
    expect((await stat(profilePath)).mode & 0o777).toBe(0o600);
  });

  it("rejects path-shaped generation identities", async () => {
    await expect(
      writeLaunchProfile({
        statePath: "/tmp/state",
        entityId: "entity-1",
        generationId: "../escape",
        pluginDir: "/tmp/plugin",
        env: {} as never,
      })
    ).rejects.toThrow("not path-safe");
  });
});
