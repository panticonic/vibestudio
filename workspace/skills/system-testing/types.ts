import type { ChatMessage } from "@workspace/agentic-core";
import type { HeadlessSession, SessionSnapshot } from "@workspace/agentic-session";
import type { HeadlessRunner } from "./runner.js";

export interface ToolFailureSummary {
  id?: string;
  name: string;
  status?: string;
  terminalOutcome?: string;
  terminalReasonCode?: string;
  error?: string;
  resultSummary?: string;
  /** True when the test explicitly exercises this failure mode. */
  expected?: boolean;
  source: "message" | "snapshot";
}

export interface ExpectedToolFailure {
  name: string;
  /** Optional case-insensitive discriminator in the error/result text. */
  errorIncludes?: string;
}

export interface TestCase {
  name: string;
  description: string;
  category: string;
  /** Natural language task prompt sent to the test agent */
  prompt: string;
  /** Tool errors deliberately induced by this test, not infrastructure defects. */
  expectedToolFailures?: ExpectedToolFailure[];
  /**
   * Shared mutable platform resources this case uses. Cases with an
   * overlapping resource are serialized even when the suite has spare
   * concurrency; disjoint cases still run in parallel.
   */
  resources?: string[];
  /**
   * Give tests that create/publish workspace repos a harness-owned disposable
   * namespace. The runner removes stale repos in that namespace before the
   * test, removes repos created in it afterward, and surfaces any teardown
   * failure. This keeps the user-like prompt free of fixture mechanics.
   */
  workspaceRepoFixture?: boolean;
  /**
   * Optional custom orchestration for tests that need multiple independent
   * headless agents, ordered phases, or other harness-level setup that a single
   * agent should not fake from inside one context.
   */
  orchestrate?: (context: TestOrchestrationContext) => Promise<TestExecutionResult>;
  /** Validate the test execution result */
  validate: (result: TestExecutionResult) => TestResult;
}

export interface TestOrchestrationContext {
  runner: HeadlessRunner;
  /** Optional operator-supplied deadline; normal system tests are unbounded. */
  testTimeoutMs?: number;
  sendAndWait(session: HeadlessSession, prompt: string, phase: string): Promise<void>;
}

export interface TestExecutionResult {
  /** Stable identifiers for inspecting the spawned test trajectory after completion. */
  provenance?: {
    channelId: string | null;
    branchId: string | null;
    agentEntityId: string | null;
    agentTargetId: string | null;
    contextId: string | null;
  };
  /** Full conversation messages */
  messages: ChatMessage[];
  /** Wall-clock duration in ms */
  duration: number;
  /** Transport/session-level error (if the session itself failed) */
  error?: string;
  /** Cleanup errors from closing the headless session or retiring its agent */
  cleanupErrors?: string[];
  /** Full diagnostic snapshot from the session (invocations, debug events, participants) */
  snapshot?: SessionSnapshot;
  /** Journal-derived proof of provider/model requests and completed usage. */
  modelExecutionEvidence?: unknown;
  /** Runtime/GAD diagnostics collected automatically when a test errors. */
  diagnostics?: Record<string, unknown>;
  /** Non-fatal tool-call failures observed during the turn. */
  toolFailures?: ToolFailureSummary[];
}

export interface TestResult {
  passed: boolean;
  reason?: string;
  details?: Record<string, unknown>;
}

export interface TestSuiteResultEntry {
  test: { name: string; category: string; description: string; prompt: string };
  result: TestResult;
  execution: TestExecutionResult;
}

export interface TestSuiteResult {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  /** Total unexpected failed tool calls observed, independent from pass/fail status. */
  toolFailureCount?: number;
  /** Number of tests that observed at least one unexpected failed tool call. */
  testsWithToolFailures?: number;
  skipped: number;
  duration: number;
  results: TestSuiteResultEntry[];
}
