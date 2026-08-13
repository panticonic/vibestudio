import * as path from "node:path";
import { GitClient, readExactGitSnapshot } from "@vibestudio/git";
import { sha256Hex } from "@vibestudio/content-addressing";
import { TEMPLATE_RESERVED_PATH_POLICY } from "@vibestudio/workspace/templateCoordinates";

const [directoryArgument, commitArgument] = process.argv.slice(2);
if (!directoryArgument || !commitArgument) {
  throw new Error("Usage: inspect-template-commit DIR COMMIT");
}
const directory = path.resolve(directoryArgument);
const snapshot = await readExactGitSnapshot({
  git: new GitClient(),
  dir: directory,
  commit: commitArgument,
  label: directory,
  reservedPaths: TEMPLATE_RESERVED_PATH_POLICY,
  sink: {
    async put(bytes) {
      return { digest: sha256Hex(bytes), size: bytes.byteLength };
    },
  },
});
process.stdout.write(
  `${JSON.stringify(
    {
      commit: snapshot.commit,
      snapshot: snapshot.snapshot,
      files: snapshot.files.length,
    },
    null,
    2
  )}\n`
);
