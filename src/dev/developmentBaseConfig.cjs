const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const DEVELOPMENT_BASE_GIT_CONFIG_KEY = "vibestudio.baseCheckout";

function git(repoRoot, args) {
  return execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function configuredDevelopmentBaseCheckout(repoRoot, env = process.env) {
  const environment = env.VIBESTUDIO_USERLAND_ROOT?.trim();
  if (environment) return canonicalCheckout(environment);
  let configured;
  try {
    configured = git(repoRoot, [
      "config",
      "--local",
      "--path",
      "--get",
      DEVELOPMENT_BASE_GIT_CONFIG_KEY,
    ]);
  } catch (error) {
    if (error.status === 1) return undefined;
    throw error;
  }
  return configured ? canonicalCheckout(configured) : undefined;
}

function requireDevelopmentBaseCheckout(repoRoot, env = process.env) {
  const checkout = configuredDevelopmentBaseCheckout(repoRoot, env);
  if (!checkout) {
    throw new Error("No development Base checkout is configured. Run `pnpm dev:base setup`.");
  }
  return checkout;
}

function selectDevelopmentBaseCheckout(
  repoRoot,
  { explicitCheckout, productionBase = false, env = process.env } = {}
) {
  if (productionBase && explicitCheckout) {
    throw new Error("--production-base and --base-checkout are mutually exclusive");
  }
  if (productionBase) return undefined;
  return explicitCheckout
    ? canonicalCheckout(explicitCheckout)
    : configuredDevelopmentBaseCheckout(repoRoot, env);
}

function setDevelopmentBaseCheckout(repoRoot, checkout) {
  const canonical = canonicalCheckout(checkout);
  assertGitCheckout(canonical);
  git(repoRoot, ["config", "--local", DEVELOPMENT_BASE_GIT_CONFIG_KEY, canonical]);
  return canonical;
}

function clearDevelopmentBaseCheckout(repoRoot) {
  try {
    git(repoRoot, ["config", "--local", "--unset-all", DEVELOPMENT_BASE_GIT_CONFIG_KEY]);
  } catch (error) {
    if (error.status !== 5) throw error;
  }
}

function canonicalCheckout(checkout) {
  const resolved = path.resolve(checkout);
  try {
    return fs.realpathSync(resolved);
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`Base checkout does not exist: ${resolved}`);
    throw error;
  }
}

function assertGitCheckout(checkout) {
  let topLevel;
  try {
    topLevel = git(checkout, ["rev-parse", "--show-toplevel"]);
  } catch (error) {
    throw new Error(`Configured Base path is not a Git checkout: ${checkout}`, { cause: error });
  }
  if (fs.realpathSync(topLevel) !== checkout) {
    throw new Error(`Configured Base path must be the checkout root: ${checkout}`);
  }
}

function developmentBaseHead(checkout) {
  return {
    commit: git(checkout, ["rev-parse", "HEAD"]),
    dirty: git(checkout, ["status", "--porcelain"]).length > 0,
  };
}

module.exports = {
  DEVELOPMENT_BASE_GIT_CONFIG_KEY,
  configuredDevelopmentBaseCheckout,
  requireDevelopmentBaseCheckout,
  selectDevelopmentBaseCheckout,
  setDevelopmentBaseCheckout,
  clearDevelopmentBaseCheckout,
  canonicalCheckout,
  assertGitCheckout,
  developmentBaseHead,
};
