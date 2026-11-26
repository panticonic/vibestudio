// Generated from Base packages/application-outcomes/review-evidence-roles.ts; source SHA256 e0af9150be096e5332d4793f6c616c2828768d20706128738239d0fa0fbf1939.
function referenceReviewInput(input, options = {}) {
  if (options.legacyCandidateLayout) return input;
  const observations = input.actual.observations;
  if (!observations || typeof observations !== "object" || Array.isArray(observations)) throw new Error("Missing bound observations");
  const excluded = new Set(options.nonAuthoritativeKeys ?? []);
  if (excluded.size !== (options.nonAuthoritativeKeys ?? []).length || [...excluded].some((key) => !Object.hasOwn(observations, key))) throw new Error("Unknown nonauthoritative observation role");
  const attemptedArguments = [];
  const pointer = (path, key) => path + "/" + key.replace(/~/g, "~0").replace(/\//g, "~1");
  const state = (value, path) => {
    if (Array.isArray(value)) return value.map((row2, index) => state(row2, pointer(path, String(index))));
    if (!value || typeof value !== "object") return value;
    const row = value;
    const operation = typeof row.method === "string" && Array.isArray(row.args);
    if (operation) {
      if (Object.hasOwn(row, "attemptedArgumentsPath")) throw new Error("Conflicting operation role");
      attemptedArguments.push({ path: pointer(path, "args"), ...Object.hasOwn(row, "service") ? { service: row.service } : {}, method: row.method, arguments: row.args });
    }
    return Object.fromEntries(Object.entries(row).flatMap(([key, item]) => operation && key === "args" ? [] : [[key, state(item, pointer(path, key))]]).concat(operation ? [["attemptedArgumentsPath", pointer(path, "args")]] : []));
  };
  const native = Object.fromEntries(Object.entries(observations).filter(([key]) => !excluded.has(key)).map(([key, value]) => [key, state(value, pointer("", key))]));
  const { observations: _observations, ...candidate } = input.actual;
  return { actual: { ...candidate, attemptedArguments }, expected: { ...input.expected, evidenceRoleLayout: "native-reference/1", observations: native }, rubric: input.rubric };
}
export {
  referenceReviewInput
};
