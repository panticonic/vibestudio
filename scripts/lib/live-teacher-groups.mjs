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
        ...context, scope, key, instance: `natlang-live-${randomUUID().slice(0, 12)}`,
        cases: cases.slice(offset, offset + size),
      });
    }
    return instances;
  });
}


export function terminalStartupFailure(stdout) {
  for (const line of stdout.trimEnd().split("\n").reverse()) {
    try {
      const report = JSON.parse(line);
      if (report?.error) return report.recoverable === false;
    } catch {
      // The launcher emits progress lines before the doctor report.
    }
  }
  return false;
}
