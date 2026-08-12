import { defineConfig } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";
import { initializeE2eRun } from "../setup/e2eRun.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "../..");
const run = initializeE2eRun(projectRoot);

export default defineConfig({
  testDir: path.resolve(__dirname, "../e2e"),
  testMatch: "**/*.spec.ts",
  fullyParallel: false, // Electron tests run serially
  workers: 1, // Single worker for Electron
  timeout: 240000, // Electron cold-start builds can be slow for isolated workspaces
  retries: process.env.CI ? 2 : 0,
  forbidOnly: !!process.env.CI,
  globalSetup: path.resolve(__dirname, "playwright.globalSetup.ts"),

  reporter: [
    ["list"],
    ["html", { outputFolder: path.join(run.artifactRoot, "html"), open: "never" }],
    [
      "json",
      {
        outputFile: path.join(run.artifactRoot, "results.json"),
      },
    ],
    ...(process.env.CI ? [["github" as const]] : []),
  ],

  use: {
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: process.env.CI ? "on-first-retry" : "off",
  },

  expect: {
    timeout: 10000,
  },

  // Output directories
  outputDir: path.join(run.artifactRoot, "artifacts"),
});
