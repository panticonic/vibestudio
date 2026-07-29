import { Badge, Box, Button, Card, Flex, Text, TextField } from "@radix-ui/themes";
import { useMemo, useState } from "react";
import type {
  TemplateCatalogSnapshot,
  TemplateRegistryEntry,
} from "@workspace/template-registry";
import { templateCatalogInteraction, templateUrlInteraction } from "./routing";

interface TemplateCatalogProps {
  props: { catalog?: TemplateCatalogSnapshot };
  chat: {
    send: (content: string, options?: { metadata?: Record<string, unknown> }) => Promise<unknown>;
  };
}

function validTemplateUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * A presentation-only catalog. Choosing an entry never resolves or installs it:
 * the structured interaction is routed to the userland composer by onboarding.
 */
export default function TemplateCatalog({ props, chat }: TemplateCatalogProps) {
  const [query, setQuery] = useState("");
  const [url, setUrl] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const catalog = props.catalog;
  const entries = catalog?.entries ?? [];
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return entries;
    return entries.filter((entry) =>
      [entry.name, entry.description, ...entry.tags].join(" ").toLocaleLowerCase().includes(needle)
    );
  }, [entries, query]);

  async function send(entry: TemplateRegistryEntry) {
    if (!catalog) {
      setError("Refresh the verified template catalog before choosing a template.");
      return;
    }
    setPending(entry.id);
    setError(null);
    try {
      await chat.send(`Add the ${entry.name} template`, {
        metadata: {
          interaction: templateCatalogInteraction(entry.id, catalog.revision),
        },
      });
    } catch {
      setError(`Couldn't ask to add the ${entry.name} template. Try again.`);
    } finally {
      setPending(null);
    }
  }

  async function sendUrl() {
    const value = url.trim();
    if (!validTemplateUrl(value)) {
      setError("Enter a full web address for a template.");
      return;
    }
    setPending("url");
    setError(null);
    try {
      await chat.send("Add a template from this address", {
        metadata: { interaction: templateUrlInteraction(value) },
      });
      setUrl("");
    } catch {
      setError("Couldn't ask to add that template. Try again.");
    } finally {
      setPending(null);
    }
  }

  return (
    <Flex direction="column" gap="3" aria-label="Template catalog">
      <Box>
        <Text as="div" size="3" weight="bold">
          Add to your workspace
        </Text>
        <Text as="div" size="2" color="gray">
          Choose a template, or use an address you already have. You’ll review what changes first.
        </Text>
        {catalog ? (
          <Text as="div" size="1" color={catalog.stale ? "orange" : "gray"}>
            Registry {catalog.revision}
            {catalog.stale ? " · cached; refresh to check for new promotions" : ""}
          </Text>
        ) : null}
      </Box>
      <TextField.Root
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search templates"
        aria-label="Search templates"
      />
      <Flex direction="column" gap="2">
        {visible.map((entry) => (
          <Card key={entry.id} size="1">
            <Flex align="start" justify="between" gap="3" wrap="wrap">
              <Box style={{ minWidth: 0, flex: "1 1 190px" }}>
                <Text as="div" size="2" weight="medium">
                  {entry.name} template
                </Text>
                <Text as="div" size="1" color="gray">
                  {entry.description}
                </Text>
                <Flex gap="1" mt="2" wrap="wrap">
                  {entry.tags.map((tag) => (
                    <Badge key={tag} size="1" color="gray" variant="soft">
                      {tag}
                    </Badge>
                  ))}
                  {entry.recommended ? (
                    <Badge size="1" color="blue" variant="soft">
                      Recommended
                    </Badge>
                  ) : null}
                </Flex>
              </Box>
              <Button size="1" disabled={pending !== null} onClick={() => void send(entry)}>
                {pending === entry.id ? "Asking…" : "Add"}
              </Button>
            </Flex>
          </Card>
        ))}
        {visible.length === 0 ? (
          <Text size="2" color="gray">
            {entries.length === 0
              ? "No verified template catalog is available. Refresh it, or use a template address below."
              : "No templates match that search."}
          </Text>
        ) : null}
      </Flex>
      <Card size="1">
        <Flex direction="column" gap="2">
          <Text size="2" weight="medium">
            Use a template address
          </Text>
          <Flex gap="2" wrap="wrap">
            <Box style={{ minWidth: 0, flex: "1 1 220px" }}>
              <TextField.Root
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://github.com/you/your-template"
                aria-label="Template address"
              />
            </Box>
            <Button size="1" disabled={pending !== null || !url.trim()} onClick={() => void sendUrl()}>
              {pending === "url" ? "Asking…" : "Add"}
            </Button>
          </Flex>
        </Flex>
      </Card>
      {error ? (
        <Text role="alert" size="1" color="red">
          {error}
        </Text>
      ) : null}
    </Flex>
  );
}
