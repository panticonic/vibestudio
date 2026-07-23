import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Card, Flex, Heading, Spinner, Text, TextField } from "@radix-ui/themes";
import { BookmarkIcon, Pencil1Icon, ReloadIcon, TrashIcon } from "@radix-ui/react-icons";
import type { StoredBookmark } from "@vibestudio/browser-data";
import { browserData, openPanel } from "@workspace/runtime";
import { AboutPage, AboutThemeRoot, Section } from "../../packages/about-shared/ui";

function BookmarksPage() {
  const [bookmarks, setBookmarks] = useState<StoredBookmark[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setBookmarks(await browserData.searchBookmarks(""));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => void load(), [load]);
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle
      ? bookmarks.filter(
          (bookmark) =>
            bookmark.title.toLowerCase().includes(needle) ||
            bookmark.url?.toLowerCase().includes(needle)
        )
      : bookmarks;
  }, [bookmarks, query]);

  return (
    <AboutPage
      icon={<BookmarkIcon />}
      title="Bookmarks"
      subtitle="Websites saved in this browser environment"
      maxWidth={900}
      actions={
        <Button variant="soft" disabled={loading} onClick={() => void load()}>
          <ReloadIcon /> Refresh
        </Button>
      }
    >
      <Section>
        <TextField.Root
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="Search bookmarks"
          aria-label="Search bookmarks"
        />
      </Section>
      {loading && bookmarks.length === 0 ? <Spinner /> : null}
      {error ? <Text color="red">{error}</Text> : null}
      {!loading && visible.length === 0 ? <Text color="gray">No bookmarks found.</Text> : null}
      <Flex direction="column" gap="2">
        {visible.map((bookmark) => (
          <Card key={bookmark.id}>
            <Flex justify="between" align="center" gap="3">
              <Flex direction="column" style={{ minWidth: 0 }}>
                <Heading size="3">{bookmark.title}</Heading>
                <Text size="1" color="gray" truncate>
                  {bookmark.url ?? bookmark.folder_path}
                </Text>
              </Flex>
              <Flex gap="2">
                {bookmark.url ? (
                  <Button
                    size="1"
                    onClick={() => void openPanel(bookmark.url!, { focus: true })}
                  >
                    Open
                  </Button>
                ) : null}
                <Button
                  size="1"
                  variant="soft"
                  onClick={() => {
                    const title = window.prompt("Bookmark title", bookmark.title);
                    if (title === null || !title.trim() || title.trim() === bookmark.title) return;
                    void browserData
                      .updateBookmark(bookmark.id, { title: title.trim() })
                      .then(() =>
                        setBookmarks((current) =>
                          current.map((item) =>
                            item.id === bookmark.id ? { ...item, title: title.trim() } : item
                          )
                        )
                      )
                      .catch((cause) =>
                        setError(cause instanceof Error ? cause.message : String(cause))
                      );
                  }}
                >
                  <Pencil1Icon /> Edit
                </Button>
                <Button
                  size="1"
                  color="red"
                  variant="soft"
                  onClick={() =>
                    void browserData
                      .deleteBookmark(bookmark.id)
                      .then(() =>
                        setBookmarks((current) =>
                          current.filter((item) => item.id !== bookmark.id)
                        )
                      )
                  }
                >
                  <TrashIcon /> Remove
                </Button>
              </Flex>
            </Flex>
          </Card>
        ))}
      </Flex>
    </AboutPage>
  );
}

export default function AboutPanelRoot() {
  return (
    <AboutThemeRoot>
      <BookmarksPage />
    </AboutThemeRoot>
  );
}
