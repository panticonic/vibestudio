export { AiChatWorker } from "./ai-chat-worker.js";
// git push exercise marker
export default { fetch(_req: Request) { return new Response("agent-worker DO service"); } };
