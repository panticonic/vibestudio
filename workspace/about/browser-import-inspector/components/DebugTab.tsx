import { Badge, Button, Callout, Card, Flex, Heading, Spinner, Text } from "@radix-ui/themes";
import type { ImportSourceSelection } from "./ImportSourceRail";
import { browserData, useAsync } from "../useBrowserData";

export function DebugTab(props: { selection: ImportSourceSelection | null }) {
  const diagnostics = useAsync(() => browserData.getCookieProjectionDiagnostics(), []);
  return (
    <Flex direction="column" gap="4" p="4" style={{ overflowY: "auto", height: "100%" }}>
      <Card>
        <Flex justify="between" align="center">
          <Heading size="2">Cookie projection</Heading>
          {diagnostics.state.data && (
            <Badge color={diagnostics.state.data.converged ? "green" : "amber"}>
              {diagnostics.state.data.converged ? "Converged" : "Reconciling"}
            </Badge>
          )}
        </Flex>
        {diagnostics.state.status === "loading" && <Spinner size="1" />}
        {diagnostics.state.error && <Text color="red">{diagnostics.state.error}</Text>}
        {diagnostics.state.data && (
          <Flex direction="column" gap="1" mt="2">
            <Text size="1">Canonical revision: {diagnostics.state.data.revision}</Text>
            <Text size="1">Pending host mutations: {diagnostics.state.data.outboxDepth}</Text>
            <Text size="1">Mismatches: {diagnostics.state.data.mismatchCount}</Text>
            {diagnostics.state.data.lastError && (
              <Callout.Root color="red" size="1">
                <Callout.Text>{diagnostics.state.data.lastError}</Callout.Text>
              </Callout.Root>
            )}
          </Flex>
        )}
        <Flex gap="2" mt="3" wrap="wrap">
          <Button
            size="1"
            color="red"
            variant="soft"
            onClick={() => {
              if (!window.confirm("End this browser session and remove all session cookies?"))
                return;
              void browserData.endBrowserSession().then(() => diagnostics.reload());
            }}
          >
            End browser session
          </Button>
          <Button
            size="1"
            color="red"
            variant="soft"
            onClick={() => {
              if (!window.confirm("Clear every cookie in this browser environment?")) return;
              void browserData.clearAllCookies().then(() => diagnostics.reload());
            }}
          >
            Clear all cookies
          </Button>
        </Flex>
      </Card>

      <Card>
        <Heading size="2">Import source diagnostics</Heading>
        {props.selection ? (
          <>
            <Text size="2" as="div">{props.selection.source.displayName}</Text>
            <Text size="1" color="gray" as="div">
              {props.selection.host.displayName} · {props.selection.source.status}
            </Text>
            {props.selection.source.warnings.length === 0 ? (
              <Text size="1" color="gray" as="div" mt="2">No provider warnings.</Text>
            ) : (
              props.selection.source.warnings.map((warning) => (
                <Callout.Root color="amber" size="1" mt="2" key={warning}>
                  <Callout.Text>{warning}</Callout.Text>
                </Callout.Root>
              ))
            )}
          </>
        ) : (
          <Text size="1" color="gray">Choose a device and browser to see provider diagnostics.</Text>
        )}
      </Card>
    </Flex>
  );
}
