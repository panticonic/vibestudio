# Inline UI

Use inline UI for persistent, rich components in the chat transcript and for
self-contained workflows whose controls can call trusted helpers directly.

## When To Use It

Use a UI instead of plain text when the task has:

- Multiple steps the user can complete independently.
- Links or resources the user may open inside Vibestudio or externally.
- Progress, status, or retry states.
- Choices where a card, table, segmented control, or checklist is clearer than
  prose.

For provider setup, OAuth, imports, and similar workflows, prefer `inline_ui`
when the component can perform the operation. Keep browser actions, trusted
prompts, progress, verification, errors, and retry in that component. Do not
return selections to the agent solely so it can construct the corresponding
helper call. Use `feedback_custom` only when the agent genuinely needs the
returned decision for subsequent reasoning.

You can send raw TSX with `code`, or put the component in a context-relative
file and call `inline_ui({ path: ".vibestudio/ui/review.tsx", props: {...} })`.
File-loaded components support static relative imports from that file and infer
bare package imports from the nearest `package.json` when possible. Use
`imports` for explicit package versions. Package-local aliases from
`package.json` `imports` and simple `tsconfig.json` paths are supported.

Pass a stable `id` when the UI represents one evolving surface rather than a
new historical item:

```ts
inline_ui({
  id: "setup-overview",
  path: "skills/onboarding/SetupHub.tsx",
  props: overview,
});
```

A later `inline_ui` call from the same participant with that ID replaces the
projected card and gives it the new render time, which moves it to the newest
position in the transcript. Components receive that identity as
`inlineUi: { id, renderedAt }`; use `renderedAt` as an effect dependency when a
stable-ID rerender should trigger a data refresh. Omit `id` when each render
should remain as a separate historical card. The channel event persists
`source` and `props`; component-local React state is not part of that event.

Inline UI is persisted as a typed `ui.inline_rendered` event in the PubSub
channel log. Do not emulate it with `chat.publish("message", { contentType:
"inline_ui" })`; use the `inline_ui` tool so the transcript, replay, and agent
state all see the same canonical event.

## Component Rules

- Components must `export default`.
- Root with unframed layout such as `<Flex direction="column" gap="3" p="2">`.
- Do not wrap the entire component in a top-level card; the host already frames
  feedback components.
- Use Radix primitives from `@radix-ui/themes` and icons from
  `@radix-ui/react-icons`.
- Design against the component's own card width, not the browser viewport.
  Panel splits can be narrow on a wide desktop, so do not use Radix breakpoint
  objects such as `columns={{ initial: "1", sm: "2" }}` for primary layout.
  Prefer an intrinsic grid such as
  `style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 16rem), 1fr))" }}`.
- Give root layouts `style={{ width: "100%", minWidth: 0 }}`, wrap action rows,
  and render explanatory text as a block (`as="div"` or `as="p"`). Controls and
  prose must remain usable at a 320px card width without horizontal scrolling.
- Use `openPanel(url, { focus: true })` for internal browser-panel
  deep links.
- Use `openExternal(url)` for system-browser links. This is approval-gated.
- OAuth authorize URLs should use `openExternal(url, { expectedRedirectUri })`.
- Event handlers may call imported trusted skill/runtime helpers directly.
- Await asynchronous helpers inside a handler that catches failure. Disable only
  the action in flight; an approval prompt or panel boot must not block unrelated
  controls.
- Surface pending, failure, retry, and verified states locally.
- Secrets must be collected by host-owned credential prompts, never ordinary
  React inputs or component state.

## Panel Scope

Components receive `{ props, chat, scope, scopes, inlineUi }`. Serializable values placed
in `scope` persist in the browser's panel-local `localStorage`; large values may
spill into the workspace blob store. The scope is shared by inline UI, feedback,
and the action bar in that panel. It is useful for local UI state across reloads,
but it is not channel-shared state and does not replace persisted inline-UI
props when other panels or devices must see the update.

## Workflow Link Pattern

```tsx
import { useState } from "react";
import { Button, Flex, Text } from "@radix-ui/themes";
import { GlobeIcon, OpenInNewWindowIcon } from "@radix-ui/react-icons";
import { openPanel, openExternal } from "@workspace/runtime";

export default function LinkActions({ props = {} }) {
  const url = props.url ?? "https://console.cloud.google.com/apis/credentials";
  const [status, setStatus] = useState({});

  async function run(kind, action) {
    setStatus((current) => ({ ...current, [kind]: "pending" }));
    try {
      await action();
      setStatus((current) => ({ ...current, [kind]: "done" }));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setStatus((current) => ({ ...current, [kind]: message }));
    }
  }

  const error = [status.internal, status.external].find(
    (value) => value && value !== "pending" && value !== "done"
  );

  return (
    <Flex direction="column" gap="2" p="2" style={{ width: "100%", minWidth: 0 }}>
      <Flex align="center" justify="between" gap="3" wrap="wrap">
        <Text size="2" weight="medium">
          {props.label ?? "Open setup page"}
        </Text>
        <Flex gap="2">
          <Button
            size="1"
            variant="soft"
            disabled={status.internal === "pending"}
            onClick={async () => run("internal", () => openPanel(url, { focus: true }))}
          >
            <GlobeIcon /> {status.internal === "pending" ? "Opening…" : "Internal"}
          </Button>
          <Button
            size="1"
            variant="soft"
            disabled={status.external === "pending"}
            onClick={async () => run("external", () => openExternal(url))}
          >
            <OpenInNewWindowIcon />{" "}
            {status.external === "pending" ? "Awaiting approval…" : "External"}
          </Button>
        </Flex>
      </Flex>
      {error && (
        <Text size="1" color="red">
          {error} — retry when ready.
        </Text>
      )}
    </Flex>
  );
}
```

## Checklist Pattern

Use a checklist when the user must complete steps in another website or app.
Keep each item short and put links/buttons next to the item, not in a paragraph
below it.

```tsx
import { useState } from "react";
import { Badge, Box, Button, Checkbox, Flex, Text } from "@radix-ui/themes";
import { GlobeIcon, OpenInNewWindowIcon } from "@radix-ui/react-icons";
import { openPanel, openExternal } from "@workspace/runtime";

const steps = [
  ["project", "Create project", "https://console.cloud.google.com/projectcreate"],
  ["credentials", "Open credentials", "https://console.cloud.google.com/apis/credentials"],
];

export default function SetupChecklist() {
  const [done, setDone] = useState({});
  const [status, setStatus] = useState({});
  const count = steps.filter(([id]) => done[id]).length;

  async function run(key, action) {
    setStatus((current) => ({ ...current, [key]: "pending" }));
    try {
      await action();
      setStatus((current) => ({ ...current, [key]: "done" }));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setStatus((current) => ({ ...current, [key]: message }));
    }
  }
  const error = Object.values(status).find((value) => value !== "pending" && value !== "done");

  return (
    <Flex direction="column" gap="3" p="2">
      <Flex justify="between" align="center">
        <Text size="2" weight="bold">
          Setup checklist
        </Text>
        <Badge variant="soft">
          {count}/{steps.length}
        </Badge>
      </Flex>
      {steps.map(([id, label, url]) => (
        <Box key={id} style={{ border: "1px solid var(--gray-6)", borderRadius: 8, padding: 10 }}>
          <Flex align="center" justify="between" gap="3" wrap="wrap">
            <Flex align="center" gap="2">
              <Checkbox
                checked={Boolean(done[id])}
                onCheckedChange={(checked) =>
                  setDone((prev) => ({ ...prev, [id]: checked === true }))
                }
              />
              <Text size="2">{label}</Text>
            </Flex>
            <Flex gap="2">
              <Button
                size="1"
                variant="soft"
                disabled={status[`${id}:internal`] === "pending"}
                onClick={async () => run(`${id}:internal`, () => openPanel(url, { focus: true }))}
              >
                <GlobeIcon /> Internal
              </Button>
              <Button
                size="1"
                variant="soft"
                disabled={status[`${id}:external`] === "pending"}
                onClick={async () => run(`${id}:external`, () => openExternal(url))}
              >
                <OpenInNewWindowIcon /> External
              </Button>
            </Flex>
          </Flex>
        </Box>
      ))}
      {error && (
        <Text size="1" color="red">
          {error} — retry the action when ready.
        </Text>
      )}
    </Flex>
  );
}
```
