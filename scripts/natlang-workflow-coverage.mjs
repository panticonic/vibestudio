import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fromMarkdown } from "mdast-util-from-markdown";
import { parse as parseYaml } from "yaml";

const git = promisify(execFile);
const shared = "skills/vibestudio-workflows";
const operationName = (source) => path.posix.basename(source, ".nl");
const sourceKey = (template, source) => JSON.stringify([template, source]);
const callableFile = (file) =>
  file.endsWith(".nl") || (file.endsWith(".ts") &&
    !file.endsWith(".d.ts") && !file.endsWith(".d.nl.ts") &&
    path.posix.basename(file) !== "types.ts");

function githubRepository(remote) {
  return /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/iu.exec(remote?.replace(/^git\+/u, ""))?.[1].toLowerCase();
}

function linkedPrograms(markdown, source, template, templateByRepository) {
  const links = new Set();
  const nodes = [fromMarkdown(markdown)];
  while (nodes.length) {
    const node = nodes.pop();
    if (node.children) nodes.push(...node.children);
    if (node.type !== "link") continue;
    const destination = node.url.split(/[?#]/u, 1)[0];
    if (!destination.endsWith(".nl")) continue;
    const remoteLink = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/blob\/main\/(.+)$/u.exec(destination);
    if (remoteLink) {
      const owner = templateByRepository.get(remoteLink[1].toLowerCase());
      if (owner) links.add(JSON.stringify([owner, remoteLink[2]]));
    } else if (!destination.startsWith("/") && !destination.includes(":")) {
      links.add(JSON.stringify([template, path.posix.join(path.posix.dirname(source), destination)]));
    }
  }
  return links;
}

async function trackedSources(checkout) {
  const { stdout } = await git(
    "git",
    ["-C", checkout, "ls-files", "-z", "--", "*.nl", "*.ts", "*SKILL.md",
      ":(glob)**/natlang.json", ":(glob)**/package.json"],
    {
      maxBuffer: 8 * 1024 * 1024,
    }
  );
  return stdout.split("\0").filter(Boolean);
}

function declaredUses(text) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text)?.[1];
  if (!frontmatter) return [];
  const uses = /^uses:[^\r\n]*(?:\r?\n(?:[ \t]+|- +)[^\r\n]*)*/mu.exec(frontmatter)?.[0];
  if (!uses) return [];
  const items = parseYaml(uses).uses;
  return Array.isArray(items)
    ? items.filter((item) => typeof item === "string" &&
        /^[A-Za-z_$][\w$]*(?:\/[A-Za-z_$][\w$]*)*$/u.test(item))
    : [];
}

/** Follow authored callable visibility, before any model chooses which calls to make. */
async function indexMountedScopes(checkout, files, mount) {
  const root = mount.packageRoot ?? mount.directory;
  const manifestPath = root + "/natlang.json";
  const tracked = new Set(files);
  const manifest = tracked.has(manifestPath)
    ? JSON.parse(await readFile(path.join(checkout, manifestPath), "utf8"))
    : {};
  const include = mount.packageRoot ? null : manifest.include;
  const programFiles = files.filter((file) => {
    if (!callableFile(file) || !file.startsWith(root + "/")) return false;
    const local = file.slice(root.length + 1);
    return !local.split("/").some((segment) => segment.startsWith(".") || segment === "node_modules") &&
      (!Array.isArray(include) || include.some((prefix) => local === prefix || local.startsWith(prefix + "/")));
  });
  const installed = new Set(programFiles);
  const resolve = (stem) => [stem + ".nl", stem + ".ts"]
    .find((file) => installed.has(file));
  const edges = new Map(programFiles.map((file) => [file, new Set()]));
  for (const file of programFiles) {
    // Namespace folders introduce no executable level. A sibling callable with
    // a companion folder owns its children and their descendants.
    let folder = path.posix.dirname(file);
    while (folder !== root) {
      const parent = resolve(folder);
      if (parent) {
        edges.get(parent).add(file);
        break;
      }
      folder = path.posix.dirname(folder);
    }
  }
  const unresolvedUses = [];
  await Promise.all(programFiles.filter((file) => file.endsWith(".nl")).map(async (file) => {
    let packageRoot = path.posix.dirname(file);
    while (packageRoot !== root &&
      !tracked.has(packageRoot + "/natlang.json") &&
      !tracked.has(packageRoot + "/package.json")) {
      packageRoot = path.posix.dirname(packageRoot);
    }
    const text = await readFile(path.join(checkout, file), "utf8");
    for (const item of declaredUses(text)) {
      const target = resolve(path.posix.join(packageRoot, item));
      if (target) edges.get(file).add(target);
      else unresolvedUses.push({ source: file, item });
    }
  }));
  return { programFiles, edges, unresolvedUses };
}

function reachableFiles(source, edges) {
  const seen = new Set([source]);
  const pending = [source];
  while (pending.length) {
    const file = pending.pop();
    for (const next of edges.get(file) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      pending.push(next);
    }
  }
  seen.delete(source);
  return seen;
}

/** Longest declared path, including the entry. A cycle has no finite depth. */
function callableDepth(source, edges, depths, visiting = new Set()) {
  if (depths.has(source)) return depths.get(source);
  if (visiting.has(source)) return null;
  visiting.add(source);
  let depth = 1;
  for (const target of edges.get(source) ?? []) {
    const child = callableDepth(target, edges, depths, visiting);
    if (child === null) {
      depth = null;
      break;
    }
    depth = Math.max(depth, child + 1);
  }
  visiting.delete(source);
  depths.set(source, depth);
  return depth;
}

async function originRepository(checkout) {
  try {
    const { stdout } = await git("git", ["-C", checkout, "config", "--get", "remote.origin.url"]);
    return githubRepository(stdout.trim());
  } catch (error) {
    if (error.code === 1) return undefined;
    throw error;
  }
}

async function workspaceDependencies(checkouts, sources) {
  const byRepository = new Map(sources.map(({ id, url }) => [githubRepository(url), id]));
  byRepository.delete(undefined);
  const dependencies = new Map(await Promise.all(sources.map(async ({ id }) => {
    const manifest = parseYaml(
      await readFile(path.join(checkouts[id], "meta/vibestudio.yml"), "utf8")
    );
    return [id, (manifest.template?.dependencies ?? [])
      .map(({ url }) => byRepository.get(githubRepository(url)))
      .filter(Boolean)];
  })));
  // Development checkpoints declare the harness as a dependency of each consumer.
  for (const { id, role, consumers } of sources) {
    if (role !== "development") continue;
    for (const consumer of consumers) dependencies.get(consumer).push(id);
  }
  return dependencies;
}

/** Index source relationships. A nearby document or task does not establish behavior coverage. */
export async function inspectWorkflowCoverage(checkouts, cases, sources) {
  const dependencies = await workspaceDependencies(checkouts, sources);
  const workspaceSources = new Map();
  for (const { id } of sources) {
    const installed = new Set();
    const pending = [id];
    while (pending.length > 0) {
      const next = pending.pop();
      if (installed.has(next)) continue;
      installed.add(next);
      pending.push(...dependencies.get(next));
    }
    workspaceSources.set(id, installed);
  }
  const manifest = JSON.parse(
    await readFile(path.join(checkouts.base, shared, "natlang.json"), "utf8")
  );
  const filesByTemplate = await Promise.all(
    Object.entries(checkouts).map(async ([template, checkout]) => {
      const [files, repository] = await Promise.all([
        trackedSources(checkout),
        originRepository(checkout),
      ]);
      return { template, files, repository };
    })
  );
  const templateByRepository = new Map();
  for (const { template, repository } of filesByTemplate) {
    if (!repository) continue;
    templateByRepository.set(repository, templateByRepository.has(repository) ? null : template);
  }
  const mounts = [
    { domain: "", directory: shared + "/runWorkflow", packageRoot: shared },
    ...Object.entries(manifest.workspaceModules ?? {})
      .filter(([selector]) => selector.startsWith("runWorkflow/domains/"))
      .map(([selector, directory]) => ({
        domain: selector.slice("runWorkflow/domains/".length),
        directory,
      })),
  ];
  const callables = [];
  const nestedByCallable = new Map();
  const filesByCallable = new Map();
  const programSources = new Map();
  const unresolvedUses = new Map();
  const skillDocs = [];
  for (const { template, files } of filesByTemplate) {
    skillDocs.push(...files.filter((source) => path.posix.basename(source) === "SKILL.md")
      .map((source) => ({ template, source })));
    const mounted = [];
    const sourceOrder = new Map(files.map((source, index) => [source, index]));
    for (const mount of mounts) {
      const direct = files.filter((file) =>
        file.endsWith(".nl") && path.posix.dirname(file) === mount.directory
      );
      if (direct.length === 0) continue;
      const { programFiles, edges, unresolvedUses: missing } =
        await indexMountedScopes(checkouts[template], files, mount);
      for (const { source, item } of missing) {
        unresolvedUses.set(JSON.stringify([template, source, item]), { template, source, item });
      }
      for (const source of programFiles) {
        const key = sourceKey(template, source);
        const entry = programSources.get(key) ?? {
          template, source, kind: source.endsWith(".nl") ? "natlang" : "typescript",
          children: new Set(), managedReachableCases: 0, scopedReachableCases: 0,
        };
        for (const target of edges.get(source)) entry.children.add(target);
        programSources.set(key, entry);
      }
      const entries = new Map();
      const depths = new Map();
      for (const source of direct) {
        if (!programFiles.includes(source)) continue;
        const name = operationName(source);
        entries.set(source, {
          template, source, name,
          callable: mount.domain ? mount.domain + "/" + name : name,
          managedCases: 0, scopedCases: 0, nestedManagedCases: 0, nestedScopedCases: 0,
        });
      }
      for (const [source, entry] of entries) {
        const reachable = [...reachableFiles(source, edges)];
        const naturalLanguageFiles = 1 + reachable.filter((target) => target.endsWith(".nl")).length;
        entry.programShape = {
          naturalLanguageFiles,
          typeScriptModules: reachable.length + 1 - naturalLanguageFiles,
          maxCallableDepth: callableDepth(source, edges, depths),
        };
        mounted.push(entry);
        filesByCallable.set(entry, [source, ...reachable].map((file) => sourceKey(template, file)));
        nestedByCallable.set(entry, reachable
          .flatMap((target) => entries.has(target) ? [entries.get(target)] : []));
      }
    }
    // Preserve template source order even when several namespaces are mounted.
    callables.push(...mounted.sort((left, right) => sourceOrder.get(left.source) - sourceOrder.get(right.source)));
  }

  const unresolved = new Map();
  for (const scenario of cases) {
    const scoped = scenario.execution === "scoped-fixture";
    const workspace = scoped ? null : scenario.workspace;
    const installed = workspaceSources.get(workspace);
    const requested = scoped
      ? (scenario.request?.work ?? []).map((work) =>
          work.kind === "domain" ? work.domain + "/" + work.operation : work.kind
        )
      : scenario.operations;
    if (!requested?.length) {
      unresolved.set(scenario.id, {
        selector: null,
        execution: scenario.execution,
        workspace,
        cases: 1,
        candidates: [],
      });
      continue;
    }
    const directEntries = new Set();
    for (const selector of new Set(requested)) {
      // A managed declaration records the captured operation's name. Require
      // a unique source before attributing its cases to a mounted callable.
      const matches = callables.filter((entry) =>
        scoped ? entry.callable === selector :
          installed?.has(entry.template) && entry.name === selector
      );
      if (matches.length === 1) {
        directEntries.add(matches[0]);
      } else {
        const key = JSON.stringify([scenario.execution, workspace, selector]);
        const previous = unresolved.get(key);
        if (previous) previous.cases++;
        else
          unresolved.set(key, {
            selector,
            execution: scenario.execution,
            workspace,
            cases: 1,
            candidates: matches.map(({ template, source, callable }) => ({
              template,
              source,
              callable,
            })),
          });
      }
    }
    const nestedEntries = new Set([...directEntries].flatMap((entry) => nestedByCallable.get(entry)));
    const visibleSources = new Set([...directEntries].flatMap((entry) => filesByCallable.get(entry)));
    const orchestrator = sourceKey("base", shared + "/runWorkflow.nl");
    if (scenario.program === shared + "/runWorkflow.nl" && programSources.has(orchestrator))
      visibleSources.add(orchestrator);
    for (const key of visibleSources) {
      programSources.get(key)[scoped ? "scopedReachableCases" : "managedReachableCases"]++;
    }
    for (const entry of directEntries) {
      entry[scoped ? "scopedCases" : "managedCases"]++;
      nestedEntries.delete(entry);
    }
    for (const entry of nestedEntries) {
      entry[scoped ? "nestedScopedCases" : "nestedManagedCases"]++;
    }
  }
  const skills = await Promise.all(skillDocs.map(async ({ template, source }) => {
    const directory = path.posix.dirname(source) + "/";
    const localSources = filesByTemplate.find((item) => item.template === template).files;
    const explicitLinks = linkedPrograms(
      await readFile(path.join(checkouts[template], source), "utf8"),
      source,
      template,
      templateByRepository
    );
    return {
      template,
      source,
      localProgramFiles: localSources.filter(
        (file) => file.startsWith(directory) && file.endsWith(".nl")
      ).length,
      mountedCallables: callables
        .filter((entry) => entry.template === template && entry.source.startsWith(directory))
        .map(({ callable }) => callable),
      linkedCallables: callables
        .filter((entry) => explicitLinks.has(JSON.stringify([entry.template, entry.source])))
        .map(({ callable }) => callable),
    };
  }));
  return {
    scope: "Tracked host and template sources and declared task assignments, using each managed workspace's template dependencies",
    workspaceSources: Object.fromEntries(
      [...workspaceSources].map(([workspace, installed]) => [workspace, [...installed].sort()])
    ),
    skills,
    callables,
    programSources: [...programSources.values()]
      .sort((left, right) => left.template.localeCompare(right.template) || left.source.localeCompare(right.source))
      .map((entry) => ({ ...entry, children: [...entry.children].sort() })),
    programSourceScope: "Tracked candidates inside the mounted source roots. Case counts include the declared shared program and source files reachable from the assigned operations, without expanding the shared program's other operations.",
    unresolvedUses: [...unresolvedUses.values()].sort((left, right) =>
      left.template.localeCompare(right.template) ||
      left.source.localeCompare(right.source) || left.item.localeCompare(right.item)
    ),
    nestedScope: "Mounted Natlang callables reachable through tracked companion folders or uses declarations. Counts exclude direct assignments and do not attest execution.",
    unresolved: [...unresolved.values()],
  };
}
