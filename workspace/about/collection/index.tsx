/**
 * Collection — a generic parent panel that holds other panels.
 *
 * It does three things: it gives a set of child panels a name and a place in the
 * tree, it lets the user write notes on the collection and on each member, and
 * it launches agentic debug sessions (a child `panels/chat`) seeded with that
 * context so an agent can investigate or automate the panels it holds.
 *
 * Anything can create one — `openPanel("about/collection", { name, stateArgs })`
 * — and then parent panels under it. The browser migration panel uses it to group
 * the tabs of one source browser window.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Card,
  Flex,
  Heading,
  IconButton,
  Separator,
  Spinner,
  Text,
  TextArea,
  TextField,
  Theme,
  Tooltip,
} from "@radix-ui/themes";
import {
  ChatBubbleIcon,
  Cross2Icon,
  EnterIcon,
  MagicWandIcon,
  Pencil1Icon,
  ReloadIcon,
} from "@radix-ui/react-icons";
import "@radix-ui/themes/styles.css";
import "@workspace/ui/tokens.css";
import { openPanel, panel, panelTree, type PanelHandle } from "@workspace/runtime";
import { usePanelTheme, useStateArgs } from "@workspace/react";
import {
  buildCollectionDebugPrompt,
  pruneNotes,
  withMemberNote,
  type CollectionMember,
  type CollectionStateArgs,
} from "./collection";

export default function CollectionPanel() {
  const theme = usePanelTheme();
  const stateArgs = useStateArgs<CollectionStateArgs>();
  const [title, setTitle] = useState(stateArgs.title ?? "Collection");
  const [editingTitle, setEditingTitle] = useState(false);
  const [note, setNote] = useState(stateArgs.note ?? "");
  const [notes, setNotes] = useState<Record<string, string>>(stateArgs.notes ?? {});
  const [members, setMembers] = useState<PanelHandle[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [launching, setLaunching] = useState<string | null>(null);

  // The creator passes the label through stateArgs, not `panelTree.create`'s
  // `name` — that option mints the panel's id segment, not its display title.
  const titledFor = useRef<string | null>(null);
  useEffect(() => {
    const wanted = stateArgs.title?.trim();
    if (!wanted || titledFor.current === wanted) return;
    titledFor.current = wanted;
    setTitle(wanted);
    void panel.setTitle(wanted, { explicit: true });
  }, [stateArgs.title]);

  const refresh = useCallback(async () => {
    try {
      const children = await panelTree.self().children();
      setMembers(children);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const unsubscribe = panel.onChildCreated(() => void refresh());
    return unsubscribe;
  }, [refresh]);

  // Members change through actions taken in other panels too (a child closing,
  // an agent opening one), so poll gently in addition to the creation event.
  useEffect(() => {
    const timer = setInterval(() => void refresh(), 4_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const rows: CollectionMember[] = useMemo(
    () =>
      (members ?? []).map((member) => ({
        id: member.id,
        title: member.title || member.source,
        source: member.source,
        ...(notes[member.id] ? { note: notes[member.id] } : {}),
      })),
    [members, notes]
  );

  const persist = (patch: Partial<CollectionStateArgs>) => {
    void panel.stateArgs.set({ ...panel.stateArgs.get(), ...patch });
  };

  const commitTitle = () => {
    const next = title.trim() || "Collection";
    setTitle(next);
    setEditingTitle(false);
    persist({ title: next });
    void panel.setTitle(next, { explicit: true });
  };

  const setMemberNote = (panelId: string, value: string) => {
    setNotes((current) => {
      const next = withMemberNote(current, panelId, value);
      persist({ notes: next });
      return next;
    });
  };

  // Notes for panels that have gone away would otherwise accumulate in stateArgs.
  const prunedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!members) return;
    const key = members.map((member) => member.id).sort().join(",");
    if (prunedFor.current === key) return;
    prunedFor.current = key;
    const next = pruneNotes(notes, members.map((member) => member.id));
    if (Object.keys(next).length !== Object.keys(notes).length) {
      setNotes(next);
      persist({ notes: next });
    }
  }, [members, notes]);

  const startDebugSession = async (focusId?: string) => {
    setLaunching(focusId ?? "collection");
    try {
      const prompt = buildCollectionDebugPrompt({
        title,
        ...(note.trim() ? { note } : {}),
        ...(stateArgs.origin ? { origin: stateArgs.origin } : {}),
        members: rows,
        ...(focusId ? { focusId } : {}),
      });
      const target = focusId ? rows.find((row) => row.id === focusId) : undefined;
      await openPanel("panels/chat", {
        parentId: panel.slotId,
        focus: true,
        title: `debug · ${target ? target.title : title}`.slice(0, 80),
        stateArgs: { initialPrompt: prompt },
      });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLaunching(null);
    }
  };

  const act = async (action: () => Promise<unknown>) => {
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      await refresh();
    }
  };

  return (
    <Theme appearance={theme} accentColor="iris" radius="medium">
      <Flex direction="column" gap="3" p="4" style={{ minHeight: "100vh" }}>
        <Flex justify="between" align="center" gap="2">
          {editingTitle ? (
            <TextField.Root
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.currentTarget.value)}
              onBlur={commitTitle}
              onKeyDown={(event) => {
                if (event.key === "Enter") commitTitle();
                if (event.key === "Escape") {
                  setTitle(stateArgs.title ?? "Collection");
                  setEditingTitle(false);
                }
              }}
              style={{ flex: 1 }}
            />
          ) : (
            <Flex align="center" gap="2" style={{ minWidth: 0 }}>
              <Heading size="5" truncate>
                {title}
              </Heading>
              <IconButton
                size="1"
                variant="ghost"
                aria-label="Rename collection"
                onClick={() => setEditingTitle(true)}
              >
                <Pencil1Icon />
              </IconButton>
            </Flex>
          )}
          <Flex align="center" gap="2">
            <IconButton size="1" variant="ghost" aria-label="Refresh" onClick={() => void refresh()}>
              <ReloadIcon />
            </IconButton>
            <Button
              size="2"
              onClick={() => void startDebugSession()}
              disabled={launching !== null}
            >
              {launching === "collection" ? <Spinner size="1" /> : <MagicWandIcon />} Debug session
            </Button>
          </Flex>
        </Flex>

        {stateArgs.origin && (
          <Text size="1" color="gray">
            From {stateArgs.origin}
          </Text>
        )}

        <TextArea
          placeholder="Notes about this collection — what it is for, what you are trying to work out. A debug session gets these too."
          value={note}
          onChange={(event) => setNote(event.currentTarget.value)}
          onBlur={() => persist({ note })}
          rows={3}
        />

        {error && (
          <Text color="red" size="1">
            {error}
          </Text>
        )}

        <Flex align="center" gap="2">
          <Heading size="3">Panels</Heading>
          {members && <Badge color="gray">{members.length}</Badge>}
        </Flex>

        {members === null && <Spinner size="2" />}
        {members?.length === 0 && (
          <Card>
            <Text size="2" color="gray">
              Nothing collected yet. Panels opened under this one appear here — and a debug session
              can investigate or automate them once they do.
            </Text>
          </Card>
        )}

        <Flex direction="column" gap="2">
          {rows.map((row, index) => (
            <Card key={row.id}>
              <Flex align="center" gap="2">
                <Box style={{ minWidth: 0, flex: 1 }}>
                  <Text as="div" size="2" weight="medium" truncate>
                    {row.title}
                  </Text>
                  <Text as="div" size="1" color="gray" truncate>
                    {row.source}
                  </Text>
                </Box>
                <Tooltip content="Focus this panel">
                  <IconButton
                    size="1"
                    variant="soft"
                    aria-label="Focus panel"
                    onClick={() => void act(() => (members?.[index] ?? panelTree.get(row.id)).focus())}
                  >
                    <EnterIcon />
                  </IconButton>
                </Tooltip>
                <Tooltip content="Debug session for just this panel">
                  <IconButton
                    size="1"
                    variant="soft"
                    aria-label="Investigate panel"
                    disabled={launching !== null}
                    onClick={() => void startDebugSession(row.id)}
                  >
                    {launching === row.id ? <Spinner size="1" /> : <ChatBubbleIcon />}
                  </IconButton>
                </Tooltip>
                <Tooltip content="Close this panel">
                  <IconButton
                    size="1"
                    variant="soft"
                    color="red"
                    aria-label="Close panel"
                    onClick={() => void act(() => (members?.[index] ?? panelTree.get(row.id)).close())}
                  >
                    <Cross2Icon />
                  </IconButton>
                </Tooltip>
              </Flex>
              <Separator size="4" my="2" />
              <TextField.Root
                size="1"
                placeholder="Note on this panel"
                defaultValue={notes[row.id] ?? ""}
                onBlur={(event) => setMemberNote(row.id, event.currentTarget.value)}
              />
            </Card>
          ))}
        </Flex>
      </Flex>
    </Theme>
  );
}
