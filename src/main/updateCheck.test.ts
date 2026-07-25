import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventService } from "@vibestudio/shared/eventsService";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NPM_DESKTOP_PACKAGE_NAME,
  NPM_UPDATE_CONTRACT_VERSION,
  NPM_UPDATE_FILES,
  readPrivateJson,
  validateUpdateRequest,
  type UpdateLaunch,
} from "../../scripts/npm-update-contract.mjs";
import { createNpmUpdateController } from "./updateCheck.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function launch(canInstall: boolean, currentVersion = "1.0.0-beta.1"): UpdateLaunch {
  const requestDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-controller-"));
  directories.push(requestDirectory);
  return {
    contractVersion: NPM_UPDATE_CONTRACT_VERSION,
    packageName: NPM_DESKTOP_PACKAGE_NAME,
    packageRoot: "/global/lib/node_modules/@panticonic/vibestudio",
    globalRoot: "/global/lib/node_modules",
    globalPrefix: "/global",
    npmExecutable: "/usr/bin/npm",
    currentVersion,
    canInstall,
    ...(canInstall ? { requestDirectory, nonce: "a".repeat(64) } : {}),
  };
}

function registryResponse(version: string): Response {
  return new Response(JSON.stringify({ version }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("npm update controller", () => {
  it("uses full semver ordering, coalesces checks, and keeps one notification id", async () => {
    const eventService = new EventService();
    const emit = vi.spyOn(eventService, "emit");
    let resolveFetch!: (response: Response) => void;
    const fetchPromise = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const fetchImpl = vi.fn(() => fetchPromise) as unknown as typeof fetch;
    const controller = createNpmUpdateController({
      eventService,
      launch: launch(false),
      fetch: fetchImpl,
      ownsLocalHub: () => false,
      requestUpdateQuit: vi.fn(),
    })!;

    const first = controller.checkNow("resume");
    const second = controller.checkNow("network");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    resolveFetch(registryResponse("1.0.0"));
    await Promise.all([first, second]);

    expect(emit).toHaveBeenCalledWith(
      "notification:show",
      expect.objectContaining({
        id: "desktop-npm-update",
        title: "Vibestudio 1.0.0 is available",
        actions: [
          expect.objectContaining({
            command: { type: "desktop.copyNpmUpdateCommand" },
          }),
        ],
      })
    );
    controller.stop();
  });

  it("revalidates and writes the selected exact version before requesting quit", async () => {
    const eventService = new EventService();
    const updateLaunch = launch(true, "1.0.0");
    const requestUpdateQuit = vi.fn();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(registryResponse("1.2.0"))
      .mockResolvedValueOnce(registryResponse("1.2.0")) as unknown as typeof fetch;
    const controller = createNpmUpdateController({
      eventService,
      launch: updateLaunch,
      fetch: fetchImpl,
      ownsLocalHub: () => false,
      requestUpdateQuit,
    })!;

    await controller.checkNow("startup");
    await controller.requestInstall();

    const request = readPrivateJson(
      path.join(updateLaunch.requestDirectory!, NPM_UPDATE_FILES.request),
      validateUpdateRequest
    );
    expect(request).toMatchObject({
      fromVersion: "1.0.0",
      toVersion: "1.2.0",
      nonce: "a".repeat(64),
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "https://registry.npmjs.org/%40panticonic%2Fvibestudio/1.2.0",
      expect.objectContaining({
        headers: { accept: "application/vnd.npm.install-v1+json" },
      })
    );
    expect(requestUpdateQuit).toHaveBeenCalledWith("1.2.0");
  });

  it("does not exist without launcher-proven global metadata", () => {
    expect(
      createNpmUpdateController({
        eventService: new EventService(),
        launch: null,
        ownsLocalHub: () => false,
        requestUpdateQuit: vi.fn(),
      })
    ).toBeNull();
  });
});
