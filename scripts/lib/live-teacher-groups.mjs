import { randomUUID } from "node:crypto";

export function groupLiveTeacherCases(scenarios, workflows, casesPerInstance) {
  const groups = new Map();
  for (const scenario of scenarios) {
    const { workspace = "system", workspaceBaseline } = workflows.get(scenario);
    const scope = workspaceBaseline ? `${workspace}@${workspaceBaseline}` : workspace;
    if (!groups.has(scope)) groups.set(scope, { workspace, workspaceBaseline, cases: [] });
    groups.get(scope).cases.push(scenario);
  }
  return [...groups.entries()].flatMap(([scope, { cases, ...context }]) => {
    const size = casesPerInstance || cases.length;
    const instances = [];
    for (let offset = 0; offset < cases.length; offset += size) {
      const key = cases.length > size ? `${scope}/batch-${instances.length + 1}` : scope;
      instances.push({
        ...context, key, instance: `natlang-live-${randomUUID().slice(0, 12)}`,
        cases: cases.slice(offset, offset + size),
      });
    }
    return instances;
  });
}
