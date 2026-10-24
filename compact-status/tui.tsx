/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, Show, type Accessor } from "solid-js"

/**
 * Compact prompt status.
 *
 * Moves the agent/model line from inside the prompt box to the left edge of
 * the prompt footer, and hides the built-in "agents"/"commands" shortcut
 * hints. The agent/model row is not a published slot in the host UI, so this
 * plugin locates the prompt renderables through the OpenTUI tree and collapses
 * the metadata row. It also hides the half-row bottom border, which in light
 * themes is nearly invisible but still pushes the input visually upward, and
 * balances the prompt padding so the input sits in the exact middle of the
 * box. Every lookup is defensive: if the host layout changes, the plugin
 * stops touching the tree instead of breaking the TUI.
 *
 * The prompt is anchored by its outer border character (bottomLeft === "╹"),
 * not by the footer location text: the location text is replaced by the
 * interrupt hint while a reply streams, which used to disable the plugin for
 * the whole duration of every response.
 */

type TreeNode = {
  id?: string
  visible?: boolean
  height?: number | "auto"
  width?: number
  y?: number
  isDestroyed?: boolean
  parent?: TreeNode | null
  getChildren?: () => TreeNode[]
  plainText?: string
  editBuffer?: unknown
  customBorderChars?: { bottomLeft?: string; vertical?: string }
}

const PROMPT_BORDER = "╹"

function children(node: TreeNode | undefined): TreeNode[] {
  if (!node || typeof node.getChildren !== "function") return []
  try {
    return node.getChildren()
  } catch {
    return []
  }
}

function isTextarea(node: TreeNode): boolean {
  return typeof node.editBuffer === "object" && node.editBuffer !== null
}

function isText(node: TreeNode): boolean {
  if (isTextarea(node)) return false
  try {
    return typeof node.plainText === "string"
  } catch {
    return false
  }
}

function textOf(node: TreeNode | undefined): string {
  if (!node) return ""
  try {
    if (typeof node.plainText === "string") return node.plainText
  } catch {}
  return children(node).map(textOf).filter(Boolean).join(" ")
}

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

function walk(node: TreeNode | undefined, visit: (node: TreeNode) => void) {
  if (!node || node.isDestroyed) return
  visit(node)
  if (isText(node)) return
  for (const child of children(node)) walk(child, visit)
}

function findTextarea(node: TreeNode | undefined): TreeNode | undefined {
  if (!node) return undefined
  if (isTextarea(node)) return node
  for (const child of children(node)) {
    const found = findTextarea(child)
    if (found) return found
  }
}

function firstText(node: TreeNode | undefined): TreeNode | undefined {
  if (!node) return undefined
  if (isText(node)) return node
  for (const child of children(node)) {
    const found = firstText(child)
    if (found) return found
  }
}

function isPromptWrapper(node: TreeNode): boolean {
  try {
    return node.customBorderChars?.bottomLeft === PROMPT_BORDER
  } catch {
    return false
  }
}

function findPromptWrappers(root: TreeNode): TreeNode[] {
  const found: TreeNode[] = []
  walk(root, (node) => {
    if (isPromptWrapper(node)) found.push(node)
  })
  return found
}

function titlecase(value: string): string {
  return value.length ? value[0]!.toUpperCase() + value.slice(1) : value
}

function Status(props: {
  context: Plugin.Context
  sessionID?: string
  mode: "normal" | "shell"
  agentName: Accessor<string | undefined>
}) {
  const dimensions = useTerminalDimensions()
  const theme = props.context.theme
  const location = () => props.context.location ?? props.context.data.location.default()

  const agent = createMemo(() => {
    const session = props.sessionID ? props.context.data.session.get(props.sessionID) : undefined
    const agents = props.context.data.location.agent.list(location()) ?? []
    return (
      agents.find((item) => item.id === session?.agent) ??
      agents.find((item) => item.mode !== "subagent" && !item.hidden)
    )
  })

  const model = createMemo(() => {
    const selected = props.context.ui.model.current()
    if (!selected) return undefined
    const models = props.context.data.location.model.list(location()) ?? []
    const info = models.find((item) => item.providerID === selected.providerID && item.id === selected.modelID)
    return {
      name: info?.name ?? selected.modelID,
      variant: selected.variant,
    }
  })

  // The selected agent is client-local state and is not part of the public
  // plugin API: `session.agent` only changes after a commit. Mirror the host's
  // own metadata row, which tracks the pending selection immediately, so the
  // footer label follows shift+tab without waiting for a message to be sent.
  const label = () =>
    props.mode === "shell" ? "Shell" : props.agentName() || titlecase(agent()?.id ?? "build")

  // Agent names have different widths ("Build" vs "Plan"), which would shift
  // the separator, model name, variant and the running spinner by a column on
  // every switch. Pad the agent name to the widest visible one so the rest of
  // the footer keeps a fixed x position.
  const labelWidth = createMemo(() => {
    const agents = props.context.data.location.agent.list(location()) ?? []
    const widths = agents
      .filter((item) => item.mode !== "subagent" && !item.hidden)
      .map((item) => titlecase(item.id).length)
    return Math.max(1, ...widths)
  })

  const paddedLabel = () =>
    props.mode === "shell" ? label() : label().padEnd(Math.max(label().length, labelWidth()), " ")

  const color = () => (props.mode === "shell" ? theme.text.action.primary.selected : theme.text.base)
  const maxWidth = () => Math.max(18, Math.floor(dimensions().width * 0.6))

  return (
    <box flexDirection="row" flexShrink={1} minWidth={0} maxWidth={maxWidth()}>
      <text wrapMode="none" truncate>
        <span style={{ fg: color() }}>{paddedLabel()}</span>
        <Show when={props.mode !== "shell" && model()}>
          <span style={{ fg: theme.text.muted }}> · </span>
          <span style={{ fg: theme.text.base }}>{model()!.name}</span>
          <Show when={model()!.variant}>
            <span style={{ fg: theme.text.muted }}> · </span>
            <span style={{ fg: theme.text.feedback.warning.base }}>{model()!.variant}</span>
          </Show>
        </Show>
      </text>
    </box>
  )
}

export default Plugin.define({
  id: "local.compact-status",
  setup(context) {
    const hidden = new Map<TreeNode, boolean>()
    const resized = new Set<TreeNode>()
    const [agentName, setAgentName] = createSignal<string>()
    let stopped = false
    let failed = false
    let promptWrapper: TreeNode | undefined
    let lastRunningHint = 0

    function hide(node: TreeNode) {
      if (!node || node.isDestroyed || node.visible === false) return
      if (!hidden.has(node)) hidden.set(node, true)
      node.visible = false
    }

    function hideFooterHints(scope: TreeNode) {
      const hints = new Set<string>()
      for (const key of context.keymap.shortcuts("agent.cycle")) hints.add(normalize(`${key} agents`))
      for (const key of context.keymap.shortcuts("command.palette.show")) hints.add(normalize(`${key} commands`))
      // The interrupt/shell hints are hardcoded to "esc" in the host footer,
      // independent of the keybinding, so keep "esc" as a fallback.
      const interruptKeys = new Set<string>(["esc", ...context.keymap.shortcuts("session.interrupt")])
      for (const key of interruptKeys) {
        hints.add(normalize(`${key} interrupt`))
        hints.add(normalize(`${key} again to interrupt`))
        hints.add(normalize(`${key} exit shell mode`))
        hints.add(normalize(`${key} shell`))
      }
      walk(scope, (node) => {
        // The footer's working-directory label. It is rendered as a text node
        // with a stable id only while the session is idle; hiding the text (not
        // its flex-growing parent) keeps the right-side stats in place.
        if (node.id === "prompt.footer.location") {
          hide(node)
          return
        }
        if (!isText(node)) return
        if (hints.size && hints.has(normalize(textOf(node)))) hide(node)
      })
    }

    // The "Press <key> to move running work to the background" hint lives in
    // the transcript, not the prompt footer, and only while a shell/subagent
    // tool is running. Search the whole tree, but only while a session runs.
    function hideRunningHint(root: TreeNode) {
      const key = context.keymap.shortcuts("session.background")[0]
      if (!key) return
      const hint = normalize(`Press ${key} to move running work to the background`)
      walk(root, (node) => {
        if (!isText(node)) return
        if (normalize(textOf(node)) !== hint) return
        const box = node.parent
        // The text is the only child of its margin box; hide the box so the
        // blank margin row disappears too.
        if (box && children(box).length === 1) hide(box)
        else hide(node)
      })
    }

    // Below 44 columns the host drops the agent from its metadata row, so the
    // first text there is the model. Only mirror values that are actually one
    // of the location's agent labels.
    function knownAgentLabel(value: string): string | undefined {
      const location = context.location ?? context.data.location.default()
      const agents = context.data.location.agent.list(location) ?? []
      const key = value.toLowerCase()
      const match = agents.find(
        (agent) => titlecase(agent.id).toLowerCase() === key || agent.id.toLowerCase() === key,
      )
      return match ? value : undefined
    }

    function scan() {
      const root = context.renderer.root as unknown as TreeNode
      // The prompt is remounted on route/tab changes. Cache the wrapper so the
      // common case costs one textarea lookup instead of a full tree walk.
      if (promptWrapper?.isDestroyed) promptWrapper = undefined
      const wrappers = promptWrapper ? [promptWrapper] : findPromptWrappers(root)
      if (!promptWrapper && wrappers[0]) promptWrapper = wrappers[0]

      for (const wrapper of wrappers) {
        const textarea = findTextarea(wrapper)
        if (!textarea) continue
        const parent = textarea.parent
        if (!parent) continue
        const siblings = children(parent)
        const index = siblings.indexOf(textarea)
        const metaBox = index === -1 ? undefined : siblings[index + 1]
        if (!metaBox || typeof metaBox.getChildren !== "function" || isTextarea(metaBox)) continue

        // Older versions of this plugin could hide the whole wrapper during
        // the first frame. Restore it so its paddingTop remains the blank
        // line below the input and the composer stays vertically centered.
        if (metaBox.visible === false) metaBox.visible = true

        // Hide only the agent/model row itself.
        //
        // Never hide the wrapper as a fallback: if the row is not mounted yet,
        // hiding the wrapper would permanently remove the bottom padding and
        // leave the composer top-aligned. The next scan will catch the row.
        const metadataRow = children(metaBox)[0]
        if (metadataRow && typeof metadataRow.getChildren === "function") {
          // Mirror the host's own label before hiding the row. The row tracks
          // the pending agent selection (the value shift+tab changes), which
          // the public data API does not expose until the selection commits.
          const agentText = firstText(metadataRow)
          if (agentText) {
            const value = knownAgentLabel(normalize(textOf(agentText)))
            if (value && value !== agentName()) setAgentName(value)
          }
          hide(metadataRow)
          // One blank row below the input. Together with the host's one row
          // above, that makes a compact 3-row box with the input in the exact
          // middle. The host's half-block bottom border row is hidden below;
          // it is nearly invisible in light themes but still counts as an
          // extra row, which is what made the input look off-center.
          if (metaBox.height !== 1) {
            if (!resized.has(metaBox)) resized.add(metaBox)
            metaBox.height = 1
          }
        }

        // The host draws the bottom edge as a separate half-block row. The
        // prompt then reads as one row taller at the bottom, which is exactly
        // the asymmetry this plugin is meant to remove. Hide that row and
        // keep the box an odd number of rows tall instead.
        const outer = wrapper.parent
        if (outer) {
          const rows = children(outer)
          const at = rows.indexOf(wrapper)
          const border = at === -1 ? undefined : rows[at + 1]
          if (border && !isTextarea(border)) {
            try {
              if (border.customBorderChars?.vertical === PROMPT_BORDER) hide(border)
            } catch {}
          }
        }

        // Shortcut hints live in the footer row, a sibling of the wrapper.
        // Restrict the walk to the prompt component, never the conversation.
        if (wrapper.parent) hideFooterHints(wrapper.parent)
      }

      // The background hint is outside the prompt component. Scanning the
      // whole tree is only worth it while a session is actually running, and
      // at a lower rate than the prompt layout checks.
      const now = Date.now()
      if (now - lastRunningHint > 500) {
        lastRunningHint = now
        const route = context.ui.router.current()
        if (route.type === "session" && context.data.session.status(route.sessionID) === "running") {
          hideRunningHint(root)
        }
      }
    }

    function sync() {
      if (stopped || failed) return
      try {
        scan()
      } catch (error) {
        failed = true
        console.error("[compact-status] could not inspect the prompt layout", error)
      }
    }

    // The first prompt mounts after setup. Poll for new prompt instances and
    // for Solid re-renders that recreate the shortcut hint nodes.
    const timer = setInterval(sync, 400)
    let lastFrame = 0
    const onFrame = () => {
      const now = Date.now()
      if (now - lastFrame < 120) return
      lastFrame = now
      sync()
    }
    const onResize = () => sync()

    context.renderer.on("frame", onFrame)
    context.renderer.on("resize", onResize)
    setTimeout(sync, 0)
    setTimeout(sync, 250)

    const offSlot = context.ui.slot({
      prepend: "prompt.footer",
      render: (props) => (
        <Status context={context} sessionID={props.sessionID} mode={props.mode} agentName={agentName} />
      ),
    })

    return () => {
      stopped = true
      clearInterval(timer)
      context.renderer.off("frame", onFrame)
      context.renderer.off("resize", onResize)
      offSlot()
      for (const node of hidden.keys()) {
        if (!node.isDestroyed) node.visible = true
      }
      hidden.clear()
      for (const node of resized) {
        if (!node.isDestroyed) node.height = "auto"
      }
      resized.clear()
    }
  },
})
