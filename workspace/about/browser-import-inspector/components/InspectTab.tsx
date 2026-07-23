import { useState } from "react";
import {
  Badge,
  Button,
  Callout,
  Card,
  Flex,
  Heading,
  Spinner,
  Table,
  Text,
  TextField,
} from "@radix-ui/themes";
import type {
  StoredHistory,
  StoredPassword,
} from "@vibestudio/browser-data/client";
import { browserData, relativeTime, useAsync } from "../useBrowserData";

export function InspectTab(props: { now: number }) {
  return (
    <Flex direction="column" gap="4" p="4" style={{ overflowY: "auto", height: "100%" }}>
      <SiteData />
      <PasswordList />
      <HistoryList now={props.now} />
    </Flex>
  );
}

function SiteData() {
  const [input, setInput] = useState("");
  const [origin, setOrigin] = useState("");
  const summary = useAsync(
    () =>
      origin
        ? browserData.getCookieSiteSummary(origin)
        : Promise.resolve({ origin: "", cookieCount: 0, revision: 0 }),
    [origin]
  );
  const clear = async () => {
    await browserData.clearCookiesForOrigin(origin);
    summary.reload();
  };
  return (
    <Card>
      <Heading size="2" mb="2">Site data</Heading>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          try {
            setOrigin(new URL(input.includes("://") ? input : `https://${input}`).origin);
          } catch {
            setOrigin("");
          }
        }}
      >
        <Flex gap="2">
          <TextField.Root
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="example.com"
            style={{ flex: 1 }}
          />
          <Button type="submit" variant="soft">Inspect</Button>
        </Flex>
      </form>
      {summary.state.status === "loading" && <Spinner size="1" />}
      {summary.state.error && <Callout.Root color="red" mt="2"><Callout.Text>{summary.state.error}</Callout.Text></Callout.Root>}
      {origin && summary.state.data && (
        <Flex justify="between" align="center" mt="3">
          <Text size="2">
            {summary.state.data.cookieCount} {summary.state.data.cookieCount === 1 ? "cookie" : "cookies"}
          </Text>
          <Button size="1" color="red" variant="soft" disabled={summary.state.data.cookieCount === 0} onClick={clear}>
            Clear site data
          </Button>
        </Flex>
      )}
    </Card>
  );
}

function PasswordList() {
  const passwords = useAsync<StoredPassword[]>(() => browserData.getPasswords(), []);
  return (
    <Card>
      <Heading size="2" mb="2">Saved passwords</Heading>
      {passwords.state.status === "loading" && <Spinner size="1" />}
      {passwords.state.error && <Text color="red" size="1">{passwords.state.error}</Text>}
      <Flex direction="column" gap="1">
        {passwords.state.data?.map((password) => (
          <Flex key={password.id} justify="between" gap="2">
            <Text size="2">{password.origin_url}</Text>
            <Text size="2" color="gray">{password.username}</Text>
          </Flex>
        ))}
      </Flex>
      {passwords.state.status === "ready" && passwords.state.data?.length === 0 && (
        <Text size="1" color="gray">No saved passwords.</Text>
      )}
    </Card>
  );
}

function HistoryList(props: { now: number }) {
  const history = useAsync<StoredHistory[]>(() => browserData.getHistory({ limit: 100 }), []);
  return (
    <Card>
      <Heading size="2" mb="2">Recent history</Heading>
      {history.state.status === "loading" && <Spinner size="1" />}
      {history.state.error && <Text color="red" size="1">{history.state.error}</Text>}
      <Table.Root size="1">
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeaderCell>Page</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell>Visits</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell>Last visit</Table.ColumnHeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {history.state.data?.map((entry) => (
            <Table.Row key={entry.id}>
              <Table.RowHeaderCell>
                <Text truncate style={{ maxWidth: 440 }}>{entry.title || entry.url}</Text>
              </Table.RowHeaderCell>
              <Table.Cell><Badge color="gray">{entry.visit_count}</Badge></Table.Cell>
              <Table.Cell>{relativeTime(entry.last_visit, props.now)}</Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
    </Card>
  );
}
