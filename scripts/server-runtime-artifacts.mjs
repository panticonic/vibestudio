const workerStemByRole = Object.freeze({
  authorityAnalysis: "authority-analysis-worker",
  libraryLowering: "library-lowering-worker",
  typecheck: "typecheck-worker",
  workspaceRpcCatalog: "workspace-rpc-catalog-worker",
  sqliteIntegrity: "sqlite-integrity-worker",
});

function workerEntries(extension) {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(workerStemByRole).map(([role, stem]) => [role, `${stem}.${extension}`])
    )
  );
}

/**
 * Filenames embedded into each server bundle for worker_threads entrypoints.
 * Build emission and npm staging both consume this contract so a worker cannot
 * be renamed or added on one side while silently disappearing from a release.
 */
export const SERVER_WORKER_ENTRIES = Object.freeze({
  standalone: workerEntries("mjs"),
  electron: workerEntries("cjs"),
});

export const STANDALONE_SERVER_RUNTIME_ARTIFACTS = Object.freeze([
  "dist/server.mjs",
  "dist/browserTransport.js",
  ...Object.values(SERVER_WORKER_ENTRIES.standalone).map((filename) => `dist/${filename}`),
  "dist/internal-do.bundle.mjs",
  "dist/sql-wasm.wasm",
  "dist/host-build-fingerprint.json",
]);
