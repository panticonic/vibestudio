export { SystemAgentWorker } from "./system-agent-worker.js";

export default {
  fetch(_request: Request): Response {
    return new Response("system-agent worker");
  },
};
