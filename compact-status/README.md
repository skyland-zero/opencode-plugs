# Compact prompt status

Moves the current agent/model line from inside the prompt box to the left edge
of the prompt footer, and hides the built-in `agents` / `commands` shortcut
hints.

- Footer left: `Build · <model> · <variant>`
- The agent label follows the pending selection (shift+tab) immediately: it
  mirrors the host's own metadata row text, because the public data API only
  exposes the session agent after the selection commits. Agent names are padded
  to the widest visible one, so switching `Build`/`Plan` does not shift the
  separator, model, variant, or running spinner by a column.
- Hidden from the status area: the working-directory label, the
  `ctrl+p commands` / `shift+tab agents` hints, the interrupt and shell `esc`
  hints, and the `Press ctrl+b ...` background-work hint. The running spinner
  and the right-side stats stay visible.
- Footer right: context usage, cost, and the TPS meter (provided by the
  built-in footer and the local tps-meter plugin)
- Prompt box: one blank row above and below the input, so the text row is the
  exact vertical middle of the visible box. The host's half-row bottom border
  is hidden because in light themes it is nearly invisible but still counts as
  an extra row below the input.

The metadata row and the bottom border row are collapsed with a defensive
OpenTUI render-tree lookup. They are not published slots, so a future OpenCode
layout change may make the plugin stop touching them instead of crashing.

Disable it from `/plugins` (id: `local.compact-status`) or remove this folder.
If the plugin is not visible after creating it while the TUI is already
running, exit and reopen the TUI.
