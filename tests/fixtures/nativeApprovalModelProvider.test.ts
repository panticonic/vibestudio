import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { parseUnitAuthorityManifest } from "@vibestudio/shared/authorityManifest";
import {
  extensionUnitManifestDescriptor,
  readAndValidateUnitManifest,
} from "@vibestudio/shared/unitManifest";
import { expect, it } from "vitest";
import { discoverPackageGraph } from "../../src/server/buildV2/packageGraph.js";
import {
  NATIVE_APPROVAL_MODEL,
  writeNativeApprovalModelProvider,
  writeNativeApprovalReviewExtension,
} from "./nativeApprovalModelProvider.js";

it("discovers the approval provider at the actual local-model extension identity", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-approval-source-"));
  try {
    const repoPath = writeNativeApprovalModelProvider(root);
    const reviewRepo = writeNativeApprovalReviewExtension(root);
    const graph = discoverPackageGraph(root);
    expect(graph.manifestIssueForPath(repoPath)).toBeUndefined();
    expect(graph.get("@workspace-extensions/local-models")).toMatchObject({
      relativePath: "extensions/local-models",
      kind: "extension",
      manifest: { extension: { activationEvents: ["onInvoke"] } },
    });
    const manifest = JSON.parse(fs.readFileSync(path.join(root, repoPath, "package.json"), "utf8"));
    expect(parseUnitAuthorityManifest(manifest.vibestudio.authority)).toEqual({
      requests: [
        {
          capability: "context.boundary",
          resource: { kind: "prefix", prefix: "" },
          tier: "critical",
          evidence: "intentional-broad",
        },
      ],
      serviceRequests: [],
      provides: [],
    });
    // Package-graph discovery and authority.requests parsing do not validate the
    // native method policy; this is the actual pre-approval owner boundary.
    for (const source of [repoPath, reviewRepo]) {
      const packagePath = path.join(root, source, "package.json");
      const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
      const validate = () =>
        readAndValidateUnitManifest(
          extensionUnitManifestDescriptor,
          packagePath,
          { unitName: pkg.name },
          fs.readFileSync
        );
      expect(validate()).toMatchObject({
        extension: { methodAuthority: pkg.vibestudio.extension.methodAuthority },
      });
      const method = Object.keys(pkg.vibestudio.extension.methodAuthority)[0]!;
      delete pkg.vibestudio.extension.methodAuthority[method].website;
      fs.writeFileSync(packagePath, JSON.stringify(pkg));
      expect(validate).toThrow("must contain one effect and an explicit website policy");
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("refuses to overwrite an existing local-model extension", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-approval-existing-"));
  try {
    const extensionRoot = path.join(root, "extensions/local-models");
    fs.mkdirSync(extensionRoot, { recursive: true });
    const original = '{"name":"@workspace-extensions/local-models","private":true}';
    fs.writeFileSync(path.join(extensionRoot, "package.json"), original);
    expect(() => writeNativeApprovalModelProvider(root)).toThrow("must not replace an existing");
    expect(fs.readFileSync(path.join(extensionRoot, "package.json"), "utf8")).toBe(original);
    expect(fs.readdirSync(extensionRoot)).toEqual(["package.json"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("attests the model to the trusted host and resumes the actual tools after compaction", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-approval-runtime-"));
  const subscriptions: Array<{ dispose(): Promise<void> }> = [];
  try {
    const repoPath = writeNativeApprovalModelProvider(root);
    const entry = pathToFileURL(path.join(root, repoPath, "index.js")).href;
    const { activate } = await import(entry);
    let callerKind = "client";
    const provider = await activate({
      invocation: { current: () => ({ caller: { callerKind } }) },
      subscriptions,
    });

    expect(() => provider.attestRuntime(NATIVE_APPROVAL_MODEL)).toThrow("trusted host");
    callerKind = "server";
    const model = provider.ensureLoaded("native-approval-fixture");
    const runtime = provider.attestRuntime(NATIVE_APPROVAL_MODEL);
    expect(runtime).toEqual({
      baseUrl: model.baseUrl,
      apiKey: expect.any(String),
    });
    expect(() => provider.attestRuntime("local:foreign")).toThrow("Foreign fixture model");
    const complete = async (
      messages: Array<{ role: string; content: string }>,
      tools: string[] = []
    ) => {
      const response = await fetch(`${runtime.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${runtime.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "native-approval-fixture",
          messages,
          tools: tools.map((name) => ({ type: "function", function: { name } })),
        }),
      });
      expect(response.status).toBe(200);
      return (await response.json()).choices[0];
    };
    const prompt = "Open the onboarding setup overview.";
    expect(await complete([{ role: "user", content: prompt }], ["read"])).toMatchObject({
      finish_reason: "tool_calls",
      message: { tool_calls: [{ function: { name: "read" } }] },
    });
    const conversation = [
      `[User]: ${prompt}`,
      '[Assistant tool calls]: read(path="skills/onboarding/SKILL.md")',
      "[Tool result]: name: onboarding",
    ].join("\n\n");
    const summary = await complete([
      { role: "system", content: "You are a context summarization assistant." },
      { role: "user", content: `<conversation>\n${conversation}\n</conversation>` },
    ]);
    expect(summary).toMatchObject({ finish_reason: "stop", message: { role: "assistant" } });
    expect(summary.message.tool_calls).toBeUndefined();
    expect(
      await complete(
        [{ role: "user", content: `<summary>\n${summary.message.content}\n</summary>` }],
        ["read", "inline_ui"]
      )
    ).toMatchObject({
      finish_reason: "tool_calls",
      message: { tool_calls: [{ function: { name: "inline_ui" } }] },
    });
  } finally {
    await Promise.all(subscriptions.map((subscription) => subscription.dispose()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
