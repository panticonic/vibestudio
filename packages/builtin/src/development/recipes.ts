import type { DevelopmentRecipe } from "@vibestudio/service-schemas/development";
import { canonicalJson } from "@vibestudio/shared/contentTree/canonicalJson";
import { domainHash } from "@vibestudio/shared/execution/identity";

function reviewedRecipe(
  platform: string,
  arch: string,
  recipe: Pick<DevelopmentRecipe, "recipeId" | "label" | "target">
): DevelopmentRecipe {
  const base: Omit<DevelopmentRecipe, "reviewDigest"> = {
    version: 1,
    ...recipe,
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

export function developmentRecipes(platform: string, arch: string): DevelopmentRecipe[] {
  return [
    reviewedRecipe(platform, arch, {
      recipeId: "vibestudio-monorepo-build-v1",
      label: "Build Vibestudio from exact semantic source",
      target: { kind: "build-only" },
    }),
    reviewedRecipe(platform, arch, {
      recipeId: "vibestudio-isolated-host-v1",
      label: "Build and start an isolated Vibestudio host",
      target: { kind: "isolated-host", includeClient: false },
    }),
    reviewedRecipe(platform, arch, {
      recipeId: "vibestudio-isolated-host-with-client-v1",
      label: "Build an isolated Vibestudio host and launch its client",
      target: { kind: "isolated-host", includeClient: true },
    }),
    reviewedRecipe(platform, arch, {
      recipeId: "vibestudio-current-host-client-v1",
      label: "Build and start an Electron client for the current host",
      target: { kind: "current-host-client", client: "electron" },
    }),
  ];
}
