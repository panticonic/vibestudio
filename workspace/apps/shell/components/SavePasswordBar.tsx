import { useState, useEffect, useCallback, useRef } from "react";
import { Flex, Text, Button, Callout } from "@radix-ui/themes";
import { useShellEvent } from "../shell/useShellEvent";
import { autofill } from "../shell/client";

interface PasswordSavePrompt {
  kind: "password";
  panelId: string;
  origin: string;
  username: string;
  isUpdate: boolean;
}

interface FormFillSavePrompt {
  kind: "form-fill";
  panelId: string;
  origin: string;
  fields: Array<{ type: string; label: string }>;
}

type SavePromptData = PasswordSavePrompt | FormFillSavePrompt;

interface SavePasswordBarProps {
  visiblePanelId: string | null;
}

export function SavePasswordBar({ visiblePanelId }: SavePasswordBarProps) {
  // Map of panelId -> prompt data; supports background panels queueing prompts
  const [prompts, setPrompts] = useState<Map<string, SavePromptData>>(new Map());
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useShellEvent(
    "autofill:save-prompt",
    useCallback((data: Omit<PasswordSavePrompt, "kind">) => {
      setConfirmation(null);
      setSaveError(null);
      setPrompts((prev) => {
        const next = new Map(prev);
        next.set(data.panelId, { ...data, kind: "password" });
        return next;
      });
    }, [])
  );

  useShellEvent(
    "autofill:form-fill-save-prompt",
    useCallback((data: Omit<FormFillSavePrompt, "kind">) => {
      setConfirmation(null);
      setSaveError(null);
      setPrompts((prev) => {
        const next = new Map(prev);
        next.set(data.panelId, { ...data, kind: "form-fill" });
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
    for (const [panelId, data] of prompts) {
      if (timerCleanups.current.has(panelId)) continue; // already has a timer
      const timer = setTimeout(() => {
        void (data.kind === "password"
          ? autofill.confirmSave(panelId, "dismiss")
          : autofill.confirmFormFill(panelId, "dismiss"))
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
    if (!confirmation) return;
    const timer = setTimeout(() => {
      setConfirmation(null);
    }, 1500);
    return () => clearTimeout(timer);
  }, [confirmation]);

  if (confirmation) {
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
          {confirmation}
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

  let hostname: string;
  try {
    hostname = new URL(prompt.origin).hostname;
  } catch {
    hostname = prompt.origin;
  }

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      if (prompt.kind === "password") {
        await autofill.confirmSave(prompt.panelId, "save");
      } else {
        await autofill.confirmFormFill(prompt.panelId, "save");
      }
      removePrompt(prompt.panelId);
      setConfirmation(prompt.kind === "password" ? "Password saved" : "Form-fill values saved");
    } catch (err) {
      console.error("[SavePasswordBar] Save failed:", err);
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleNever = async () => {
    if (prompt.kind !== "password") return;
    if (
      !window.confirm(
        `Never offer to save passwords for ${hostname}? This preference remains until you remove it from Credentials.`
      )
    )
      return;
    setSaving(true);
    setSaveError(null);
    try {
      await autofill.confirmSave(prompt.panelId, "never");
      removePrompt(prompt.panelId);
    } catch (err) {
      console.warn("[SavePasswordBar] Never-save failed:", err);
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDismiss = () => {
    void (prompt.kind === "password"
      ? autofill.confirmSave(prompt.panelId, "dismiss")
      : autofill.confirmFormFill(prompt.panelId, "dismiss"))
      .catch((err: unknown) => console.warn("[SavePasswordBar] Dismiss failed:", err));
    removePrompt(prompt.panelId);
  };

  const message =
    prompt.kind === "password"
      ? prompt.isUpdate
        ? `Update password for ${prompt.username} on ${hostname}?`
        : `Save password for ${prompt.username} on ${hostname}?`
      : `Save ${prompt.fields.length} form-fill ${
          prompt.fields.length === 1 ? "value" : "values"
        } from ${hostname}?`;

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
            <Callout.Text>Couldn&apos;t save: {saveError}</Callout.Text>
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
          {saving
            ? "Saving…"
            : prompt.kind === "password" && prompt.isUpdate
              ? "Update"
              : "Save"}
        </Button>
        {prompt.kind === "password" ? (
          <Button
            size="1"
            variant="soft"
            className="app-touch-target"
            disabled={saving}
            onClick={() => void handleNever()}
          >
            Never for this site
          </Button>
        ) : null}
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
