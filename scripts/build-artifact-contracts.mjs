/** Node globals required by bundled CommonJS dependencies inside ESM artifacts. */
export const NODE_ESM_COMPAT_BANNER = `import { createRequire as __createRequire } from "node:module";
import { fileURLToPath as __fileURLToPath } from "node:url";
import { dirname as __pathDirname } from "node:path";
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __pathDirname(__filename);`;

/** Banner injected verbatim into the standalone Node ESM server artifact. */
export const SERVER_ESM_BANNER = `#!/usr/bin/env node
${NODE_ESM_COMPAT_BANNER}`;
