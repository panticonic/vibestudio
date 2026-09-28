import { defineConfig } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import base from "./playwright.config";

/** Explicit provider-backed acceptance. Reuses the native E2E lifecycle,
 * artifacts and cleanup, but never runs as part of the hermetic desktop suite. */
export default defineConfig({
  ...base,
  testDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../live-e2e"),
  retries: 0,
});
