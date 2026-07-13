import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { waitForRootInvite } from "../scripts/cli/lib/smoke-remote-server.mjs";

const tempDirs: string[] = [];

async function readyFile(payload: unknown): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vibestudio-root-invite-"));
  tempDirs.push(dir);
  const file = path.join(dir, "ready.json");
  await fs.writeFile(file, JSON.stringify(payload));
  return file;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("smoke remote-server root invite selection", () => {
  it("selects the platform-specific invite from the ready-file contract", async () => {
    const ready = {
      rootInvites: {
        desktop: { pairUrl: "https://vibestudio.app/pair#desktop" },
        mobile: { pairUrl: "https://vibestudio.app/pair#mobile" },
      },
    };

    const file = await readyFile(ready);
    await expect(waitForRootInvite({ readyFile: file, kind: "desktop" })).resolves.toEqual(
      ready.rootInvites.desktop
    );
    await expect(waitForRootInvite({ readyFile: file, kind: "mobile" })).resolves.toEqual(
      ready.rootInvites.mobile
    );
  });

  it("fails when the root account already exists", async () => {
    const file = await readyFile({ rootInvites: null });
    await expect(waitForRootInvite({ readyFile: file, kind: "desktop" })).rejects.toThrow(
      "root account already exists"
    );
  });

  it("waits through atomic ready-file replacement gaps", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vibestudio-root-invite-"));
    tempDirs.push(dir);
    const file = path.join(dir, "ready.json");
    const pending = waitForRootInvite({ readyFile: file, kind: "desktop", timeoutMs: 2_000 });
    await fs.writeFile(
      file,
      JSON.stringify({ rootInvites: { desktop: { pairUrl: "https://vibestudio.app/pair#ready" } } })
    );
    await expect(pending).resolves.toEqual({ pairUrl: "https://vibestudio.app/pair#ready" });
  });

  it("rejects a malformed ready-file contract immediately", async () => {
    const file = await readyFile({ rootInvites: { desktop: { pairUrl: "" } } });
    await expect(waitForRootInvite({ readyFile: file, kind: "desktop" })).rejects.toThrow(
      "has no pairing URL"
    );
  });
});
