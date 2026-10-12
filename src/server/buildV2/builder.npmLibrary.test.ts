import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runIsolatedBuildJob } from "./nativeJobTestFixture.js";
import { buildNpmLibrary, type BuilderSession } from "./builder.js";
import { createBuilderTestSession } from "./builderTestSession.js";

describe("buildNpmLibrary", () => {
  let session: BuilderSession;
  let closeSession: () => Promise<void>;

  beforeAll(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-npm-library-validation-"));
    const context = await createBuilderTestSession({
      appRoot: process.cwd(),
      workspaceRoot: root,
      stateRoot: path.join(root, "state"),
      runNativeJob: runIsolatedBuildJob,
    });
    session = context.session;
    closeSession = async () => {
      await context.close();
      fs.rmSync(root, { recursive: true, force: true });
    };
  });

  afterAll(async () => closeSession?.());

  it("returns structured caller-correctable errors for invalid npm coordinates", async () => {
    await expect(
      buildNpmLibrary(session, "@missing-scope-only", "1.0.0", [])
    ).rejects.toMatchObject({
      code: "invalid_package_specifier",
      errorData: {
        code: "invalid_package_specifier",
        specifier: "@missing-scope-only",
      },
    });
    await expect(
      buildNpmLibrary(session, "example", "github:owner/repo", [])
    ).rejects.toMatchObject({
      code: "invalid_package_version",
      errorData: {
        code: "invalid_package_version",
        version: "github:owner/repo",
      },
    });
  });

  it("rejects test and build toolchains before npm install", async () => {
    await expect(buildNpmLibrary(session, "vitest", "^3.2.4", [])).rejects.toMatchObject({
      code: "unsupported_package",
      errorData: { code: "unsupported_package", specifier: "vitest" },
    });
    await expect(buildNpmLibrary(session, "@vitest/browser", "^3.2.4", [])).rejects.toThrow(
      "Unsupported npm package for panel eval: @vitest/browser"
    );
    await expect(buildNpmLibrary(session, "vite", "^7.3.1", [])).rejects.toThrow(
      "Unsupported npm package for panel eval: vite"
    );
    await expect(buildNpmLibrary(session, "esbuild", "^0.27.0", [])).rejects.toThrow(
      "Unsupported npm package for panel eval: esbuild"
    );
  });
});
