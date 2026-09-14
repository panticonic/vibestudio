const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { parse } = require("yaml");

const DEVELOPMENT_TEMPLATE_ROOT_GIT_CONFIG_KEY = "vibestudio.templateCheckouts";
const DEVELOPMENT_TEMPLATE_ROOT_ENV = "VIBESTUDIO_TEMPLATE_CHECKOUTS";
const DEFAULT_TEMPLATE_NAMES = ["base", "personal", "system"];
const TEMPLATE_REGISTRY_DIRECTORY = "registry";
const TEMPLATE_REGISTRY_URL = "https://github.com/panticonic/vibestudio-template-registry.git";

function git(repoRoot, args) {
  return execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function canonicalRoot(root) {
  const resolved = path.resolve(root);
  try {
    return fs.realpathSync(resolved);
  } catch (error) {
    if (error.code === "ENOENT")
      throw new Error(`Template checkout root does not exist: ${resolved}`);
    throw error;
  }
}

function assertGitCheckout(checkout, name = "template") {
  let topLevel;
  try {
    topLevel = git(checkout, ["rev-parse", "--show-toplevel"]);
  } catch (error) {
    throw new Error(`Configured ${name} path is not a Git checkout: ${checkout}`, { cause: error });
  }
  if (fs.realpathSync(topLevel) !== fs.realpathSync(checkout)) {
    throw new Error(`Configured ${name} path must be the checkout root: ${checkout}`);
  }
}

function canonicalRemoteUrl(value) {
  const remote = value.startsWith("git+") ? value.slice(4) : value;
  const scp = /^git@([^:]+):(.+)$/u.exec(remote);
  const ssh = /^ssh:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/u.exec(remote);
  const transport = scp
    ? `https://${scp[1]}/${scp[2]}`
    : ssh
      ? `https://${ssh[1]}/${ssh[2]}`
      : remote;
  const url = new URL(transport);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Template source URL must be HTTP(S): ${value}`);
  }
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/u, "");
  return `${url.protocol}//${url.host.toLowerCase()}${url.pathname}`;
}

function catalogEntry(value, expectedRole) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Template registry entries must be objects");
  }
  const { id, role, url } = value;
  if (typeof id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id)) {
    throw new Error(`Template registry entry has an invalid id: ${String(id)}`);
  }
  if (role !== expectedRole) {
    throw new Error(`Template registry entry ${id} must have role ${expectedRole}`);
  }
  if (typeof url !== "string") throw new Error(`Template registry entry ${id} has no URL`);
  const consumers = value.consumers;
  if (expectedRole === "development") {
    if (
      !Array.isArray(consumers) ||
      consumers.length === 0 ||
      consumers.some((consumer) => typeof consumer !== "string")
    ) {
      throw new Error(`Development template registry entry ${id} must declare its consumers`);
    }
  } else if (consumers !== undefined) {
    throw new Error(`Template registry entry ${id} may not declare development consumers`);
  }
  return {
    id,
    role,
    url: `git+${canonicalRemoteUrl(url)}`,
    ...(expectedRole === "development" ? { consumers: [...new Set(consumers)] } : {}),
  };
}

function readOfficialTemplateCatalog(root) {
  const registry = path.join(canonicalRoot(root), TEMPLATE_REGISTRY_DIRECTORY);
  assertGitCheckout(registry, "template registry");
  const document = parse(fs.readFileSync(path.join(registry, "registry.yml"), "utf8"));
  if (!document || document.version !== 1) {
    throw new Error("Template registry must use version 1");
  }
  const foundations = Array.isArray(document.foundations)
    ? document.foundations.map((entry) => catalogEntry(entry, entry?.role))
    : [];
  const byRole = new Map(foundations.map((entry) => [entry.role, entry]));
  for (const role of DEFAULT_TEMPLATE_NAMES) {
    if (!byRole.has(role)) throw new Error(`Template registry does not declare its ${role} source`);
  }
  if (foundations.some((entry) => !DEFAULT_TEMPLATE_NAMES.includes(entry.role))) {
    throw new Error("Template registry foundations may only declare base, personal, and system");
  }
  const optional = Array.isArray(document.entries)
    ? document.entries.map((entry) => catalogEntry({ ...entry, role: "optional" }, "optional"))
    : [];
  const development = Array.isArray(document.development)
    ? document.development.map((entry) => catalogEntry(entry, "development"))
    : [];
  const sources = [...foundations, ...development, ...optional];
  const ids = new Set();
  const urls = new Set();
  for (const source of sources) {
    if (ids.has(source.id)) throw new Error(`Template registry repeats id ${source.id}`);
    if (urls.has(source.url)) throw new Error(`Template registry repeats URL ${source.url}`);
    ids.add(source.id);
    urls.add(source.url);
  }
  for (const source of development) {
    for (const consumer of source.consumers) {
      if (!byRole.has(consumer)) {
        throw new Error(`Development template ${source.id} names unknown consumer ${consumer}`);
      }
    }
  }
  return { registry, sources };
}

function templateCheckouts(root) {
  const canonical = canonicalRoot(root);
  const catalog = readOfficialTemplateCatalog(canonical);
  const checkouts = Object.fromEntries(
    catalog.sources.map((source) => {
      const checkout = path.join(canonical, source.id);
      assertGitCheckout(checkout, source.id);
      const actualUrl = canonicalRemoteUrl(git(checkout, ["remote", "get-url", "origin"]));
      if (actualUrl !== canonicalRemoteUrl(source.url)) {
        throw new Error(
          `Configured ${source.id} checkout has origin ${actualUrl}; expected ${canonicalRemoteUrl(source.url)}`
        );
      }
      return [source.id, fs.realpathSync(checkout)];
    })
  );
  return { root: canonical, registry: catalog.registry, sources: catalog.sources, checkouts };
}

function configuredDevelopmentTemplateRoot(repoRoot, env = process.env) {
  const environment = env[DEVELOPMENT_TEMPLATE_ROOT_ENV]?.trim();
  if (environment) return canonicalRoot(environment);
  let configured;
  try {
    configured = git(repoRoot, [
      "config",
      "--local",
      "--path",
      "--get",
      DEVELOPMENT_TEMPLATE_ROOT_GIT_CONFIG_KEY,
    ]);
  } catch (error) {
    if (error.status === 1) return undefined;
    throw error;
  }
  return configured ? canonicalRoot(configured) : undefined;
}

function requireDevelopmentTemplateCheckouts(repoRoot, env = process.env) {
  const root = configuredDevelopmentTemplateRoot(repoRoot, env);
  if (!root) {
    throw new Error(
      "No development template checkouts are configured. Run `pnpm dev:templates setup`."
    );
  }
  return templateCheckouts(root);
}

function requireDevelopmentTemplateCheckout(repoRoot, name, env = process.env) {
  const selected = requireDevelopmentTemplateCheckouts(repoRoot, env);
  if (!selected.checkouts[name]) throw new Error(`Unknown workspace template: ${name}`);
  return selected.checkouts[name];
}

function selectDevelopmentTemplateCheckouts(
  repoRoot,
  { explicitRoot, productionTemplates = false, env = process.env } = {}
) {
  if (productionTemplates && explicitRoot) {
    throw new Error("--production-templates and --template-checkouts are mutually exclusive");
  }
  if (productionTemplates) return undefined;
  const root = explicitRoot
    ? canonicalRoot(explicitRoot)
    : configuredDevelopmentTemplateRoot(repoRoot, env);
  return root ? templateCheckouts(root) : undefined;
}

function setDevelopmentTemplateRoot(repoRoot, root) {
  const selected = templateCheckouts(root);
  git(repoRoot, ["config", "--local", DEVELOPMENT_TEMPLATE_ROOT_GIT_CONFIG_KEY, selected.root]);
  return selected;
}

function clearDevelopmentTemplateRoot(repoRoot) {
  try {
    git(repoRoot, ["config", "--local", "--unset-all", DEVELOPMENT_TEMPLATE_ROOT_GIT_CONFIG_KEY]);
  } catch (error) {
    if (error.status !== 5) throw error;
  }
}

function developmentTemplateHead(checkout) {
  const visibleChanges = git(checkout, ["status", "--porcelain=v1", "-z"])
    .split("\0")
    .filter(Boolean)
    .map((entry) => entry.slice(3))
    .filter((relativePath) => !relativePath.split(/[\\/]/u).includes("node_modules"));
  return {
    commit: git(checkout, ["rev-parse", "HEAD"]),
    dirty: visibleChanges.length > 0,
  };
}

module.exports = {
  DEVELOPMENT_TEMPLATE_ROOT_GIT_CONFIG_KEY,
  DEVELOPMENT_TEMPLATE_ROOT_ENV,
  DEFAULT_TEMPLATE_NAMES,
  TEMPLATE_REGISTRY_DIRECTORY,
  TEMPLATE_REGISTRY_URL,
  configuredDevelopmentTemplateRoot,
  readOfficialTemplateCatalog,
  requireDevelopmentTemplateCheckouts,
  requireDevelopmentTemplateCheckout,
  selectDevelopmentTemplateCheckouts,
  setDevelopmentTemplateRoot,
  clearDevelopmentTemplateRoot,
  templateCheckouts,
  canonicalRoot,
  assertGitCheckout,
  developmentTemplateHead,
};
