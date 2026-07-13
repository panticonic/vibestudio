import * as fs from "node:fs";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  DEVICE_ID_PATTERN,
  DEVICE_REFRESH_TOKEN_PATTERN,
} from "@vibestudio/shared/deviceCredentials";
import { writeFileAtomicSync } from "../../atomicFile.js";
import { PAIRING_CODE_HASH_PATTERN } from "../hostCore/routedRoomStore.js";

const PendingPairingActivationSchema = z
  .object({
    codeHash: z.string().regex(PAIRING_CODE_HASH_PATTERN),
    deviceId: z.string().regex(DEVICE_ID_PATTERN),
    refreshToken: z.string().regex(DEVICE_REFRESH_TOKEN_PATTERN),
    expiresAt: z.number().int().positive(),
  })
  .strict();

export type PendingPairingActivation = z.infer<typeof PendingPairingActivationSchema>;

const PairingActivationStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    pending: z.array(PendingPairingActivationSchema),
  })
  .strict()
  .superRefine((state, ctx) => {
    const hashes = new Set<string>();
    const devices = new Set<string>();
    for (const [index, activation] of state.pending.entries()) {
      if (hashes.has(activation.codeHash)) {
        ctx.addIssue({
          code: "custom",
          path: ["pending", index, "codeHash"],
          message: "Duplicate pairing-code hash",
        });
      }
      if (devices.has(activation.deviceId)) {
        ctx.addIssue({
          code: "custom",
          path: ["pending", index, "deviceId"],
          message: "Device id belongs to another pairing activation",
        });
      }
      hashes.add(activation.codeHash);
      devices.add(activation.deviceId);
    }
  });

/**
 * Durable retry material for the narrow issue→route-promotion crash window.
 *
 * A child proposes the device credential and fsyncs it before asking the hub
 * to consume the code. The hub stores only its hash plus a replay receipt. If
 * either process dies before the child acknowledges durable route promotion,
 * the same code deterministically resumes the same issuance. This file is
 * mode 0600 because it temporarily contains the clear refresh secret.
 */
export class PairingActivationStore {
  private readonly pending = new Map<string, PendingPairingActivation>();

  constructor(private readonly filePath: string) {
    if (!fs.existsSync(filePath)) return;
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    } catch (error) {
      throw new Error(
        `Pairing activation state at ${filePath} is unreadable: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    const parsed = PairingActivationStateSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `Pairing activation state at ${filePath} is not the canonical schema: ${parsed.error.message}`
      );
    }
    for (const item of parsed.data.pending) this.pending.set(item.codeHash, item);
  }

  list(): PendingPairingActivation[] {
    return [...this.pending.values()].sort((a, b) => a.codeHash.localeCompare(b.codeHash));
  }

  get(codeHash: string): PendingPairingActivation | null {
    return this.pending.get(codeHash) ?? null;
  }

  prepare(codeHash: string, expiresAt: number): PendingPairingActivation {
    const existing = this.pending.get(codeHash);
    if (existing) {
      if (existing.expiresAt !== expiresAt) {
        throw new Error("Pairing activation deadline does not match its durable invite");
      }
      return existing;
    }
    const activation = PendingPairingActivationSchema.parse({
      codeHash,
      deviceId: `dev_${randomBytes(18).toString("base64url")}`,
      refreshToken: randomBytes(32).toString("base64url"),
      expiresAt,
    });
    const next = new Map(this.pending);
    next.set(codeHash, activation);
    this.commit(next);
    return activation;
  }

  removeExpired(now: number): PendingPairingActivation[] {
    const expired = this.list().filter((item) => item.expiresAt <= now);
    if (expired.length === 0) return [];
    const next = new Map(this.pending);
    for (const item of expired) next.delete(item.codeHash);
    this.commit(next);
    return expired;
  }

  remove(codeHash: string): PendingPairingActivation | null {
    const existing = this.pending.get(codeHash);
    if (!existing) return null;
    const next = new Map(this.pending);
    next.delete(codeHash);
    this.commit(next);
    return existing;
  }

  private commit(next: Map<string, PendingPairingActivation>): void {
    const state = PairingActivationStateSchema.parse({
      schemaVersion: 1,
      pending: [...next.values()].sort((a, b) => a.codeHash.localeCompare(b.codeHash)),
    });
    writeFileAtomicSync(this.filePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    this.pending.clear();
    for (const item of state.pending) this.pending.set(item.codeHash, item);
  }
}
