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
  await fs.link(filename, schemaProbeComponentPath(root));
}
export async function retireSchemaProbeStaging(staging, root) {
  await fs.rm(assertSchemaProbeStagingPath(staging, root), { force: true });
}
