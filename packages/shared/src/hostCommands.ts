/**
 * A command contributed by hosted content to its owning application shell.
 * The contract describes intent; each host chooses an idiomatic presentation
 * such as the desktop command palette or a native mobile action sheet.
 */
export interface HostCommand {
  /** Stable id, unique within the contributing panel. */
  id: string;
  label: string;
  /** Optional supporting copy shown by hosts that have room for it. */
  description?: string;
  /** Optional grouping label, usually the contributing feature or panel. */
  group?: string;
  /**
   * Ordered arguments the host prompts for before running the command.
   * Omitted entirely by legacy contributions, which stay valid unchanged.
   */
  args?: HostCommandArg[];
  /**
   * Declarative availability: the command is offered only while the
   * contributing panel is the focused one. Functions cannot cross the wire, so
   * this is the only availability a contribution can express.
   */
  requiresFocus?: boolean;
  /** Destructive: hosts render it in their danger tone and never auto-run it. */
  danger?: boolean;
}

/** Argument types a serialized contribution may declare. */
export type HostCommandArgType = "string" | "enum" | "number" | "url";

/**
 * One declarative argument.
 *
 * There is no dynamic completion here on purpose: a contributed suggester would
 * be a function on the wire. Enum options are inline and static, and free text
 * is validated by `pattern` alone. If a real need for completion appears, the
 * follow-up is a round-trip event to the contributing panel — not a function.
 */
export interface HostCommandArg {
  name: string;
  /** Placeholder shown while the host prompts for this argument. */
  label: string;
  type: HostCommandArgType;
  /** Optional arguments are skippable; required ones block execution. */
  required: boolean;
  /** Inline, static option list. Only meaningful for `type: "enum"`. */
  options?: { value: string; label: string }[];
  /** Regular-expression source used to validate a free-text value. */
  pattern?: string;
}

export const HOST_COMMAND_CONTRIBUTION_EVENT = "runtime:host-command-contribution";
export const HOST_COMMAND_RUN_EVENT = "runtime:host-command-run";
