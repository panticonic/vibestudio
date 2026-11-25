import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ prepare: vi.fn(), close: vi.fn(), stop: vi.fn(), root: "" }));
vi.mock("../setup/ownedTestRun.js", () => ({
  ownTestRun: async () => ({ root: mock.root, ownership: {}, close: mock.close }),
}));
vi.mock("../setup/ownedXvfb.js", () => ({
  startOwnedXvfb: async () => ({ display: ":owned", pid: 123, stop: mock.stop }),
}));
vi.mock("../setup/e2eRootTemplate.js", () => ({
  prepareE2eRootTemplate: mock.prepare,
  publishE2eRootTemplate: vi.fn(),
}));
import setup from "./playwright.globalSetup.js";
import {
  E2E_ARTIFACT_ROOT_ENV,
  E2E_CLEANUP_LEDGER_ENV,
  E2E_RUN_ID_ENV,
  E2E_TEMP_ROOT_ENV,
} from "../setup/e2eRun.js";
const original = Object.fromEntries(
  [E2E_ARTIFACT_ROOT_ENV, E2E_CLEANUP_LEDGER_ENV, E2E_RUN_ID_ENV, E2E_TEMP_ROOT_ENV].map((key) => [
    key,
    process.env[key],
  ])
);
const paths: string[] = [];
afterEach(() => {
  vi.resetAllMocks();
  for (const root of paths.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "global-setup-lifecycle-"));
  paths.push(base);
  mock.root = path.join(base, "scratch");
  fs.mkdirSync(mock.root);
  const artifacts = path.join(base, "artifacts");
  process.env[E2E_RUN_ID_ENV] = "owned-proof";
  process.env[E2E_ARTIFACT_ROOT_ENV] = artifacts;
  process.env[E2E_CLEANUP_LEDGER_ENV] = path.join(artifacts, "cleanup.jsonl");
  mock.prepare.mockResolvedValue({ pin: { commit: "exact-source" }, checkout: "owned-source" });
  mock.close.mockImplementation(async () => fs.rmSync(mock.root, { recursive: true, force: true }));
  return { base, artifacts };
}
it("retires the run even when display cleanup failed, preserving caller artifacts", async () => {
  const { artifacts } = fixture();
  const close = await setup();
  fs.writeFileSync(path.join(artifacts, "actual-failure.log"), "diagnostic");
  mock.stop.mockRejectedValue(new Error("display close failed"));
  await expect(close()).rejects.toThrow("E2E resources");
  expect(mock.close).toHaveBeenCalledOnce();
  expect(fs.existsSync(mock.root)).toBe(false);
  expect(fs.readFileSync(path.join(artifacts, "actual-failure.log"), "utf8")).toBe("diagnostic");
});
it("joins every resource when preparation and display cleanup both fail", async () => {
  fixture();
  mock.prepare.mockRejectedValue(new Error("source preparation failed"));
  mock.stop.mockRejectedValue(new Error("display close failed"));
  const error = await setup().catch((error) => error);
  expect(error).toBeInstanceOf(AggregateError);
  expect(error.errors[0].message).toBe("source preparation failed");
  expect(mock.stop).toHaveBeenCalledOnce();
  expect(mock.close).toHaveBeenCalledOnce();
  expect(fs.existsSync(mock.root)).toBe(false);
});
