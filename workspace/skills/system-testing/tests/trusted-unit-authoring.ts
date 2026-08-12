import {
  BUILDABLE_APP_WORKSPACE_REPO_FIXTURE,
  BUILDABLE_EXTENSION_WORKSPACE_REPO_FIXTURE,
  type TestAuthorityPolicy,
  type TestCase,
} from "../types.js";

const focusedVerificationAuthority: TestAuthorityPolicy = {
  authority: [
    {
      ruleId: "focused-workspace-test-execution",
      capability: {
        kind: "prefix",
        prefix: "userland:extensions/test-runner/native.tests.execute#",
      },
      resource: {
        kind: "exact",
        key: "native.tests:extension:@workspace-extensions/test-runner",
      },
      tier: "gated",
      decision: "once",
    },
  ],
};

export const trustedUnitAuthoringTests: TestCase[] = [
  {
    name: "extension-edit-test-build",
    description:
      "Repair a trusted extension through its documented edit, focused-test, and build workflow",
    category: "extensions",
    workspaceRepoFixture: BUILDABLE_EXTENSION_WORKSPACE_REPO_FIXTURE,
    authorityPolicy: focusedVerificationAuthority,
    prompt:
      'The disposable status extension keeps reporting "waiting" even though it is ready. Please fix it.',
    validate: () => ({ passed: true }),
  },
  {
    name: "app-edit-test-build",
    description:
      "Repair a trusted terminal app through its documented edit, focused-test, and build workflow",
    category: "apps",
    workspaceRepoFixture: BUILDABLE_APP_WORKSPACE_REPO_FIXTURE,
    authorityPolicy: focusedVerificationAuthority,
    prompt:
      'The disposable terminal app still prints "booting" after startup has completed. Please fix it.',
    validate: () => ({ passed: true }),
  },
];
