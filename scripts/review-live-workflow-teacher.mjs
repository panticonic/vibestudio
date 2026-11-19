import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Reuse Natlang's canonical independent rubric judge and provider transport. */
export function workflowReviewer(
  model,
  repo = process.env.NATLANG_REPO ?? path.join(os.homedir(), "natlang")
) {
  if (!model) return undefined;
  const separator = model.indexOf(":");
  if (separator < 1 || separator === model.length - 1) {
    throw new Error("Choose the reviewer as PROVIDER:MODEL");
  }
  const provider = model.slice(0, separator);
  const modelId = model.slice(separator + 1);
  const loader = (relative) =>
    import(pathToFileURL(path.resolve(repo, "ts-host/dist", relative)).href);
  return async (input, teacher) => {
    if (model === teacher) throw new Error("Choose a reviewer model distinct from the executor");
    const [{ createPiModelBackend }, { modelOracleJudge }] = await Promise.all([
      loader("model/pi-provider.js"),
      loader("teacher/model-judge.js"),
    ]);
    const backend = createPiModelBackend(provider, modelId);
    let exchange;
    try {
      await backend.prepare();
      const verdict = await modelOracleJudge(async (request) => {
        const reply = await backend.turn(request);
        if (reply.raw_response?.provider !== provider || reply.raw_response?.model !== modelId) {
          throw new Error("Review reply does not identify the chosen reviewer");
        }
        exchange = { request, reply };
        return reply;
      })(input);
      return { schema: "natlang.live-workflow-review/1", model, input, exchange, verdict };
    } finally {
      backend.close();
    }
  };
}
