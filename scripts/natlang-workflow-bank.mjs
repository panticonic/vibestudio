#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { requireDevelopmentTemplateCheckouts } from "../src/dev/developmentTemplateConfig.cjs";
import { loadLiveTeacherCases, workflowSourceGroups } from "./export-live-workflow-teacher.mjs";
import { hasScopedWorkflowAdapter } from "./scoped-workflow-adapters.mjs";
import { inspectWorkflowCoverage } from "./natlang-workflow-coverage.mjs";

const program = "skills/vibestudio-workflows/runWorkflow.nl";

const domains = [
  {
    domain: "mobileSystem",
    template: "system-testing",
    source: "skills/mobile-system-testing-fixtures/worlds.ts",
    exported: "mobileScenarioWorlds",
    operation: "runMobileScenario",
    identify: (world) => [
      world.id,
      [
        "vibestudio:system-testing:mobile-admission",
        "vibestudio:system-testing:android-verified-outcome",
      ],
    ],
  },
  {
    domain: "visualize",
    template: "base",
    source: "skills/visualization-fixtures/worlds.ts",
    exported: "presentationWorlds",
    operation: "preparePresentation",
    identify: (world) => [world.id, [world.sourceGroup]],
  },
  {
    domain: "templateCandidate",
    template: "base",
    source: "skills/template-candidate-fixtures/worlds.ts",
    exported: "templateCandidateWorlds",
    operation: "stageTemplateCandidate",
    identify: (world) => [world.id, [world.sourceGroup]],
  },
  {
    domain: "scratchHandoff",
    template: "base",
    source: "skills/scratch-handoff-fixtures/worlds.ts",
    exported: "scratchHandoffWorlds",
    operation: "assembleHandoff",
    identify: (world) => [
      world.id,
      [world.sourceGroup, "vibestudio:scratch-handoff:workspace-filesystem-evidence"],
    ],
  },
  {
    domain: "automationLifecycle",
    template: "base",
    source: "skills/automation-lifecycle-fixtures/worlds.ts",
    exported: "automationLifecycleWorlds",
    operation: "reconcileAutomation",
    identify: (world) => [
      world.id,
      [world.sourceGroup, "vibestudio:automation-lifecycle:missions-controller"],
    ],
  },
  {
    domain: "channelAgent",
    template: "base",
    source: "skills/channel-agent-membership-fixtures/worlds.ts",
    exported: "channelMembershipWorlds",
    operation: "manageChannelAgent",
    identify: (world) => [world.id, [world.sourceGroup]],
  },
  {
    domain: "localReviewer",
    template: "base",
    source: "skills/channel-agent-membership-fixtures/localReviewerWorlds.ts",
    exported: "localReviewerWorlds",
    identify: (world) => [world.id, world.sourceGroups],
  },
  {
    domain: "automation",
    template: "base",
    source: "skills/automation-workflow-fixtures/worlds.ts",
    exported: "automationWorlds",
    operation: "prepareAutomation",
    identify: (world) => [world.id, [world.sourceGroup]],
  },
  {
    domain: "google",
    template: "google-workspace",
    source: "skills/google-drive/drive-workflow-worlds.ts",
    exported: "googleWorkflowWorlds",
    operation: "guideGoogleWorkspace",
    identify: (world) => [
      `google-workspace-${world.id}`,
      [`vibestudio:google-workspace:${world.group}`],
    ],
  },
  {
    domain: "personal",
    template: "personal",
    source: "skills/personal-workflows-fixtures/worlds.ts",
    exported: "personalWorlds",
    operation: "runPersonalWorkflow",
    identify: (world) => [`personal-${world.id}`, world.sources],
    input: (world) => ({ goal: world.goal, work: world.work }),
  },
  {
    domain: "gmailReview",
    template: "google-workspace",
    source: "skills/gmail-workflow-review-fixtures/worlds.ts",
    exported: "gmailWorkflowWorlds",
    operation: "reviewGmailWorkflow",
    identify: (world) => [world.id, [world.sourceGroup]],
  },
  {
    domain: "publication",
    template: "base",
    source: "skills/publish-preflight-fixtures/worlds.ts",
    exported: "publicationWorlds",
    operation: "preflightPublication",
    identify: (world) => [
      world.id,
      [
        `vibestudio:publication:${world.group}`,
        "vibestudio:publication-preflight:portable-public-package",
      ],
    ],
    input: (world, source) => source.publicationRequest(world),
  },
  {
    domain: "combined",
    template: "system-testing",
    source: "skills/shared-workflow-fixtures/worlds.ts",
    exported: "sharedWorkflowWorlds",
    identify: (world) => [world.id, world.sourceGroups],
  },
  {
    domain: "system",
    template: "system",
    source: "skills/system-investigation-suite/worlds.ts",
    exported: "systemInvestigationWorlds",
    operation: "investigateSystem",
    identify: (world) => [world.id, [world.sourceGroup]],
  },
  {
    domain: "localModel",
    template: "system",
    source: "skills/local-model-task-fixtures/worlds.ts",
    exported: "localModelTaskWorlds",
    operation: "prepareLocalModel",
    identify: (world) => [world.id, [world.sourceGroup]],
  },
  {
    domain: "templates",
    template: "base",
    source: "skills/template-lifecycle-fixtures/worlds.ts",
    exported: "templateLifecycleWorlds",
    operation: "reviewTemplate",
    identify: (world) => [world.id, [world.sourceGroup]],
  },
  {
    domain: "problems",
    template: "base",
    source: "skills/problem-review-fixtures/worlds.ts",
    exported: "problemReviewWorlds",
    operation: "reviewProblem",
    identify: (world) => [world.id, [world.sourceGroup]],
  },
  {
    domain: "provenance",
    template: "base",
    source: "skills/provenance-review-fixtures/worlds.ts",
    exported: "provenanceReviewWorlds",
    operation: "reviewProvenance",
    identify: (world) => [world.id, [world.sourceGroup]],
  },
  {
    domain: "examples",
    template: "examples",
    source: "skills/examples-review-fixtures/worlds.ts",
    exported: "exampleWorlds",
    operation: "reviewExample",
    identify: (world) => [world.id, world.sourceGroups ?? [world.sourceGroup]],
  },
  {
    domain: "news",
    template: "news",
    source: "skills/news-workflow-fixtures/worlds.ts",
    exported: "newsWorlds",
    operation: "reviewNews",
    identify: (world) => [world.id, [world.sourceGroup]],
  },
  {
    domain: "spectrolite",
    template: "spectrolite",
    source: "skills/spectrolite-review-fixtures/worlds.ts",
    exported: "spectroliteWorlds",
    operation: "reviewSpectrolite",
    identify: (world) => [world.id, [world.sourceGroup]],
  },
  {
    domain: "testReview",
    template: "system-testing",
    source: "skills/system-test-review-fixtures/worlds.ts",
    exported: "systemTestReviewWorlds",
    operation: "reviewSystemTest",
    identify: (world) => [world.id, [world.sourceGroup]],
  },
  {
    domain: "deviceAndTerminal",
    template: "base",
    source: "skills/device-and-terminal-review-fixtures/worlds.ts",
    exported: "deviceAndTerminalWorlds",
    operation: "reviewDeviceAndTerminal",
    identify: (world) => [world.id, world.sourceGroups ?? [world.sourceGroup]],
  },
  {
    domain: "sessionTest",
    template: "system-testing",
    source: "skills/session-test-review-fixtures/worlds.ts",
    exported: "sessionTestReviewWorlds",
    operation: "reviewSessionTest",
    identify: (world) => [world.id, [world.sourceGroup]],
  },
  {
    domain: "research",
    template: "base",
    source: "skills/research-intake-fixtures/worlds.ts",
    exported: "researchIntakeWorlds",
    operation: "reviewResearchIntake",
    identify: (world) => [world.id, world.sourceGroups ?? [world.sourceGroup]],
  },
  {
    domain: "unitDesign",
    template: "base",
    source: "skills/workspace-unit-design-fixtures/worlds.ts",
    exported: "workspaceUnitDesignWorlds",
    operation: "reviewWorkspaceUnit",
    identify: (world) => [
      `unit-design-${world.id}`,
      (world.sourceGroups ?? [world.sourceGroup]).map((group) => `vibestudio:${group}`),
    ],
  },
  {
    domain: "runtimeEvidence",
    template: "base",
    source: "skills/runtime-evidence-review-fixtures/worlds.ts",
    exported: "runtimeEvidenceWorlds",
    operation: "reviewRuntimeEvidence",
    identify: (world) => [world.id, world.sourceGroups ?? [world.sourceGroup]],
  },
  {
    domain: "conversation",
    template: "base",
    source: "skills/conversation-evidence-review-fixtures/worlds.ts",
    exported: "conversationEvidenceWorlds",
    operation: "reviewConversation",
    identify: (world) => [world.id, world.sourceGroups ?? [world.sourceGroup]],
  },
  {
    domain: "mediaImport",
    template: "base",
    source: "skills/media-and-import-review-fixtures/worlds.ts",
    exported: "mediaImportWorlds",
    operation: "reviewMediaAndImport",
    identify: (world) => [world.id, world.sourceGroups ?? [world.sourceGroup]],
  },
  {
    domain: "pdfIntake",
    template: "base",
    source: "skills/pdf-intake-fixtures/worlds.ts",
    exported: "pdfIntakeWorlds",
    operation: "extractPdfEvidence",
    identify: (world) => [
      world.id,
      [world.sourceGroup, "vibestudio:pdf-intake:local-pdf-evidence"],
    ],
  },
  {
    domain: "personalFacility",
    template: "personal",
    source: "skills/personal-facility-review-fixtures/worlds.ts",
    exported: "personalFacilityWorlds",
    operation: "reviewPersonalFacility",
    identify: (world) => [world.id, world.sourceGroups ?? [world.sourceGroup]],
  },
];

async function loadAuthoredWorkflowBank(checkouts) {
  const live = await loadLiveTeacherCases(checkouts);
  const fixtureGroups = await Promise.all(
    domains.map(async (domain) => {
      const imported = await import(
        pathToFileURL(path.join(checkouts[domain.template], domain.source)).href
      );
      const module = imported.default ?? imported;
      return module[domain.exported].map((world) => {
        const [id, sourceGroups] = domain.identify(world);
        const input = domain.input?.(world, module) ?? world.request;
        if (
          !/^[a-z0-9-]+$/u.test(id) ||
          !sourceGroups.length ||
          !sourceGroups.every((group) => group.startsWith("vibestudio:")) ||
          !input?.goal?.trim()
        ) {
          throw new Error(`Invalid authored task identity or goal for ${id} from ${domain.source}`);
        }
        const scenario = {
          id,
          family: domain.domain,
          execution: "scoped-fixture",
          sourceGroups,
          template: domain.template,
          source: domain.source,
          program,
          request: domain.operation
            ? {
                goal: input.goal,
                work: [
                  { kind: "domain", domain: domain.domain, operation: domain.operation, input },
                ],
              }
            : input,
        };
        return { scenario, world };
      });
    })
  );
  const cases = [
    ...[...live].map(([id, workflow]) => ({
      scenario: {
        id,
        family: workflow.family,
        execution: "managed-workspace",
        workspace: workflow.workspace ?? "system",
        operations: workflow.skills ?? [workflow.root],
        sourceGroups: workflowSourceGroups(workflow),
        program,
      },
    })),
    ...fixtureGroups.flat(),
  ];
  if (new Set(cases.map(({ scenario }) => scenario.id)).size !== cases.length)
    throw new Error("Duplicate task ID in the Vibestudio workflow bank");
  return cases;
}

export async function loadWorkflowBank(checkouts) {
  return (await loadAuthoredWorkflowBank(checkouts)).map(({ scenario }) => scenario);
}

export async function loadAuthoredScopedWorkflow(checkouts, id) {
  const found = (await loadAuthoredWorkflowBank(checkouts)).find(
    ({ scenario }) => scenario.id === id
  );
  if (!found) throw new Error(`Unknown Vibestudio workflow case ${id}`);
  if (found.scenario.execution !== "scoped-fixture")
    throw new Error(`Case ${id} runs through the managed workspace runner`);
  // Each attempt owns its fixture state. No run may mutate the imported corpus.
  return structuredClone(found);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const raw = process.argv.slice(2);
  const { values } = parseArgs({
    args: raw[0] === "--" ? raw.slice(1) : raw,
    options: {
      summary: { type: "boolean" },
      coverage: { type: "boolean" },
      case: { type: "string" },
    },
  });
  if ([values.summary, values.coverage, values.case].filter(Boolean).length > 1)
    throw new Error("Choose --summary, --coverage, or --case ID");
  const { checkouts } = requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadWorkflowBank(checkouts);
  if (values.case) {
    const found = cases.find(({ id }) => id === values.case);
    if (!found) throw new Error(`Unknown Vibestudio workflow case ${values.case}`);
    console.log(JSON.stringify(found, null, 2));
  } else if (values.coverage) {
    console.log(JSON.stringify(await inspectWorkflowCoverage(checkouts, cases), null, 2));
  } else if (values.summary) {
    const counts = {};
    for (const { execution, family } of cases) {
      const key = `${execution}/${family}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    const scopedRunnable = cases.filter(
      (item) => item.execution === "scoped-fixture" && hasScopedWorkflowAdapter(item.family)
    ).length;
    const managedWorkspace = cases.filter(
      ({ execution }) => execution === "managed-workspace"
    ).length;
    console.log(
      JSON.stringify({ total: cases.length, managedWorkspace, scopedRunnable, counts }, null, 2)
    );
  } else {
    for (const scenario of cases) console.log(JSON.stringify(scenario));
  }
}
