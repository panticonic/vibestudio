import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const schemaProbeComponentPath = (root) => path.join(root, "schema-evidence.json");
export const schemaProbeStagingPath = (root) =>
  `${schemaProbeComponentPath(root)}.tmp.${randomUUID()}`;
export function assertSchemaProbeStagingPath(staging, root) {
  const absolute = path.resolve(staging);
  if (
    path.dirname(absolute) !== path.resolve(root) ||
    !/^schema-evidence\.json\.tmp\.[a-f0-9-]{36}$/u.test(path.basename(absolute))
  )
    throw new Error("Schema evidence staging coordinate escapes its installation owner");
  return absolute;
}
/** The compiled verifier owns proof; this native boundary owns publication only. */
export async function publishSchemaProbeComponent(staging, root) {
  const filename = assertSchemaProbeStagingPath(staging, root);
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("Schema evidence staging is not a regular file");
  // Pending proof remains private until its serving owners have joined. The
  // installed component contains only public executable facts, and must be
  // readable by ordinary users when the installer owns the application.
  await fs.chmod(filename, 0o644);
  const destination = schemaProbeComponentPath(root);
  try {
    await fs.link(filename, destination);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = await fs.lstat(destination);
    if (!existing.isFile() || existing.isSymbolicLink())
      throw new Error("Installed schema evidence is not a regular immutable file", {
        cause: error,
      });
    const results = await Promise.allSettled([fs.readFile(filename), fs.readFile(destination)]);
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    );
    if (failures.length === 1) throw failures[0];
    if (failures.length)
      throw new AggregateError(failures, "Schema publication comparison failed", { cause: error });
    if (!results[0].value.equals(results[1].value))
      throw new Error("A completed immutable schema component cannot be changed", { cause: error });
  }
}
export async function retireSchemaProbeStaging(staging, root) {
  await fs.rm(assertSchemaProbeStagingPath(staging, root), { force: true });
}
