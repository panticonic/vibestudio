import crypto from "node:crypto";
import path from "node:path";

export const E2E_RUN_ID_ENV = "VIBESTUDIO_E2E_RUN_ID";
export const E2E_ARTIFACT_ROOT_ENV = "VIBESTUDIO_E2E_ARTIFACT_ROOT";
export const E2E_CLEANUP_LEDGER_ENV = "VIBESTUDIO_E2E_CLEANUP_LEDGER";
export const E2E_TEMP_ROOT_ENV = "VIBESTUDIO_E2E_TEMP_ROOT";

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;

export interface E2eRunPaths {
  runId: string;
  artifactRoot: string;
  cleanupLedgerPath: string;
}

export function createE2eRunId(
  now = new Date(),
  pid = process.pid,
  suffix = crypto.randomBytes(4).toString("hex")
): string {
  const timestamp = now.toISOString().replace(/[-:.]/g, "");
  return `${timestamp}-${pid}-${suffix}`;
}

export function validateE2eRunId(runId: string): string {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(
      `${E2E_RUN_ID_ENV} must be a 1-96 character path-safe identifier; received ${JSON.stringify(runId)}`
    );
  }
  return runId;
}

export function resolveE2eRunPaths(projectRoot: string, runId: string): E2eRunPaths {
  const validatedRunId = validateE2eRunId(runId);
  const artifactRoot = path.join(projectRoot, "test-results", "e2e", validatedRunId);
  return {
    runId: validatedRunId,
    artifactRoot,
    cleanupLedgerPath: path.join(artifactRoot, "cleanup-ledger.jsonl"),
  };
}

/**
 * Establish one run identity while Playwright evaluates its config. Worker
 * processes inherit these values, so reporters, fixtures, and teardown all
 * address the same namespace without a shared "latest" output path.
 */
export function initializeE2eRun(projectRoot: string): E2eRunPaths {
  const runId = validateE2eRunId(process.env[E2E_RUN_ID_ENV] ?? createE2eRunId());
  const paths = resolveE2eRunPaths(projectRoot, runId);
  process.env[E2E_RUN_ID_ENV] = runId;
  process.env[E2E_ARTIFACT_ROOT_ENV] = paths.artifactRoot;
  process.env[E2E_CLEANUP_LEDGER_ENV] = paths.cleanupLedgerPath;
  return paths;
}
