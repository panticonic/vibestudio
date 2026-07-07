/**
 * LIVE e2e for the local-models extension (design §11.2 scenarios 1–3):
 * real llama.cpp release download, real LFM2.5 GGUF download, real
 * llama-server, real OpenAI-compatible + tool-calling round-trips.
 *
 * Gated behind RUN_LOCAL_MODELS_E2E=1 — it downloads ~800 MB on first run
 * (cached machine-globally afterwards) and starts local servers. Locks
 * design risks #1 (loopback fetch), #2 (LFM2.5 tool template under --jinja),
 * and the pinned-build asset naming against reality.
 */

import { describe, expect, it } from "vitest";
import { activate } from "./index.js";
import { FALLBACK_MODEL } from "./types.js";

const RUN = process.env["RUN_LOCAL_MODELS_E2E"] === "1";
// Sized for a slow (~500 KB/s) connection downloading the 731 MB fallback
// GGUF; interrupted runs resume via HTTP Range, so re-runs only pay the rest.
const BOOTSTRAP_TIMEOUT_MS = 40 * 60_000;

function stubCtx() {
  return {
    log: {
      info: (msg: string, data?: unknown) =>
        console.log(msg, data !== undefined ? JSON.stringify(data) : ""),
    },
    emit: () => {},
  };
}

describe.runIf(RUN)("local-models live e2e", () => {
  it(
    "bootstraps the fallback floor and answers chat + tool round-trips",
    async () => {
      const api = await activate(stubCtx());

      // Lazy floor (design §5): bootstrap installs engines but leaves the
      // fallback cold — nothing is downloaded and no utility server is warm
      // until first demand.
      const cold = await api.status();
      expect(cold.fallback.warm, "utility must be cold before demand").toBe(false);

      // First ensureLoaded is the demand that downloads the GGUF (design §11.2
      // scenario 1) and warms the utility server — the long pole on a cold box.
      const { baseUrl } = await api.ensureLoaded(FALLBACK_MODEL.slug);
      const { apiKey } = await api.getLoopbackAuth();

      const status = await api.status();
      expect(status.fallback.ready, `fallback not downloaded: ${JSON.stringify(status.fallback)}`).toBe(
        true
      );
      expect(status.fallback.warm, "fallback not warm after demand").toBe(true);
      expect(status.servers.utility.state).toBe("running");

      const models = await api.listModels();
      const fallback = models.find((m) => m.slug === FALLBACK_MODEL.slug);
      expect(fallback, "fallback model missing from listModels").toBeTruthy();
      expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/u);
      expect(apiKey.length).toBeGreaterThanOrEqual(32);

      // Plain chat completion (scenario 2, wire-level).
      const chatRes = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: FALLBACK_MODEL.slug,
          messages: [{ role: "user", content: "Reply with a single short greeting." }],
          max_tokens: 32,
        }),
      });
      expect(chatRes.ok, `chat completion HTTP ${chatRes.status}`).toBe(true);
      const chatBody = (await chatRes.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const text = chatBody.choices?.[0]?.message?.content ?? "";
      expect(text.trim().length, `empty completion: ${JSON.stringify(chatBody)}`).toBeGreaterThan(
        0
      );

      // Rejecting an unauthenticated caller proves the api-key gate is live.
      const unauthenticated = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: FALLBACK_MODEL.slug,
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 4,
        }),
      });
      expect(unauthenticated.status).toBe(401);

      // Tool-calling round-trip (scenario 3 / design risk #2: LFM2.5's
      // <|tool_call_start|> Pythonic format under --jinja).
      const toolRes = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: FALLBACK_MODEL.slug,
          messages: [
            {
              role: "user",
              content: "What time is it in Berlin right now? You must use the get_time tool.",
            },
          ],
          tools: [
            {
              type: "function",
              function: {
                name: "get_time",
                description: "Get the current time in a timezone",
                parameters: {
                  type: "object",
                  properties: { timezone: { type: "string" } },
                  required: ["timezone"],
                },
              },
            },
          ],
          tool_choice: "auto",
          max_tokens: 128,
        }),
      });
      expect(toolRes.ok, `tool completion HTTP ${toolRes.status}`).toBe(true);
      const toolBody = (await toolRes.json()) as {
        choices?: Array<{
          message?: { tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> };
        }>;
      };
      const toolCalls = toolBody.choices?.[0]?.message?.tool_calls ?? [];
      expect(
        toolCalls.length,
        `no tool_calls parsed (risk #2): ${JSON.stringify(toolBody.choices?.[0]?.message)}`
      ).toBeGreaterThan(0);
      expect(toolCalls[0]?.function?.name).toBe("get_time");
    },
    BOOTSTRAP_TIMEOUT_MS
  );

  it(
    "downloads the 230M sibling and switches models across the router (main) server",
    async () => {
      const api = await activate(stubCtx());
      const SIBLING = "lfm2.5-230m";

      // Pull the tiny sibling via the curated-catalog path if absent.
      let models = await api.listModels();
      if (!models.some((m) => m.slug === SIBLING)) {
        await api.startDownloadJob({
          hfRepo: "LiquidAI/LFM2.5-230M-GGUF",
          file: "LFM2.5-230M-Q4_K_M.gguf",
          displayName: "LFM2.5 230M",
          slug: SIBLING,
        });
        const deadline = Date.now() + BOOTSTRAP_TIMEOUT_MS - 120_000;
        while (Date.now() < deadline) {
          models = await api.listModels();
          const entry = models.find((m) => m.slug === SIBLING);
          if (entry && entry.state !== "downloading") break;
          await new Promise((resolve) => setTimeout(resolve, 5_000));
        }
      }
      const sibling = (await api.listModels()).find((m) => m.slug === SIBLING);
      expect(sibling, "230M sibling missing after download").toBeTruthy();
      expect(sibling?.server).toBe("main");

      // Switching: the sibling loads on the router (main) server — a
      // different process and port than the fallback's utility server.
      const [siblingLoaded, fallbackLoaded, auth] = [
        await api.ensureLoaded(SIBLING),
        await api.ensureLoaded(FALLBACK_MODEL.slug),
        await api.getLoopbackAuth(),
      ];
      expect(siblingLoaded.baseUrl).not.toBe(fallbackLoaded.baseUrl);

      // A real completion from the sibling, selected by the request's model
      // field (router semantics).
      const res = await fetch(`${siblingLoaded.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${auth.apiKey}`,
        },
        body: JSON.stringify({
          model: SIBLING,
          messages: [{ role: "user", content: "Say hello in three words or fewer." }],
          max_tokens: 24,
        }),
      });
      expect(res.ok, `sibling completion HTTP ${res.status}`).toBe(true);
      const body = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        model?: string;
      };
      const text = body.choices?.[0]?.message?.content ?? "";
      expect(text.trim().length, `empty sibling completion: ${JSON.stringify(body)}`).toBeGreaterThan(0);
    },
    BOOTSTRAP_TIMEOUT_MS
  );
});
