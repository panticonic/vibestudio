// The Android client dev loop (docs/client-hosts-and-clients-plan.md 7.4, "Proof"): a client
// authored and published through the same server APIs an agent uses (`vibestudio eval run`
// with the Base workspace-dev skill and the semantic VCS), launched on an already-running
// host, edited live. This module holds what is pure: the eval sources a publication runs,
// and the parsers of what the device shows. The smoke owns the processes and the device.

export const HELLO_CLIENT_ID = "hello-android";
export const HELLO_ECHO_INTENT = "ask";

export function helloGreeting(nonce) {
  return `Hello ${nonce}`;
}

export function helloUpdatedGreeting(nonce) {
  return `Hello again ${nonce}`;
}

export function echoed(text) {
  return `echo: ${text}`;
}

/**
 * Create, declare and publish `clients/hello-android`, with the worker that answers its
 * background intent, as an agent following `system/skills/clientdev` does.
 *
 * Android's only surface that runs a background intent is the Ask tile, which runs the
 * default client's `ask`: the hello client is therefore declared the default Android
 * client, and its background intent is named `ask`.
 */
export function authorHelloSource(nonce) {
  return `import { prepareProjects } from "@workspace-skills/workspace-dev";
import { fs, vcs } from "@workspace/runtime";

const policy = {
  website: { kind: "closed", reason: "Client background intents are invoked by the server for a paired device." },
  principals: ["host"], effect: { kind: "open" }, tier: "open", sensitivity: "write",
} as const;
await prepareProjects([{ projectType: "client", name: ${JSON.stringify(HELLO_CLIENT_ID)}, title: "Hello Android", runtime: "rn-host-6" }]);
await prepareProjects([{
  projectType: "worker", name: "hello-echo", title: "Hello Echo", template: "durable-service",
  authority: { requests: [], provides: [] },
  authorityReason: "Answers the client's echo intent from the text it is given; no other authority.",
  methods: { listRecords: policy, upsertRecord: policy },
}]);
const read = async (path: string) => (await fs.readFile(path, "utf8")) as string;

await fs.writeFile("/workers/hello-echo/index.ts", \`import { DurableObjectBase, rpc } from "@workspace/runtime/worker/kernel";

export class HelloEcho extends DurableObjectBase {
  static override schemaVersion = 1;

  protected override createTables(): void {} // stateless: no tables

  @rpc({
    website: { kind: "closed", reason: "Client background intents are invoked by the server for a paired device." },
    principals: ["host"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async echo(input: { params: { text: string }; principalId: string }): Promise<string> {
    return \\\`echo: \\\${input.params.text}\\\`;
  }
}

export default {
  fetch() {
    return new Response("Hello Echo service");
  },
};
\`);
await fs.rm("/workers/hello-echo/contract.ts");
const worker = JSON.parse(await read("/workers/hello-echo/package.json"));
delete worker.exports;
worker.vibestudio.services = [{
  name: "hello",
  action: "echo client text",
  presentation: { domain: "automation", verb: "act" },
  protocols: ["vibestudio.hello.v1"],
  authority: { principals: ["host"] },
  durableObject: { className: "HelloEcho" },
}];
await fs.writeFile("/workers/hello-echo/package.json", JSON.stringify(worker, null, 2) + "\\n");

const client = JSON.parse(await read("/clients/${HELLO_CLIENT_ID}/package.json"));
client.vibestudio.client.intents.push({
  name: ${JSON.stringify(HELLO_ECHO_INTENT)}, kind: "background", title: "Hello echo",
  params: { text: "text" }, handler: "vibestudio.hello.v1#echo",
});
client.vibestudio.authority = {
  // Every React Native client owes the workspace context boundary (buildV2/authorityFold.ts).
  requests: [
    { capability: "context.boundary", resource: { kind: "prefix", prefix: "" }, tier: "critical", evidence: "intentional-broad" },
    { capability: "workspace-service:hello", resource: { kind: "exact", key: "do:workers/hello-echo:HelloEcho:workspace-hello" }, tier: "gated", evidence: "exact" },
  ],
  serviceRequests: [{ protocol: "vibestudio.hello.v1", availability: "required" }],
  provides: [],
};
await fs.writeFile("/clients/${HELLO_CLIENT_ID}/package.json", JSON.stringify(client, null, 2) + "\\n");
await fs.writeFile("/clients/${HELLO_CLIENT_ID}/App.tsx", \`${clientEntry(helloGreeting(nonce))}\`);

let yml = await read("/meta/vibestudio.yml");
yml = yml.replace("clients:\\n", "clients:\\n  - source: clients/${HELLO_CLIENT_ID}\\n");
yml = yml.replace("services:\\n", "services:\\n  - name: hello\\n    source: workers/hello-echo\\n");
yml = yml.replace("singletonObjects:\\n", "singletonObjects:\\n  - className: HelloEcho\\n    key: workspace-hello\\n    source: workers/hello-echo\\n");
yml = yml.replace("  android: clients/mobile-browser", "  android: clients/${HELLO_CLIENT_ID}");
await fs.writeFile("/meta/vibestudio.yml", yml);
return await vcs.publish({ message: "Add the ${HELLO_CLIENT_ID} client" });
`;
}

/** Change the greeting the running client shows, and publish it. */
export function editHelloSource(nonce) {
  return `import { fs, vcs } from "@workspace/runtime";
await fs.writeFile("/clients/${HELLO_CLIENT_ID}/App.tsx", \`${clientEntry(helloUpdatedGreeting(nonce))}\`);
return await vcs.publish({ message: "Greet differently" });
`;
}

/** The scaffold's one-screen entry, showing `greeting`. Imports the protocol constants only, not the whole API barrel. */
function clientEntry(greeting) {
  return `import "@vibestudio/rn-client-api/polyfills";
import { AppRegistry, Text, View } from "react-native";
import { CLIENT_ROOT_COMPONENT } from "@vibestudio/rn-client-api/protocol";

function App() {
  return (
    <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
      <Text>{${JSON.stringify(greeting)}}</Text>
    </View>
  );
}

AppRegistry.registerComponent(CLIENT_ROOT_COMPONENT, () => App);

export default App;
`;
}

/** The System workspace's name in the payload of `vibestudio remote workspaces --json`. */
export function systemWorkspaceName(payload) {
  const entry = (payload.workspaces ?? []).find((workspace) => workspace.privateRole === "system");
  if (!entry) throw new Error(`The account has no System workspace: ${JSON.stringify(payload)}`);
  return entry.name;
}

/** Every text on screen in a `uiautomator dump`, unescaped. */
export function visibleTexts(xml) {
  return [...xml.matchAll(/\btext="([^"]*)"/gu)]
    .map(([, text]) =>
      text
        .replace(/&quot;/gu, '"')
        .replace(/&amp;/gu, "&")
        .replace(/&lt;/gu, "<")
        .replace(/&gt;/gu, ">")
    )
    .filter(Boolean);
}

/**
 * The text of the notification of `packageName` titled `title` in `dumpsys notification
 * --noredact`, or null. The key is not the notification id the app chose, so the title is
 * what identifies it.
 */
export function notificationText(dump, packageName, title) {
  for (const record of dump.split("NotificationRecord(").slice(1)) {
    if (!record.includes(`pkg=${packageName}`)) continue;
    const heading = record.match(/android\.title=\w+ \(([^\n]*)\)/u);
    if (heading?.[1] !== title) continue;
    const body = record.match(/android\.text=\w+ \(([^\n]*)\)/u);
    if (body) return body[1];
  }
  return null;
}
