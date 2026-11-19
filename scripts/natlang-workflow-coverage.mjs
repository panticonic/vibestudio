import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const git = promisify(execFile);
const shared = "skills/vibestudio-workflows";
const operationName = (source) => path.posix.basename(source, ".nl");

async function trackedSources(checkout) {
  const { stdout } = await git(
    "git",
    ["-C", checkout, "ls-files", "-z", "--", "*.nl", "*SKILL.md"],
    {
      maxBuffer: 8 * 1024 * 1024,
    }
  );
  return stdout.split("\0").filter(Boolean);
}

/** Index source relationships. A nearby document or task does not establish behavior coverage. */
export async function inspectWorkflowCoverage(checkouts, cases) {
  const manifest = JSON.parse(
    await readFile(path.join(checkouts.base, shared, "natlang.json"), "utf8")
  );
  const filesByTemplate = await Promise.all(
    Object.entries(checkouts).map(async ([template, checkout]) => ({
      template,
      files: await trackedSources(checkout),
    }))
  );
  const mounts = [
    { domain: "", directory: shared + "/runWorkflow" },
    ...Object.entries(manifest.workspaceModules ?? {})
      .filter(([selector]) => selector.startsWith("runWorkflow/domains/"))
      .map(([selector, directory]) => ({
        domain: selector.slice("runWorkflow/domains/".length),
        directory,
      })),
  ];
  const callables = [];
  const skillDocs = [];
  for (const { template, files } of filesByTemplate) {
    for (const source of files) {
      if (path.posix.basename(source) === "SKILL.md") {
        skillDocs.push({ template, source });
      } else if (source.endsWith(".nl")) {
        for (const { domain, directory } of mounts) {
          if (path.posix.dirname(source) !== directory) continue;
          const name = operationName(source);
          callables.push({
            template,
            source,
            name,
            callable: domain ? domain + "/" + name : name,
            managedCases: 0,
            scopedCases: 0,
          });
        }
      }
    }
  }

  const unresolved = new Map();
  for (const scenario of cases) {
    const scoped = scenario.execution === "scoped-fixture";
    const requested = scoped
      ? (scenario.request?.work ?? []).map((work) =>
          work.kind === "domain" ? work.domain + "/" + work.operation : work.kind
        )
      : scenario.operations;
    if (!requested?.length) {
      unresolved.set(scenario.id, {
        selector: null,
        execution: scenario.execution,
        cases: 1,
        candidates: [],
      });
      continue;
    }
    for (const selector of new Set(requested)) {
      // A managed declaration records the captured operation's name. Require
      // a unique source before attributing its cases to a mounted callable.
      const matches = callables.filter((entry) =>
        scoped ? entry.callable === selector : entry.name === selector
      );
      if (matches.length === 1) {
        matches[0][scoped ? "scopedCases" : "managedCases"]++;
      } else {
        const key = JSON.stringify([scenario.execution, selector]);
        const previous = unresolved.get(key);
        if (previous) previous.cases++;
        else
          unresolved.set(key, {
            selector,
            execution: scenario.execution,
            cases: 1,
            candidates: matches.map(({ template, source, callable }) => ({
              template,
              source,
              callable,
            })),
          });
      }
    }
  }
  const skills = skillDocs.map(({ template, source }) => {
    const directory = path.posix.dirname(source) + "/";
    const localSources = filesByTemplate.find((item) => item.template === template).files;
    return {
      template,
      source,
      localProgramFiles: localSources.filter(
        (file) => file.startsWith(directory) && file.endsWith(".nl")
      ).length,
      mountedCallables: callables
        .filter((entry) => entry.template === template && entry.source.startsWith(directory))
        .map(({ callable }) => callable),
    };
  });
  return {
    scope: "Tracked sources in configured template checkouts and declared task assignments",
    skills,
    callables,
    unresolved: [...unresolved.values()],
  };
}
