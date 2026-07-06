export {
  LinkedAgentWorker,
  LINKED_AGENT_EVENT,
  LINKED_HEARTBEAT_TIMEOUT_MS,
  LINKED_PERMISSION_TIMEOUT_MS,
} from "./linked-agent-worker.js";
export type { LinkedHookEvent, LinkedAttachment } from "./linked-agent-worker.js";

export default {
  fetch(_req: Request) {
    return new Response("linked-agent DO service");
  },
};
