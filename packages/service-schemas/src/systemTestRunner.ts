import { createReceiverRpcMethods } from "@vibestudio/shared/rpcMethods";
import { evalRunStatusSchema } from "./eval.js";
import { z } from "zod";

const thinkingLevelSchema = z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]);

export const systemTestRunConfigSchema = z
  .object({
    runId: z.string().min(1),
    contextId: z.string().min(1),
    names: z.array(z.string()).optional(),
    category: z.string().optional(),
    all: z.boolean().optional(),
    model: z.string().optional(),
    thinkingLevel: thinkingLevelSchema.optional(),
    concurrency: z.number().int().positive().optional(),
    testTimeoutMs: z.number().int().positive().optional(),
  })
  .strict();
export type SystemTestRunConfig = z.infer<typeof systemTestRunConfigSchema>;

export const systemTestDescriptorSchema = z
  .object({
    explicitOnly: z.literal(true).optional(),
    name: z.string(),
    category: z.string(),
    description: z.string(),
    orchestrated: z.boolean(),
    requiresUnits: z.array(z.string()),
    installed: z.boolean().optional(),
  })
  .strict();
export type SystemTestDescriptor = z.infer<typeof systemTestDescriptorSchema>;

export const systemTestRunSummarySchema = z
  .object({
    runId: z.string(),
    status: z.enum(["running", "completed", "cancelled", "errored"]),
    error: z.string().optional(),
    total: z.number(),
    passed: z.number(),
    failed: z.number(),
    errored: z.number(),
    toolFailureCount: z.number(),
    testsWithToolFailures: z.number(),
    skipped: z.number(),
    notInstalled: z.array(
      z.object({ name: z.string(), missingUnits: z.array(z.string()) }).strict()
    ),
    durationMs: z.number(),
    failedTests: z.array(z.string()),
    testsWithUnexpectedToolFailures: z.array(z.string()),
  })
  .strict();
export type SystemTestRunSummary = z.infer<typeof systemTestRunSummarySchema>;

export const systemTestDoctorResultSchema = z
  .object({
    ok: z.boolean(),
    checks: z.array(
      z
        .object({
          name: z.string(),
          ok: z.boolean(),
          detail: z.string(),
          data: z.unknown().optional(),
        })
        .strict()
    ),
  })
  .strict();
export type SystemTestDoctorResult = z.infer<typeof systemTestDoctorResultSchema>;

export const systemTestRunCompletionSchema = z
  .object({ summary: systemTestRunSummarySchema })
  .strict();
export type SystemTestRunCompletion = z.infer<typeof systemTestRunCompletionSchema>;

export const systemTestRunStartResultSchema = z.object({ runId: z.string().min(1) }).strict();
export const systemTestRunReleaseResultSchema = z.object({ released: z.boolean() }).strict();

export const systemTestRunnerSnapshotSchema = z
  .object({
    status: evalRunStatusSchema.shape.status,
    progress: evalRunStatusSchema.shape.progress,
    result: z.object({ success: z.boolean(), error: z.string().optional() }).strict().optional(),
  })
  .strict();
export type SystemTestRunnerSnapshot = z.infer<typeof systemTestRunnerSnapshotSchema>;

export const systemTestTrajectoryPageSchema = z
  .object({
    length: z.number().int().nonnegative(),
    encoding: z.literal("plain-string"),
    chunk: z.string(),
  })
  .strict();
export type SystemTestTrajectoryPage = z.infer<typeof systemTestTrajectoryPageSchema>;

export interface SystemTestFailedRunConfig {
  contextId: string;
  names: string[];
  category?: string;
  all: boolean;
  model?: string;
  thinkingLevel?: SystemTestRunConfig["thinkingLevel"];
  modelPolicy?: unknown;
  concurrency: number;
  testTimeoutMs?: number;
}

export const systemTestFailedRunSchema = z
  .object({
    config: z
      .object({
        contextId: z.string(),
        names: z.array(z.string()),
        category: z.string().optional(),
        all: z.boolean(),
        model: z.string().optional(),
        thinkingLevel: thinkingLevelSchema.optional(),
        modelPolicy: z.unknown().optional(),
        concurrency: z.number().int().positive(),
        testTimeoutMs: z.number().int().positive().optional(),
      })
      .strict(),
    names: z.array(z.string()),
  })
  .strict();
export type SystemTestFailedRun = z.infer<typeof systemTestFailedRunSchema>;

export interface SystemTestRunnerRpc {
  doctor(model?: string): Promise<SystemTestDoctorResult>;
  listSystemTests(category?: string): Promise<SystemTestDescriptor[]>;
  startSystemTestRun(options: SystemTestRunConfig): Promise<{ runId: string }>;
  getSystemTestRunSnapshot(runId: string): Promise<SystemTestRunnerSnapshot>;
  getSystemTestRunResult(runId: string): Promise<SystemTestRunCompletion>;
  releaseSystemTestRunExecution(runId: string): Promise<{ released: boolean }>;
  cancelSystemTestRun(runId: string): Promise<SystemTestRunCompletion>;
  inspectSystemTestRun(runId: string, testName?: string): Promise<unknown>;
  readSystemTestTrajectoryPage(
    runId: string,
    testName: string,
    full: boolean,
    offset: number,
    limit: number
  ): Promise<SystemTestTrajectoryPage>;
  getFailedSystemTestRun(runId: string): Promise<SystemTestFailedRun>;
}

export type SystemTestRunnerClient = SystemTestRunnerRpc;

export const systemTestRunnerRpcMethods = createReceiverRpcMethods<SystemTestRunnerRpc>([
  "doctor",
  "listSystemTests",
  "startSystemTestRun",
  "getSystemTestRunSnapshot",
  "getSystemTestRunResult",
  "releaseSystemTestRunExecution",
  "cancelSystemTestRun",
  "inspectSystemTestRun",
  "readSystemTestTrajectoryPage",
  "getFailedSystemTestRun",
]);
