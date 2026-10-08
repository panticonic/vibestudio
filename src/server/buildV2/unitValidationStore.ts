import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getUserDataPath } from "@vibestudio/env-paths";
import { buildDiagnosticSchema } from "@vibestudio/service-schemas/build";
import { sha256Canonical } from "@vibestudio/shared/authority/invocationSnapshot";
import {
  derivedCacheCoordinator,
  scheduleDerivedCachePrune,
} from "@vibestudio/shared/derivedCache";
import type { BuildDiagnostic } from "./diagnostics.js";

const recordSchema = z
  .object({ key: z.string(), diagnostics: z.array(buildDiagnosticSchema) })
  .strict();

/** Compiler observations are reusable only for the same complete validation input. */
export class UnitValidationStore {
  constructor(private readonly root = path.join(getUserDataPath(), "unit-validation")) {}

  async validate(
    identity: unknown,
    compute: () => Promise<{ diagnostics: BuildDiagnostic[]; reusable: boolean }>
  ): Promise<{ diagnostics: BuildDiagnostic[]; reusable: boolean }> {
    const key = sha256Canonical({ recipe: "unit-validation.v1", identity });
    const lease = derivedCacheCoordinator(this.root).acquire(this.root, key);
    const directory = path.join(this.root, key);
    const file = path.join(directory, "validation.json");
    try {
      try {
        const value = recordSchema.safeParse(JSON.parse(await fs.readFile(file, "utf8")));
        if (value.success && value.data.key === key) {
          return { diagnostics: value.data.diagnostics, reusable: true };
        }
      } catch (error) {
        if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT")
          throw error;
      }
      const result = await compute();
      if (result.reusable) {
        await fs.mkdir(directory, { recursive: true });
        const temporary = `${file}.${randomUUID()}.tmp`;
        try {
          await fs.writeFile(temporary, JSON.stringify({ key, diagnostics: result.diagnostics }), {
            flag: "wx",
          });
          await fs.rename(temporary, file);
        } finally {
          await fs.rm(temporary, { force: true });
        }
      }
      return result;
    } finally {
      lease.release();
      void scheduleDerivedCachePrune(this.root).catch((error) => {
        console.warn("[UnitValidationStore] Could not prune validation cache", error);
      });
    }
  }
}
