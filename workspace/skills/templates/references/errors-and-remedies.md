# Template errors and remedies

Use the service’s structured error state. Do not replace it with guessed
instructions or retry a failed integrity check.

| State | Explain to the user | Next action |
| --- | --- | --- |
| waiting for credential | “The {name} template is private. Connect {provider} to finish.” | Open the standard connection flow. |
| part conflict | “Both {a} and {b} include {part}.” | Use the approval card’s choices; never choose silently. |
| setting conflict | “Both {a} and {b} set up {thing}.” | Let the user choose one; the service records the workspace setting. |
| content mismatch | “This template’s content doesn’t match its published version. Nothing was installed.” | Stop. Offer Details; do not retry. |
| managed settings edited | “You’ve edited settings that the {name} template manages.” | Offer to move the intended change into workspace settings, then retry. |
| remote unavailable | For an explicit check: “Couldn’t reach {host}.” | Offer another check later. On a passive view, show no update badge. |
| part removed by an update | “{name} no longer includes {part}. Keep it in your workspace?” | Present Keep (default) or Remove in the update card. |

Any failure that made no change must say: “Nothing was changed.” When a remedy
needs another product surface, name it and provide that navigation action.
