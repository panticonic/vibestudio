/**
 * Post a natlang evaluation result to a managed instance's natlang records service, through the instance's paired CLI
 * (`pnpm cli --instance ID agent call ...`): the service keeps the summary so the natlang panel's Evaluations page
 * shows the latest result per program with its gates.
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RECORDS_PROTOCOL = "vibestudio.natlang.v1";

/** The failure of recording on the instance: the evaluation ran and its result file exists, but the instance did not keep it. */
export class RecordingError extends Error {
  name = "RecordingError";
}

/**
 * The service's evaluation summary of a `vibestudio.natlang-eval/1` record: what ran, how it scored and whether the
 * gates passed, without the rollouts (which stay in the result file).
 */
export function evaluationSummary(record) {
  const { summary } = record;
  return {
    template: record.template,
    suite: record.suite,
    split: record.split,
    artifact: record.artifact ?? null,
    natlang: { commit: record.natlang.commit },
    executorIdentity: record.executorIdentity,
    summary: {
      quality: summary.quality ?? null,
      cases: summary.cases,
      gatesPassed: summary.gatesPassed,
      modelCalls: summary.modelCalls,
      meanLatencyMs: summary.meanLatencyMs ?? null,
    },
    cases: record.batch.results.map((result) => ({
      caseId: result.caseId,
      status: result.status,
      quality: result.quality ?? null,
    })),
    budget: record.budget,
  };
}

/** Run the repository's live CLI against one instance with `args`; the parsed JSON it printed. */
export function runInstanceCli(instance, args, { root = appRoot, execute = execFile } = {}) {
  return new Promise((resolve, reject) => {
    execute(
      process.execPath,
      ["--import", "tsx", "src/dev/runCli.ts", "--instance", instance, ...args, "--json"],
      {
        cwd: root,
        env: { ...process.env, VIBESTUDIO_SERVER_ENTRY: "live" },
        maxBuffer: 1 << 24,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new RecordingError(
              `pnpm cli --instance ${instance} ${args.slice(0, 2).join(" ")} failed: ${(stderr || stdout || error.message).trim()}`
            )
          );
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(
            new RecordingError(`the instance CLI printed no JSON for ${args[1]}: ${stdout.trim()}`)
          );
        }
      }
    );
  });
}

/**
 * The instance's records service, resolved now (so a mistyped or stopped instance fails before an evaluation runs):
 * `record(result)` keeps a result's summary and returns the stored evaluation's id.
 */
export async function openInstanceRecorder(instance, options = {}) {
  const run = (args) => runInstanceCli(instance, args, options);
  const service = await run([
    "agent",
    "call",
    "workers.resolveService",
    JSON.stringify([RECORDS_PROTOCOL]),
  ]);
  const targetId = service?.targetId ?? service?.result?.targetId;
  if (!targetId) {
    throw new RecordingError(
      `instance ${instance} has no ${RECORDS_PROTOCOL} service: ${JSON.stringify(service)}`
    );
  }
  return {
    async record(result) {
      const stored = await run([
        "agent",
        "call",
        "recordEvaluation",
        JSON.stringify([{ evaluation: evaluationSummary(result) }]),
        "--target",
        targetId,
      ]);
      const evaluationId = stored?.evaluationId ?? stored?.result?.evaluationId;
      if (!evaluationId) {
        throw new RecordingError(
          `instance ${instance} did not acknowledge the evaluation: ${JSON.stringify(stored)}`
        );
      }
      return evaluationId;
    },
  };
}
