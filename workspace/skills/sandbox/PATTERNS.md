# Common Patterns

Recipes for common tasks using the sandbox.

## Read a File and Display It

`fs` is injected into eval (context-scoped) — do not import it.

```
eval({ code: `
  const content = await fs.readFile("src/index.ts", "utf-8");
  console.log(content);
  return content;
` })
```

## List Directory Contents

```
eval({ code: `
  const entries = await fs.readdir("src", { withFileTypes: true });
  for (const e of entries) {
    console.log(e.isDirectory() ? "dir:  " + e.name : "file: " + e.name);
  }
` })
```

## Search Files for a Pattern

```
eval({ code: `
  async function grep(dir, pattern, results = []) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const path = dir + "/" + entry.name;
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && entry.name !== "node_modules" && entry.name !== "dist") {
          await grep(path, pattern, results);
        }
      } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
        const content = await fs.readFile(path, "utf-8");
        const lines = content.split("\\n");
        lines.forEach((line, i) => {
          if (line.includes(pattern)) results.push({ path, line: i + 1, text: line.trim() });
        });
      }
    }
    return results;
  }

  const matches = await grep("src", "TODO");
  console.log(matches);
  return matches;
`
})
```

## Use an npm Package (lodash)

```
eval({
  code: `
    import _ from "lodash";
    const data = [
      { name: "Alice", age: 30 },
      { name: "Bob", age: 25 },
      { name: "Charlie", age: 35 },
    ];
    console.log("Grouped by age > 28:", _.groupBy(data, d => d.age > 28 ? "senior" : "junior"));
    console.log("Sorted by age:", _.sortBy(data, "age").map(d => d.name));
  `,
  imports: { "lodash": "npm:^4.17.21" }
})
```

## Use an npm Package (date-fns)

```
eval({
  code: `
    import { format, addDays, differenceInDays } from "date-fns";
    const today = new Date();
    const nextWeek = addDays(today, 7);
    console.log("Today:", format(today, "yyyy-MM-dd"));
    console.log("Next week:", format(nextWeek, "yyyy-MM-dd"));
    console.log("Days between:", differenceInDays(nextWeek, today));
  `,
  imports: { "date-fns": "npm:^3.6.0" }
})
```

## Use a Scoped npm Package (@faker-js/faker)

```
eval({
  code: `
    import { faker } from "@faker-js/faker";
    for (let i = 0; i < 5; i++) {
      console.log(faker.person.fullName(), "-", faker.internet.email());
    }
  `,
  imports: { "@faker-js/faker": "npm:^9.0.0" }
})
```

## npm Packages in Inline UI

> **Defensive coding:** When using `props` in inline UI components, always default the parameter (`{ props = {}, chat }`) and guard property access (`props?.items ?? []`). For small datasets, embedding constants directly in the component source is simpler and more portable than passing `props`.

`eval` runs server-side (in the `EvalDO`) and `inline_ui` compiles in the chat
panel — they have **separate module registries**, so preloading a package in
`eval` does NOT make it available to `inline_ui`. To use a non-default npm
package in a component, put the component in a context-relative file and declare
the dependency in the nearest `package.json` (the panel infers file-loaded
imports), or avoid the dependency by embedding the small bit of logic directly.

```ts
// Component lives in a file whose nearest package.json lists "lodash";
// the panel resolves the import when it compiles the file.
inline_ui({ path: ".vibestudio/ui/shuffler.tsx", props: { items: ["Apple", "Banana", "Cherry"] } });
```

```tsx
// .vibestudio/ui/shuffler.tsx
import { useState } from "react";
import { Button, Flex, Text } from "@radix-ui/themes";
import _ from "lodash";

export default function Shuffler({ props = {} }) {
  const [items, setItems] = useState(props.items ?? []);
  return (
    <Flex direction="column" gap="2">
      <Button size="1" onClick={() => setItems(_.shuffle([...items]))}>
        Shuffle
      </Button>
      {items.map((item, i) => (
        <Text key={i} size="2">
          {item}
        </Text>
      ))}
    </Flex>
  );
}
```

For larger eval/UI code, prefer writing a context-relative file and using the
tool's `path` parameter. Static relative imports from that file are resolved,
and bare package imports are inferred from the nearest `package.json` when
possible:

```ts
eval({ path: ".vibestudio/eval/audit.ts" });
inline_ui({ path: ".vibestudio/ui/audit-panel.tsx", props: { runId } });
feedback_custom({ path: ".vibestudio/ui/confirm-audit.tsx", title: "Confirm audit" });
```

## Call an API with a URL-bound credential

The general pattern: store a URL-bound credential once, then fetch through the
runtime credential proxy.

The `credentials.fetch(url, init, { credentialId })` wrapper (which returns a
`Response`) is part of the portable runtime surface from `@workspace/runtime`;
it works from server-side eval, panels, workers, and DOs. In eval, import
`credentials` from `@workspace/runtime` and use `credentials.fetch` for external
requests that need stored credentials:

```tsx
import { credentials } from "@workspace/runtime";

const credential = await credentials.store({
  label: "Notion",
  audience: [{ url: "https://api.notion.com", match: "origin" }],
  injection: { type: "header", name: "authorization", valueTemplate: "Bearer {token}" },
  material: { type: "bearer-token", token },
});

const response = await credentials.fetch(
  "https://api.notion.com/v1/search",
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Notion-Version": "2022-06-28",
    },
    body: JSON.stringify({ query: "meeting notes" }),
  },
  { credentialId: credential.id }
);
const results = await response.json();
```

See [RUNTIME_API.md](RUNTIME_API.md) for the full runtime surface. Works with any
configured provider; check
`await credentials.listStoredCredentials()` to see what's available.

## Request Access to a Custom Userland Resource

Use `approvals.request()` only when custom userland code owns a shared resource
and needs to grant another panel, worker, DO, or extension access to it. Vibestudio
verifies the issuer, shows the user a shell consent prompt, and manages any
remembered decision for the same issuer and stable `subject.id`.

Do not use this for normal agent work such as creating, editing, appending, or
removing files in the caller's context. The outer runtime/host permission model
already protects sensitive filesystem, browser, credential, git, and panel
operations where approval is required.

`approvals.request`/`approvals.revoke` come from the portable runtime surface
(`@workspace/runtime`) and bind to the live caller's verified issuer identity.
They work from server-side eval, panels, workers, and DOs:

```tsx
import { approvals } from "@workspace/runtime";

const decision = await approvals.request({
  subject: { id: "demo-report-service:send", label: "Report sending service" },
  title: "Allow report service access?",
  summary:
    "A custom report service wants to let this caller send reports through its shared backend.",
});

console.log(decision);
```

The default prompt lets the user allow once, allow for the current session,
trust the current code version, or deny. If you need a custom choice set, opt
into `promptOptions: "choices"`:

```tsx
import { approvals } from "@workspace/runtime";

const decision = await approvals.request({
  subject: { id: "demo-report-service:send", label: "Report sending service" },
  title: "Allow report service access?",
  summary:
    "A custom report service wants to let this caller send reports through its shared backend.",
  promptOptions: "choices",
  options: [
    { value: "allow", label: "Send", tone: "primary" },
    { value: "deny", label: "Cancel", tone: "danger" },
  ],
});

console.log(decision);
```

If the user dismisses the prompt, the result is `{ kind: "dismissed" }` and no
grant is stored. To forget a stored decision:

```tsx
import { approvals } from "@workspace/runtime";
await approvals.revoke("demo-report-service:send");
```

Do not use this for credentials, external browser opens, git writes, or project
imports; those built-in APIs have their own trust scopes. See
[RUNTIME_API.md](RUNTIME_API.md#userland-approval-prompts) for the full contract.

## Browser data (cookies/passwords/bookmarks/history/tabs)

`browserData` from `@workspace/runtime` is a **panel/component runtime**
capability: it invokes the manifest-selected `browserData` provider namespace,
whose extension only accepts **shell** callers. It does not resolve or invoke an
extension package directly. Server-side eval (caller kind `server`) cannot use
it — run browser-data work from panel code or an
`inline_ui`/`feedback_custom` component:

```tsx
import { browserData } from "@workspace/runtime";

const hosts = await browserData.listImportHosts();
const host = hosts.find((candidate) => candidate.connected);
if (host) {
  const sources = await browserData.listImportSources(host.hostId);
  const chrome = sources.find((source) => source.browser === "chrome");
  if (!chrome) throw new Error("Chrome is not available on the selected host");
  const job = await browserData.startImport({
    hostId: host.hostId,
    sourceId: chrome.sourceId,
    dataTypes: ["cookies", "bookmarks", "history"],
  });
  console.log("Import job:", job.jobId, job.phase);

  // Optional: recreate current source-browser HTTP(S) tabs as Vibestudio panels.
  const tabs = await browserData.listOpenTabs(host.hostId, chrome.sourceId);
  const opened = await browserData.openTabsAsPanels({
    hostId: host.hostId,
    sourceId: chrome.sourceId,
    selection: tabs.map((tab) => tab.tabId),
  });
  console.log("Opened tabs:", opened);
}

const bookmarks = await browserData.exportBookmarks("json");
```

Profiles and filesystem paths never enter userland. `startImport` is
deterministic for the same opaque host/source pair; reruns update changed
source records without duplicating canonical data. `openTabsAsPanels()` is
intentionally not idempotent; it creates panels each time it is called.

## Interactive Cookie Manager (Inline UI)

```
inline_ui({
  code: `
import { useState, useEffect } from "react";
import { Button, Flex, Text, Table, TextField } from "@radix-ui/themes";
import { browserData } from "@workspace/runtime";

export default function CookieManager({ props, chat }) {
  const [cookies, setCookies] = useState([]);
  const [filter, setFilter] = useState("");

  const load = () => browserData.getCookieSnapshot().then(({ cookies }) =>
    setCookies(filter
      ? cookies.filter(cookie => cookie.domain.includes(filter))
      : cookies)
  );
  useEffect(() => { load(); }, [filter]);

  const clearOrigin = async (origin) => {
    await browserData.clearCookiesForOrigin(origin);
    load();
  };

  return (
    <Flex direction="column" gap="2">
      <Flex gap="2" align="center">
        <TextField.Root placeholder="Filter by domain..." value={filter} onChange={e => setFilter(e.target.value)} style={{ flex: 1 }} />
      </Flex>
      <Text size="1" color="gray">{cookies.length} cookies</Text>
      <Table.Root size="1">
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeaderCell>Domain</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell>Name</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell>Expires</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell />
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {cookies.slice(0, 50).map(c => (
            <Table.Row key={[c.name, c.domain, c.path, c.partitionKey || ""].join("|")}>
              <Table.Cell><Text size="1">{c.domain}</Text></Table.Cell>
              <Table.Cell><Text size="1">{c.name}</Text></Table.Cell>
              <Table.Cell><Text size="1" color="gray">{c.expirationDate ? new Date(c.expirationDate * 1000).toLocaleDateString() : "session"}</Text></Table.Cell>
              <Table.Cell>
                <Button size="1" variant="ghost" color="red" onClick={() => clearOrigin((c.secure ? "https://" : "http://") + c.domain.replace(/^\\./, ""))}>
                  Clear site
                </Button>
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
    </Flex>
  );
}`,
  props: {}
})
```

## Query a DO-backed App Database and Show Results

For user-facing app data, call a Durable Object service that owns SQLite through
`this.sql`. There is no generic panel-side app database endpoint; expose narrow
methods such as `listTodos` and `upsertTodo` on the DO, then call those methods
from UI code. See
[workspace-dev/WORKERS.md](../workspace-dev/WORKERS.md#durable-object-backed-app-databases)
for the worker and manifest declaration.

```
inline_ui({
  code: `
import { useCallback, useEffect, useState } from "react";
import { Button, Flex, Text, Table, TextField } from "@radix-ui/themes";
import { rpc, workers } from "@workspace/runtime";

export default function TodoStoreView({ props = {} }) {
  const protocol = props.protocol || "example.todos.v1";
  const objectKey = props.objectKey || null;
  const [title, setTitle] = useState("");
  const [todos, setTodos] = useState([]);
  const [error, setError] = useState(null);

  const resolveStore = useCallback(async () => {
    const service = await workers.resolveService(protocol, objectKey);
    if (service.kind !== "durable-object") throw new Error("Expected DO service");
    return service;
  }, [protocol, objectKey]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const service = await resolveStore();
      setTodos(await rpc.call(service.targetId, "listTodos", []));
    } catch (e) { setError(e.message); }
  }, [resolveStore]);

  useEffect(() => { load(); }, [load]);

  const addTodo = useCallback(async () => {
    if (!title.trim()) return;
    setError(null);
    try {
      const service = await resolveStore();
      await rpc.call(service.targetId, "upsertTodo", [{ title: title.trim() }]);
      setTitle("");
      await load();
    } catch (e) { setError(e.message); }
  }, [load, resolveStore, title]);

  return (
    <Flex direction="column" gap="2">
      <Flex gap="2">
        <TextField.Root
          value={title}
          onChange={e => setTitle(e.target.value)}
          placeholder="New todo"
          style={{ flex: 1 }}
        />
        <Button size="1" onClick={addTodo}>Add</Button>
      </Flex>
      {error && <Text size="1" color="red">{error}</Text>}
      <Table.Root size="1">
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeaderCell>Title</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell>Status</Table.ColumnHeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {todos.map(todo => (
            <Table.Row key={todo.id}>
              <Table.Cell><Text size="2">{todo.title}</Text></Table.Cell>
              <Table.Cell><Text size="1">{todo.done ? "Done" : "Open"}</Text></Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
    </Flex>
  );
}`,
  props: { protocol: "example.todos.v1", objectKey: "project-123" }
})
```

## Open a Website and Import Its Cookies

`openPanel` works from server-side eval, panels, workers, and DOs. `browserData`
goes through the manifest-declared browser-data broker, so this combined
cookie-import recipe still runs from panel code or an
`inline_ui`/`feedback_custom` component:

```tsx
import { openPanel } from "@workspace/runtime";
import { browserData } from "@workspace/runtime";

// Open the site in a browser panel
const handle = await openPanel("https://github.com");

// Import cookies from a trusted host's opaque Chrome source.
const hosts = await browserData.listImportHosts();
const host = hosts.find((candidate) => candidate.connected);
if (host) {
  const sources = await browserData.listImportSources(host.hostId);
  const chrome = sources.find((source) => source.browser === "chrome");
  if (!chrome) throw new Error("Chrome is not available on the selected host");
  await browserData.startImport({
    hostId: host.hostId,
    sourceId: chrome.sourceId,
    dataTypes: ["cookies"],
  });
  // BrowserDataDO is authoritative; Electron reconciles its cookie projection.
}
```
