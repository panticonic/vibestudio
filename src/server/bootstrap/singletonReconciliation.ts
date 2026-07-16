export async function reconcileSingletons<TItem, TPrepared, TRecord>(input: {
  items: readonly TItem[];
  prepare(item: TItem): Promise<TPrepared>;
  activate(item: TItem, prepared: TPrepared): Promise<TRecord>;
  onActivated(record: TRecord): void;
}): Promise<readonly TRecord[]> {
  // Runtime-image preparation may coalesce into a planned workerd restart.
  // No activation may race that restart, so preparation and activation are
  // deliberately separate barriers.
  const prepared = await Promise.all(
    input.items.map(async (item) => ({ item, prepared: await input.prepare(item) }))
  );
  const records = await Promise.all(
    prepared.map(({ item, prepared: value }) => input.activate(item, value))
  );
  for (const record of records) input.onActivated(record);
  return records;
}
