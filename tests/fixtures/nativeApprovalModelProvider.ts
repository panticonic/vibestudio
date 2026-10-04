import * as fs from "node:fs";
import * as path from "node:path";

export const NATIVE_APPROVAL_MODEL = "local:native-approval-fixture";
export const NATIVE_APPROVAL_REPLY = "Native scoped approval fixture completed.";

/** A reviewed test extension serving real OpenAI-compatible HTTP, not a Session port override. */
export function writeNativeApprovalModelProvider(sourceRoot: string): string {
  const repoPath = "extensions/local-models";
  const root = path.join(sourceRoot, repoPath);
  if (fs.existsSync(root)) {
    throw new Error(`The isolated approval fixture must not replace an existing ${repoPath}`);
  }
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify(
      {
        name: "@workspace-extensions/local-models",
        version: "0.1.0",
        private: true,
        type: "module",
        vibestudio: {
          displayName: "Native Approval Model Fixture",
          entry: "index.js",
          extension: {
            activationEvents: ["onInvoke"],
            methodAuthority: Object.fromEntries(
              ["listModels", "ensureLoaded", "getLoopbackAuth", "requestLog"].map((name) => [
                name,
                {
                  effect: { kind: "open" },
                  website: {
                    kind: "closed",
                    reason:
                      "Only the owned desktop approval test may control this native model fixture.",
                  },
                },
              ])
            ),
          },
          authority: {
            requests: [
              {
                capability: "context.boundary",
                resource: { kind: "prefix", prefix: "" },
                tier: "critical",
                evidence: "intentional-broad",
              },
            ],
            provides: [],
          },
        },
      },
      null,
      2
    ) + "\n"
  );
  fs.writeFileSync(path.join(root, "index.js"), providerSource);
  return repoPath;
}

/** The original install-review target, declared through the same native manifest boundary. */
export function writeNativeApprovalReviewExtension(sourceRoot: string): string {
  const repoPath = "extensions/e2e-approval";
  const root = path.join(sourceRoot, repoPath);
  if (fs.existsSync(root)) {
    throw new Error(`The isolated approval fixture must not replace an existing ${repoPath}`);
  }
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify(
      {
        name: "@workspace-extensions/e2e-approval",
        version: "0.1.0",
        private: true,
        type: "module",
        vibestudio: {
          displayName: "E2E Approval Extension",
          entry: "index.ts",
          extension: {
            activationEvents: ["*"],
            methodAuthority: {
              ping: {
                effect: { kind: "open" },
                website: {
                  kind: "closed",
                  reason: "This install-review probe belongs only to the owned desktop test.",
                },
              },
            },
          },
          authority: { requests: [], provides: [] },
        },
      },
      null,
      2
    ) + "\n"
  );
  fs.writeFileSync(
    path.join(root, "index.ts"),
    "export async function activate() { return { ping() { return 'pong'; } }; }\n"
  );
  return repoPath;
}

const fixtureEvalCode = String.raw`const response = await credentials.fetch('https://example.com'); const text = await response.text(); return { status: response.status, title: text.match(/<title>([^<]*)<\/title>/i)?.[1] ?? null };`;

const providerSource = `
import { createServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';

export async function activate(ctx) {
  const key = randomUUID();
  const slug = 'native-approval-fixture';
  const log = [];
  const requests = new Set();
  let sealed = false;
  const server = createServer((req, res) => {
    const work = handle(req, res);
    requests.add(work);
    void work.then(() => requests.delete(work), error => {
      requests.delete(work);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: String(error?.message ?? error) } }));
    });
  });
  ctx.subscriptions.push({ async dispose() {
    sealed = true;
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await Promise.all(requests);
  }});
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture provider has no endpoint');
  const origin = 'http://127.0.0.1:' + address.port;
  const baseUrl = origin + '/v1';

  async function handle(req, res) {
    if (sealed) throw new Error('Fixture provider is retired');
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') throw new Error('Unsupported fixture provider request');
    if (req.headers.authorization !== 'Bearer ' + key) throw new Error('Fixture provider authentication failed');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body.model !== slug || !Array.isArray(body.messages)) throw new Error('Fixture model identity changed');
    const messages = body.messages;
    const user = messages.filter(message => message.role === 'user').at(-1);
    const prompt = typeof user?.content === 'string' ? user.content : JSON.stringify(user?.content ?? '');
    const readId = 'fixture-read-' + createHash('sha256').update(prompt).digest('hex').slice(0, 16);
    const evalId = 'fixture-network-' + createHash('sha256').update(prompt).digest('hex').slice(0, 16);
    const inlineId = 'fixture-overview-' + createHash('sha256').update(prompt).digest('hex').slice(0, 16);
    const readResult = messages.find(message => message.role === 'tool' && message.tool_call_id === readId);
    const evalResult = messages.find(message => message.role === 'tool' && message.tool_call_id === evalId);
    const inlineResult = messages.find(message => message.role === 'tool' && message.tool_call_id === inlineId);
    let call;
    if (!readResult) call = { id: readId, type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'skills/onboarding/SKILL.md' }) } };
    else if (!String(readResult.content).includes('name: onboarding')) throw new Error('Actual onboarding read did not return the shipped skill');
    else if (prompt.includes('https://example.com') && !evalResult) call = { id: evalId, type: 'function', function: { name: 'eval', arguments: JSON.stringify({ code: ${JSON.stringify(fixtureEvalCode)} }) } };
    else if (!prompt.includes('https://example.com') && !inlineResult) call = { id: inlineId, type: 'function', function: { name: 'inline_ui', arguments: JSON.stringify({ id: 'onboarding-setup-overview', path: 'skills/onboarding/SetupHub.tsx', props: {} }) } };
    if (evalResult && !String(evalResult.content).includes('Example Domain')) throw new Error('Actual scoped eval did not return the expected page title');
    if (call && !body.tools?.some(tool => tool.function?.name === call.function.name)) throw new Error('The actual native request did not offer ' + call.function.name);
    log.push({ model: body.model, phase: call?.function.name ?? 'complete', toolCallId: call?.id ?? null });
    const content = call ? null : ${JSON.stringify(NATIVE_APPROVAL_REPLY)};
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: randomUUID(), object: 'chat.completion', created: 1, model: slug, choices: [{ index: 0, message: { role: 'assistant', content, ...(call ? { tool_calls: [call] } : {}) }, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      return;
    }
    const id = randomUUID();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = chunk => res.write('data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: slug, ...chunk }) + '\\n\\n');
    emit({ choices: [{ index: 0, delta: { role: 'assistant', ...(call ? { tool_calls: [{ index: 0, ...call }] } : { content }) }, finish_reason: null }] });
    emit({ choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    res.end('data: [DONE]\\n\\n');
  }
  return {
    listModels() { return [{ slug, displayName: 'Native Approval Fixture', baseUrl, server: 'utility', contextWindow: 65536, maxTokens: 4096, toolsCapable: true, reasoningCapable: false, fit: { fit: 'cpu-only', estTokensPerSec: null, contextLength: 65536, gpuLayers: 0, notes: [] }, measuredTokensPerSec: null, state: 'ready', download: null, errorMessage: null }]; },
    ensureLoaded(modelId) { if (modelId !== slug) throw new Error('Foreign fixture model'); return { baseUrl }; },
    getLoopbackAuth() { if (sealed) throw new Error('Fixture provider is retired'); return { apiKey: key, origins: [origin] }; },
    requestLog() { return log.map(item => ({ ...item })); },
  };
}
`;
