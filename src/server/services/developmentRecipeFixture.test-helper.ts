import type { DevelopmentRecipe } from "@vibestudio/service-schemas/development";
import { canonicalJson } from "@vibestudio/content-addressing";
import { domainHash } from "@vibestudio/shared/execution/identity";

export function developmentRecipeFixture(
  platform: string,
  arch: string,
  target: DevelopmentRecipe["target"] = { kind: "build-only" }
): DevelopmentRecipe {
  const base: Omit<DevelopmentRecipe, "reviewDigest"> = {
    version: 1,
    recipeId: `test-${target.kind}`,
    label: "Exact development executor test fixture",
    target,
    executor: "node-pnpm",
    install: {
      lockfiles: ["pnpm-lock.yaml"],
      mode: "frozen",
      network: "approved-registry",
      registry: "https://registry.npmjs.org",
    },
    commands: [
      { id: "install-root", executable: "pnpm", args: ["install", "--frozen-lockfile"] },
      { id: "build-host", executable: "node", args: ["build.mjs"] },
    ],
    declaredEnvironment: { CI: "1", NODE_ENV: "production" },
    platform,
    arch,
  };
  return {
    ...base,
    reviewDigest: domainHash("vibestudio/development-recipe-review/v1", canonicalJson(base)),
  };
}
