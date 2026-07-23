import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import {
  missionCharterSchema,
  missionPermissionSchema,
  missionStandingRestrictionSchema,
} from "@vibestudio/service-schemas/mission";
import type { MissionRecord } from "@vibestudio/shared/authority/mission";
import type { MissionRegistry } from "./missionRegistry.js";

const hex64 = z.string().regex(/^[0-9a-f]{64}$/u);
const seedHash = z.union([hex64, z.literal("@seed")]);
const seedCharterSchema = missionCharterSchema.extend({
  harness: z.object({ unit: z.string().min(1), ev: z.literal("@seed") }).strict(),
  skills: z.array(z.object({ path: z.string().min(1), contentHash: seedHash }).strict()),
});

const missionSeedDefinitionSchema = z
  .object({
    schemaVersion: z.literal(1),
    missionId: z.string().regex(/^msn_[A-Za-z0-9_-]+$/u),
    name: z.string().min(1),
    charter: seedCharterSchema,
    permissions: z.array(missionPermissionSchema),
    standingRestrictions: z.array(missionStandingRestrictionSchema).optional(),
  })
  .strict();

export type MissionSeedDefinition = z.infer<typeof missionSeedDefinitionSchema>;

export function loadMissionSeedDefinitions(directory: string): MissionSeedDefinition[] {
  let names: string[];
  try {
    names = fs.readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return names
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const file = path.join(directory, name);
      let raw: unknown;
      try {
        raw = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch (error) {
        throw new Error(
          `Cannot read seeded mission ${file}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        );
      }
      const parsed = missionSeedDefinitionSchema.safeParse(raw);
      if (!parsed.success) {
        throw new Error(`Invalid seeded mission ${file}: ${parsed.error.message}`);
      }
      return parsed.data;
    });
}

export function reconcileSeededMissions(input: {
  productSnapshotState: string;
  definitions: readonly MissionSeedDefinition[];
  harnessVersions: ReadonlyMap<string, string>;
  skillContentHashes?: ReadonlyMap<string, string>;
  registry: MissionRegistry;
  now?: number;
}): MissionRecord[] {
  const seen = new Set<string>();
  return input.definitions.map((definition) => {
    if (seen.has(definition.missionId)) {
      throw new Error(`Duplicate seeded mission id ${definition.missionId}`);
    }
    seen.add(definition.missionId);
    const harnessEv = input.harnessVersions.get(definition.charter.harness.unit);
    if (!harnessEv || !/^[0-9a-f]{64}$/u.test(harnessEv)) {
      throw new Error(
        `Seeded mission ${definition.missionId} has no exact product harness version`
      );
    }
    const skills = definition.charter.skills.map((skill) => {
      if (skill.contentHash !== "@seed") return skill;
      const contentHash = input.skillContentHashes?.get(skill.path);
      if (!contentHash || !/^[0-9a-f]{64}$/u.test(contentHash)) {
        throw new Error(
          `Seeded mission ${definition.missionId} has no product hash for skill ${skill.path}`
        );
      }
      return { ...skill, contentHash };
    });
    const charter = missionCharterSchema.parse({
      ...definition.charter,
      harness: { unit: definition.charter.harness.unit, ev: harnessEv },
      skills,
    });
    return input.registry.upsertSeeded({
      productSnapshotState: input.productSnapshotState,
      missionId: definition.missionId,
      name: definition.name,
      charter,
      permissions: definition.permissions,
      ...(definition.standingRestrictions === undefined
        ? {}
        : { standingRestrictions: definition.standingRestrictions }),
      ...(input.now === undefined ? {} : { now: input.now }),
    });
  });
}
