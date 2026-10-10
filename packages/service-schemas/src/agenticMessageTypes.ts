import { z } from "zod";
import { JsonObjectSchema } from "@vibestudio/shared/wireValues";
const AgenticStoredValueRefSchema = z
  .object({
    protocol: z.literal("vibestudio.blob-ref.v1"),
    digest: z.string().min(1),
    size: z.number().int().nonnegative(),
    encoding: z.enum(["json", "text"]),
    originalBytes: z.number().int().nonnegative(),
  })
  .strict();

/**
 * GAD's durable message-type projection is storage-form data. Reference-class
 * event fields stay as blob refs inside the append transaction; PubSub owns
 * hydration and semantic validation before callers can observe a definition.
 */
export const StoredChannelMessageTypeDefinitionSchema = z
  .object({
    typeId: z.string(),
    displayMode: z.enum(["inline", "row"]),
    source: AgenticStoredValueRefSchema,
    imports: AgenticStoredValueRefSchema.optional(),
    stateSchema: JsonObjectSchema.optional(),
    updateSchema: JsonObjectSchema.optional(),
    registeredBy: JsonObjectSchema.optional(),
    updatedAtSeq: z.number().int().nonnegative(),
    clearedAtSeq: z.number().int().nonnegative().optional(),
  })
  .strict();
export type StoredChannelMessageTypeDefinition = z.infer<
  typeof StoredChannelMessageTypeDefinitionSchema
>;

export const StoredRegistryMutationInputSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("upsertMessageType"),
      typeId: z.string(),
      row: StoredChannelMessageTypeDefinitionSchema.omit({
        typeId: true,
        updatedAtSeq: true,
        clearedAtSeq: true,
      }),
    })
    .strict(),
  z.object({ kind: z.literal("clearMessageType"), typeId: z.string() }).strict(),
]);
export type StoredRegistryMutationInput = z.infer<typeof StoredRegistryMutationInputSchema>;
