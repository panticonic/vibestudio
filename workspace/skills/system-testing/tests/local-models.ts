import { CONTENT_WORKSPACE_REPO_FIXTURE, type TestCase } from "../types.js";

export const localModelTests: TestCase[] = [
  {
    name: "local-model-download-and-task",
    description: "Prepare the bundled local model and use it for a real workspace task",
    category: "local-models",
    timeoutMs: 30 * 60_000,
    resources: ["profile:local-models"],
    workspaceRepoFixture: CONTENT_WORKSPACE_REPO_FIXTURE,
    authorityPolicy: {
      authority: [
        {
          ruleId: "run-bundled-local-model",
          capability: { kind: "exact", key: "internal-model-runtime.use" },
          resource: { kind: "exact", key: "local-models" },
          tier: "gated",
          decision: "once",
        },
      ],
    },
    prompt:
      "Please use the bundled local model—not your current one—to read the disposable project's README and tell me its heading.",
    validate: () => ({ passed: true }),
  },
];
