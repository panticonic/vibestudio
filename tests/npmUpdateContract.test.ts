import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { describe, expect, it } from "vitest";
import {
  NPM_DESKTOP_PACKAGE_NAME,
  NPM_UPDATE_CONTRACT_VERSION,
  NPM_UPDATE_REQUESTED_EXIT_CODE,
  readPrivateJson,
  validateUpdateRequest,
  writePrivateJsonAtomic,
} from "../scripts/npm-update-contract.mjs";

describe("npm update contract", () => {
  const request = {
    contractVersion: NPM_UPDATE_CONTRACT_VERSION,
    action: "install-update",
    packageName: NPM_DESKTOP_PACKAGE_NAME,
    nonce: "a".repeat(64),
    fromVersion: "1.0.0-beta.1",
    toVersion: "1.0.0",
    requestedAt: "2026-07-25T12:00:00.000Z",
  };

  it("uses a dedicated nonordinary exit status and validates exact requests", () => {
    expect(NPM_UPDATE_REQUESTED_EXIT_CODE).toBe(86);
    expect([0, 1]).not.toContain(NPM_UPDATE_REQUESTED_EXIT_CODE);
    expect(validateUpdateRequest(request)).toEqual(request);
    expect(validateUpdateRequest({ ...request, nonce: "foreign" })).toBeNull();
    expect(validateUpdateRequest({ ...request, toVersion: "latest" })).toBeNull();
    expect(validateUpdateRequest({ ...request, extra: "rejected" })).toBeNull();
  });

  it("writes a complete private file atomically", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-contract-test-"));
    const target = path.join(directory, "request.json");
    writePrivateJsonAtomic(target, request);
    expect(readPrivateJson(target, validateUpdateRequest)).toEqual(request);
    if (process.platform !== "win32") {
      expect(fs.statSync(target).mode & 0o077).toBe(0);
    }
    expect(fs.readdirSync(directory)).toEqual(["request.json"]);
    fs.rmSync(directory, { recursive: true, force: true });
  });
});
