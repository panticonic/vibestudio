const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const DEVELOPMENT_TEMPLATE_ROOT_GIT_CONFIG_KEY = "vibestudio.templateCheckouts";
const DEVELOPMENT_TEMPLATE_ROOT_ENV = "VIBESTUDIO_TEMPLATE_CHECKOUTS";
const TEMPLATE_NAMES = ["base", "personal", "system"];

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

function templateCheckouts(root) {
  const canonical = canonicalRoot(root);
  const checkouts = Object.fromEntries(
    TEMPLATE_NAMES.map((name) => {
      const checkout = path.join(canonical, name);
      assertGitCheckout(checkout, name);
      return [name, fs.realpathSync(checkout)];
    })
  );
  return { root: canonical, checkouts };
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
  if (!TEMPLATE_NAMES.includes(name)) throw new Error(`Unknown workspace template: ${name}`);
  return requireDevelopmentTemplateCheckouts(repoRoot, env).checkouts[name];
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
  return {
    commit: git(checkout, ["rev-parse", "HEAD"]),
    dirty: git(checkout, ["status", "--porcelain"]).length > 0,
  };
}

module.exports = {
  DEVELOPMENT_TEMPLATE_ROOT_GIT_CONFIG_KEY,
  DEVELOPMENT_TEMPLATE_ROOT_ENV,
  TEMPLATE_NAMES,
  configuredDevelopmentTemplateRoot,
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
