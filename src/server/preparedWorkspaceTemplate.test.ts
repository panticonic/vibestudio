import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@vibestudio/content-addressing";
import { blobCasPath } from "./storage/blobCas.js";
import * as blobCas from "./storage/blobCas.js";
import {
  installPreparedWorkspaceTemplate,
  prepareWorkspaceCompilationFingerprint,
  validatePreparedCompilationInput,
  type PreparedWorkspaceTemplate,
} from "./preparedWorkspaceTemplate.js";
import { readHostBuildFingerprint, resolveRequiredHostArtifactRoot } from "./appRoot.js";
import {
  computeRootDependencyFingerprint,
  captureRootDependencyFingerprint,
  buildCompilerProtocolIdentity,
} from "./buildV2/effectiveVersion.js";

const pin = {
  url: "git+https://github.com/example/template.git",
  commit: "a".repeat(40),
  ref: "refs/heads/main",
};
const bytes = Buffer.from("export default {};");
const digest = sha256Hex(bytes);
const record: PreparedWorkspaceTemplate = {
  format: "vibestudio-prepared-workspace/1",
  purpose: "use",
  pin,
  layers: [pin],
  installation: { sources: [{ pin, manifest: "template: {}" }] },
  snapshot: `v1-sha256:${"b".repeat(64)}`,
  stateHash: `state:${"c".repeat(64)}`,
  files: [
    { path: "workers/source/index.ts", contentHash: digest, size: bytes.length, mode: 0o644 },
  ],
  repositories: [],
  builds: [],
  blobs: [{ digest, size: bytes.length }],
};
let root: string;
let release: string;
let destination: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "prepared-workspace-test-"));
  release = path.join(root, "release");
  destination = path.join(root, "consumer");
  const source = blobCasPath(path.join(release, "blobs"), digest);
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, bytes);
  fs.writeFileSync(path.join(release, "template.json"), JSON.stringify(record));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("prepared workspace installation", () => {
  it("requires a canonical installation capture bound to the release before publication", async () => {
    const fingerprint = captureRootDependencyFingerprint(
      await computeRootDependencyFingerprint(root)
    );
    const input = {
      hostBuild: readHostBuildFingerprint(resolveRequiredHostArtifactRoot()),
      compilerProtocol: buildCompilerProtocolIdentity(),
      fingerprint,
    };
    const identity = { ...input, appDependencyFingerprint: fingerprint.value };
    expect(validatePreparedCompilationInput(input, identity)).toEqual(input);
    expect(() => validatePreparedCompilationInput(undefined, identity)).toThrow(
      /no compilation input/
    );
    expect(() =>
      validatePreparedCompilationInput(input, {
        ...identity,
        appDependencyFingerprint: "0".repeat(64),
      })
    ).toThrow(/release identity/);
    expect(() =>
      validatePreparedCompilationInput(input, {
        ...identity,
        hostBuild: { ...input.hostBuild, fingerprint: "0".repeat(64) },
      })
    ).toThrow(/release identity/);
    expect(() =>
      validatePreparedCompilationInput(input, {
        ...identity,
        compilerProtocol: { ...input.compilerProtocol, cacheVersion: "other" },
      })
    ).toThrow(/release identity/);
    expect(() =>
      validatePreparedCompilationInput(
        { ...input, fingerprint: { ...fingerprint, value: "0".repeat(64) } },
        identity
      )
    ).toThrow(/trace does not reproduce/);
    expect(() =>
      validatePreparedCompilationInput(
        {
          ...input,
          fingerprint: {
            ...fingerprint,
            policy: fingerprint.policy === "shared-host" ? "prepared" : "shared-host",
          },
        },
        identity
      )
    ).toThrow(/installation policy/);
  });
  it("joins all admitted blob links and retains their failures before returning ownership", async () => {
    const blobs = Array.from({ length: 18 }, (_, index) => ({
      digest: index.toString(16).padStart(64, "0"),
      size: 1,
    }));
    fs.writeFileSync(path.join(release, "template.json"), JSON.stringify({ ...record, blobs }));
    const failures = [new Error("first link failure"), new Error("second link failure")];
    const pending = new Map<string, { resolve(): void; reject(error: unknown): void }>();
    const link = vi
      .spyOn(blobCas, "linkReconstructableBlobFile")
      .mockImplementation((_root, digest) => {
        if (digest === blobs[0]!.digest) return Promise.reject(failures[0]);
        return new Promise<string>((resolve, reject) =>
          pending.set(digest, { resolve: () => resolve(path.join(destination, digest)), reject })
        );
      });
    let settled = false;
    const installation = installPreparedWorkspaceTemplate(release, destination, pin, "use").catch(
      (error: unknown) => {
        settled = true;
        return error;
      }
    );
    try {
      await vi.waitFor(() => expect(link).toHaveBeenCalledTimes(16));
      expect(settled).toBe(false);
      pending.get(blobs[1]!.digest)!.reject(failures[1]);
      for (let index = 2; index < 16; index++) pending.get(blobs[index]!.digest)!.resolve();
      expect(await installation).toMatchObject({ errors: failures });
      expect(link).toHaveBeenCalledTimes(16);
    } finally {
      link.mockRestore();
    }
  });

  it("reuses compilation inputs only within their exact host and compiler generation", async () => {
    fs.mkdirSync(destination, { recursive: true });
    const fingerprint = await computeRootDependencyFingerprint(root, destination);
    const compilationInput = {
      hostBuild: readHostBuildFingerprint(resolveRequiredHostArtifactRoot()),
      compilerProtocol: buildCompilerProtocolIdentity(),
      fingerprint: captureRootDependencyFingerprint(await computeRootDependencyFingerprint(root)),
    };
    expect(
      await prepareWorkspaceCompilationFingerprint(compilationInput, root, destination)
    ).toEqual(fingerprint);
    await expect(
      prepareWorkspaceCompilationFingerprint(
        {
          ...compilationInput,
          hostBuild: { ...compilationInput.hostBuild, fingerprint: "0".repeat(64) },
        },
        root,
        destination
      )
    ).rejects.toThrow(/different host or compiler generation/);
    await expect(
      prepareWorkspaceCompilationFingerprint(
        {
          ...compilationInput,
          compilerProtocol: { ...compilationInput.compilerProtocol, cacheVersion: "different" },
        },
        root,
        destination
      )
    ).rejects.toThrow(/different host or compiler generation/);
    fs.writeFileSync(path.join(destination, "package.json"), "{}");
    expect(
      await prepareWorkspaceCompilationFingerprint(compilationInput, root, destination)
    ).toEqual(await computeRootDependencyFingerprint(root, destination));
  });

  it("installs the published immutable closure by reference", async () => {
    expect(await installPreparedWorkspaceTemplate(release, destination, pin, "use")).toEqual(
      record
    );
    const installed = blobCasPath(destination, digest);
    expect(fs.readFileSync(installed)).toEqual(bytes);
    expect(fs.statSync(installed).ino).toBe(
      fs.statSync(blobCasPath(path.join(release, "blobs"), digest)).ino
    );
  });
  it("rejects a different template coordinate before writing consumer state", async () => {
    await expect(
      installPreparedWorkspaceTemplate(
        release,
        destination,
        { ...pin, commit: "d".repeat(40) },
        "use"
      )
    ).rejects.toThrow("creation coordinate");
    expect(fs.existsSync(destination)).toBe(false);
  });
  it("propagates missing release bytes", async () => {
    fs.unlinkSync(blobCasPath(path.join(release, "blobs"), digest));
    await expect(
      installPreparedWorkspaceTemplate(release, destination, pin, "use")
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects truncation before publishing the consumer CAS entry", async () => {
    fs.writeFileSync(blobCasPath(path.join(release, "blobs"), digest), "");
    await expect(
      installPreparedWorkspaceTemplate(release, destination, pin, "use")
    ).rejects.toThrow("size mismatch");
    expect(fs.existsSync(blobCasPath(destination, digest))).toBe(false);
  });
});
