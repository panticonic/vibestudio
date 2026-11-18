#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { requireDevelopmentTemplateCheckouts } from "../src/dev/developmentTemplateConfig.cjs";
import { loadLiveTeacherCases, workflowSourceGroups } from "./export-live-workflow-teacher.mjs";

const program = "skills/vibestudio-workflows/runWorkflow.nl";

const domains = [
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
    domain: "publication",
    template: "base",
    source: "skills/publish-preflight-fixtures/worlds.ts",
    exported: "publicationWorlds",
    operation: "preflightPublication",
    identify: (world) => [world.id, [`vibestudio:publication:${world.group}`]],
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
];

export async function loadWorkflowBank(checkouts) {
  const live = await loadLiveTeacherCases(checkouts);
  const fixtureGroups = await Promise.all(
    domains.map(async (domain) => {
      const module = await import(
        pathToFileURL(path.join(checkouts[domain.template], domain.source)).href
      );
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
        return {
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
      });
    })
  );
  const cases = [
    ...[...live].map(([id, workflow]) => ({
      id,
      family: workflow.family,
      execution: "managed-workspace",
      sourceGroups: workflowSourceGroups(workflow),
      program,
    })),
    ...fixtureGroups.flat(),
  ];
  if (new Set(cases.map(({ id }) => id)).size !== cases.length)
    throw new Error("Duplicate task ID in the Vibestudio workflow bank");
  return cases;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const raw = process.argv.slice(2);
  const { values } = parseArgs({
    args: raw[0] === "--" ? raw.slice(1) : raw,
    options: { summary: { type: "boolean" }, case: { type: "string" } },
  });
  if (values.summary && values.case) throw new Error("Choose --summary or --case ID");
  const { checkouts } = requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadWorkflowBank(checkouts);
  if (values.case) {
    const found = cases.find(({ id }) => id === values.case);
    if (!found) throw new Error(`Unknown Vibestudio workflow case ${values.case}`);
    console.log(JSON.stringify(found, null, 2));
  } else if (values.summary) {
    const counts = {};
    for (const { execution, family } of cases) {
      const key = `${execution}/${family}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    console.log(JSON.stringify({ total: cases.length, counts }, null, 2));
  } else {
    for (const scenario of cases) console.log(JSON.stringify(scenario));
  }
}
