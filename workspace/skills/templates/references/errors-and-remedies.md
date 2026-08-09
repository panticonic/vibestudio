# Template errors and remedies

Use the service’s structured error state. Do not replace it with guessed
instructions or retry a failed integrity check.

| State                             | Explain to the user                                                                   | Next action                                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| waiting for credential            | “The {name} template is private. Connect {provider} to finish.”                       | Open the standard connection flow.                                                             |
| overlapping changes               | “{a} and {b} both change {part}.”                                                     | Open each returned VCS delta, merge semantically, and resume the operation.                    |
| setting conflict                  | “Both {a} and {b} set up {thing}.”                                                    | Let the user choose one; the service records the workspace setting.                            |
| content mismatch                  | “This template’s content doesn’t match its published version. Nothing was installed.” | Stop. Offer Details; do not retry.                                                             |
| managed settings edited           | “You’ve edited settings that the {name} template manages.”                            | Offer to move the intended change into workspace settings, then retry.                         |
| remote unavailable                | For an explicit check: “Couldn’t reach {host}.”                                       | Offer another check later. On a passive view, show no update badge.                            |
| build or type failure             | “The merged template changes need repair before they can be published.”               | Edit the returned repair context using the structured failures, then resume to rebuild it.     |
| contribution removed by an update | “{name} no longer contributes its changes to {part}.”                                 | Review the removal delta through ordinary VCS; other contributions and workspace edits remain. |

Any failure that made no change must say: “Nothing was changed.” When a remedy
needs another product surface, name it and provide that navigation action.
