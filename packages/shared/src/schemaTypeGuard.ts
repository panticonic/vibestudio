/**
 * Compile-time drift guard between a hand-written type and its (strict) zod schema.
 *
 * `schema satisfies z.ZodType<T>` only proves ONE direction — the schema's OUTPUT is assignable to
 * `T` (schema ⊆ type). It is BLIND to a field added to `T` that the `.strict()` schema omits: the
 * schema's output (missing that optional field) is still a valid `T`, so it compiles — then REJECTS
 * that field at runtime ("Unrecognized key(s)"). That exact gap broke every panel acquire when
 * `keepLoaded` was added to the lease type but not its schema.
 *
 * `SchemaCoversType<T, S>` closes the other direction: it resolves to `true` iff every key of `T`
 * exists in the schema's inferred output `S`, else to a diagnostic error object. Pair it with the
 * `satisfies` for a bidirectional check; assign the result to a `const … = true` so a missing key
 * fails to COMPILE (with the offending keys named) instead of at runtime. Value-type drift is already
 * caught by the `satisfies` side, so a key check here is sufficient.
 *
 * Usage:
 *   const _guard: SchemaCoversType<MyType, z.infer<typeof mySchema>> = true;
 *   void _guard;
 */
export type SchemaCoversType<T, S> = keyof T extends keyof S
  ? true
  : { ERROR: "type has keys the strict schema is missing"; missingKeys: Exclude<keyof T, keyof S> };
