/** Build the host census solely from schema-generated server/main projections. */
export function buildHostResidencyCensus({ matrices }) {
  const decisions = new Map();
  const services = new Set();
  for (const matrix of matrices) {
    for (const [service, entry] of Object.entries(matrix)) {
      services.add(service);
      for (const [method, declaration] of Object.entries(entry.methods)) {
        const qualifiedMethod = `${service}.${method}`;
        if (decisions.has(qualifiedMethod)) {
          throw new Error(`Host method ${qualifiedMethod} is declared on more than one plane`);
        }
        const decision = declaration.tier;
        if (!decision) throw new Error(`${qualifiedMethod} has no reviewed residency decision`);
        for (const required of ["tier", "session", "rationale", "residency", "family"]) {
          if (typeof decision[required] !== "string" || decision[required].length === 0) {
            throw new Error(`${qualifiedMethod} has no reviewed ${required}`);
          }
        }
        decisions.set(qualifiedMethod, decision);
      }
    }
  }
  return { decisions, services };
}
