import type { Plugin } from "@opencode/plugin/tui"
import type { TextareaRenderable } from "@opentui/core"
import { createSignal } from "solid-js"

function MultilineEditor(props: {
  title: string
  initial: string
  onSave: (value: string) => void
  onCancel: () => void
  ctx: Plugin.Context
}) {
  const [value, setValue] = createSignal(props.initial)
  const [target, setTarget] = createSignal<TextareaRenderable>()
  props.ctx.keymap.layer(() => {
    return {
      mode: "modal",
      target,
      priority: 100,
      commands: [
        { bind: "enter", title: "New line", run: () => target()?.newLine() },
        { bind: "ctrl+s", title: "Save", run: () => props.onSave(target()?.plainText ?? value()) },
        { bind: "escape", title: "Cancel", run: props.onCancel },
      ],
    }
  })

  return (
    <box flexDirection="column" gap={1} height="100%" padding={1} width="100%">
      <text>{props.title}</text>
      <textarea
        ref={(textarea) => {
          textarea.traits = { capture: ["escape", "submit"] }
          setTarget(textarea)
        }}
        focused
        flexGrow={1}
        height={14}
        initialValue={props.initial}
        keyBindings={[{ name: "return", action: "newline" }]}
        onContentChange={setValue}
        onKeyDown={(event) => {
          if (event.name.toLowerCase() !== "escape") return
          event.preventDefault()
          event.stopPropagation()
          props.onCancel()
        }}
        wrapMode="word"
      />
      <text>Enter: new line · Ctrl+S: save · Esc: cancel</text>
    </box>
  )
}

export const editMultiline = (ctx: Plugin.Context, title: string, initial: string) =>
  new Promise<string | undefined>((resolve) => {
    let settled = false

    const finish = (value: string | undefined) => {
      if (settled) return
      settled = true
      ctx.ui.dialog.clear()
      resolve(value)
    }

    ctx.ui.dialog.show(
      () => (
        <MultilineEditor ctx={ctx} title={title} initial={initial} onCancel={() => finish(undefined)} onSave={finish} />
      ),
      () => {
        if (settled) return
        settled = true
        resolve(undefined)
      },
    )
    ctx.ui.dialog.set({ size: "large", centered: true })
  })
