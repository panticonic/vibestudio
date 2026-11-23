function requiredEntry(record, id, kind) {
  const value = record[id];
  if (!value) throw new Error(`Development ${id} template has no ${kind}`);
  return value;
}

export function developmentTemplateSetSources(selection) {
  return selection.sources.map((source) => ({
    pin: requiredEntry(selection.sourcePins, source.id, "pin"),
    checkout: requiredEntry(selection.checkouts, source.id, "checkpoint"),
    review: requiredEntry(selection.reviews, source.id, "review"),
  }));
}

export function developmentTemplateSetEnv(selection, { defaultTemplatesOnly = false } = {}) {
  const sources = developmentTemplateSetSources(selection);
  return {
    VIBESTUDIO_DEFAULT_WORKSPACE_TEMPLATES: JSON.stringify(selection.pins),
    VIBESTUDIO_PREPARE_WORKSPACE_TEMPLATES: JSON.stringify(
      defaultTemplatesOnly ? selection.pins : selection.sourcePins
    ),
    VIBESTUDIO_INITIAL_WORKSPACE_TEMPLATE: JSON.stringify(selection.pins.system),
    VIBESTUDIO_WORKSPACE_SOURCES: JSON.stringify(sources),
  };
}
