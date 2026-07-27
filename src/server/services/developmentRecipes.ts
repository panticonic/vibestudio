import { canonicalJson } from "@vibestudio/shared/contentTree/canonicalJson";
import { domainHash } from "@vibestudio/shared/execution/identity";
import type { DevelopmentRecipe } from "@vibestudio/service-schemas/development";

const reviewedRecipe = (
  platform: string,
  arch: string,
  recipe: Pick<DevelopmentRecipe, "recipeId" | "label" | "target">
): DevelopmentRecipe => {
  const base: Omit<DevelopmentRecipe, "reviewDigest"> = {
    version: 1 as const,
    ...recipe,
    executor: "node-pnpm" as const,
    install: {
      lockfiles: ["pnpm-lock.yaml", "workspace/pnpm-lock.yaml"],
      mode: "frozen" as const,
      network: "approved-registry" as const,
      registry: "https://registry.npmjs.org" as const,
    },
    commands: [
      {
        id: "install-root" as const,
        executable: "pnpm" as const,
        args: ["install", "--frozen-lockfile"],
      },
      {
        id: "install-workspace" as const,
        executable: "pnpm" as const,
        args: ["--dir", "workspace", "install", "--frozen-lockfile"],
      },
      {
        id: "build-host" as const,
        executable: "node" as const,
        args: ["build.mjs"],
      },
    ],
    declaredEnvironment: { CI: "1" as const, NODE_ENV: "production" as const },
    platform,
    arch,
  };
  return {
    ...base,
    reviewDigest: domainHash("vibestudio/development-recipe-review/v1", canonicalJson(base)),
  };
};

/** Product-reviewed recipes. Callers can choose ids and bounded options only. */
export class DevelopmentRecipeRegistry {
  private readonly recipes: readonly DevelopmentRecipe[];

  constructor(platform = process.platform, arch = process.arch) {
    this.recipes = [
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

  list(): DevelopmentRecipe[] {
    return this.recipes.map((recipe) => structuredClone(recipe));
  }

  get(recipeId: string): DevelopmentRecipe | null {
    const recipe = this.recipes.find((candidate) => candidate.recipeId === recipeId);
    return recipe ? structuredClone(recipe) : null;
  }

  digest(recipe: DevelopmentRecipe): string {
    return domainHash("vibestudio/development-recipe/v1", canonicalJson(recipe));
  }

  environmentDigest(recipe: DevelopmentRecipe): string {
    return domainHash(
      "vibestudio/development-environment/v1",
      canonicalJson(recipe.declaredEnvironment)
    );
  }
}
