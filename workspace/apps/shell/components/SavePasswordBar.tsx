import { useState, useEffect, useCallback, useRef } from "react";
import { Flex, Text, Button, Callout } from "@radix-ui/themes";
import { useShellEvent } from "../shell/useShellEvent";
import { autofill } from "../shell/client";

interface SavePromptData {
  panelId: string;
  origin: string;
  username: string;
  isUpdate: boolean;
}

interface SavePasswordBarProps {
  visiblePanelId: string | null;
}

export function SavePasswordBar({ visiblePanelId }: SavePasswordBarProps) {
  // Map of panelId -> prompt data; supports background panels queueing prompts
  const [prompts, setPrompts] = useState<Map<string, SavePromptData>>(new Map());
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useShellEvent(
    "autofill:save-prompt",
    useCallback((data: SavePromptData) => {
      setConfirmed(false);
      setSaveError(null);
      setPrompts((prev) => {
        const next = new Map(prev);
        next.set(data.panelId, data);
        return next;
      });
    }, [])
  );

  // The prompt for the currently visible panel (if any)
  const prompt = visiblePanelId ? (prompts.get(visiblePanelId) ?? null) : null;

  // Auto-dismiss each prompt after 60 seconds from when it was created
  // We track active timers per panelId
  const timerCleanups = useRef<Map<string, () => void>>(new Map());

  useEffect(() => {
    for (const [panelId, _data] of prompts) {
      if (timerCleanups.current.has(panelId)) continue; // already has a timer
      const timer = setTimeout(() => {
        void autofill
          .confirmSave(panelId, "dismiss")
          .catch((err: unknown) => console.warn("[SavePasswordBar] Dismiss failed:", err));
        setPrompts((prev) => {
          const next = new Map(prev);
          next.delete(panelId);
          return next;
        });
        timerCleanups.current.delete(panelId);
      }, 60000);
      const cleanup = () => {
        clearTimeout(timer);
        timerCleanups.current.delete(panelId);
      };
      timerCleanups.current.set(panelId, cleanup);
    }

    // Clean up timers for removed prompts
    for (const [panelId, cleanup] of timerCleanups.current) {
      if (!prompts.has(panelId)) {
        cleanup();
      }
    }
  }, [prompts]);

  // Clean up all timers on unmount
  useEffect(() => {
    return () => {
      for (const cleanup of timerCleanups.current.values()) {
        cleanup();
      }
    };
  }, []);

  // Show confirmation briefly then hide
  useEffect(() => {
    if (!confirmed) return;
    const timer = setTimeout(() => {
      setConfirmed(false);
    }, 1500);
    return () => clearTimeout(timer);
  }, [confirmed]);

  if (confirmed) {
    return (
      <Flex
        data-shell-top-chrome="save-password-bar"
        align="center"
        px="3"
        py="2"
        style={{
          backgroundColor: "var(--intent-success-surface)",
          borderBottom: "1px solid var(--intent-success-border)",
          flexShrink: 0,
        }}
      >
        <Text size="2" style={{ color: "var(--intent-success)" }}>
          Password saved
        </Text>
      </Flex>
    );
  }

  if (!prompt) return null;

  const removePrompt = (panelId: string) => {
    setPrompts((prev) => {
      const next = new Map(prev);
      next.delete(panelId);
      return next;
    });
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await autofill.confirmSave(prompt.panelId, "save");
      removePrompt(prompt.panelId);
      setConfirmed(true);
    } catch (err) {
      console.error("[SavePasswordBar] Save failed:", err);
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleNever = () => {
    void autofill
      .confirmSave(prompt.panelId, "never")
      .catch((err: unknown) => console.warn("[SavePasswordBar] Never-save failed:", err));
    removePrompt(prompt.panelId);
  };

  const handleDismiss = () => {
    void autofill
      .confirmSave(prompt.panelId, "dismiss")
      .catch((err: unknown) => console.warn("[SavePasswordBar] Dismiss failed:", err));
    removePrompt(prompt.panelId);
  };

  let hostname: string;
  try {
    hostname = new URL(prompt.origin).hostname;
  } catch {
    hostname = prompt.origin;
  }

  const message = prompt.isUpdate
    ? `Update password for ${prompt.username} on ${hostname}?`
    : `Save password for ${prompt.username} on ${hostname}?`;

  return (
    <Flex
      data-shell-top-chrome="save-password-bar"
      align="center"
      justify="between"
      px="3"
      py="2"
      gap="3"
      style={{
        backgroundColor: "var(--intent-consent-surface)",
        borderBottom: "1px solid var(--intent-consent-border)",
        flexShrink: 0,
      }}
    >
      <Flex direction="column" gap="1" style={{ flex: 1, minWidth: 0 }}>
        <Text size="2" truncate>
          {message}
        </Text>
        {saveError ? (
          <Callout.Root size="1" color="red" role="alert">
            <Callout.Text>Couldn&apos;t save the password: {saveError}</Callout.Text>
          </Callout.Root>
        ) : null}
      </Flex>
      <Flex gap="2" style={{ flexShrink: 0 }}>
        <Button
          size="1"
          variant="solid"
          className="app-touch-target"
          disabled={saving}
          onClick={() => void handleSave()}
        >
          {saving ? "Saving…" : prompt.isUpdate ? "Update" : "Save"}
        </Button>
        <Button
          size="1"
          variant="soft"
          className="app-touch-target"
          disabled={saving}
          onClick={handleNever}
        >
          Never
        </Button>
        <Button
          size="1"
          variant="ghost"
          className="app-touch-target"
          disabled={saving}
          onClick={handleDismiss}
        >
          Dismiss
        </Button>
      </Flex>
    </Flex>
  );
}
