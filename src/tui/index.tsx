import { Plugin } from "@opencode/plugin/tui"
import { createComponent } from "solid-js"
import { isEnabled, openStore, setEnabled } from "../store"
import { addMessage, editMessage, manageAddedMessages, removeMessage, restoreMessage } from "./content"
import { managePrefill, managePresets } from "./prefill"

function CommandsHost(props: { ctx: Plugin.Context; run: (input?: string) => Promise<void> }) {
  props.ctx.keymap.layer(() => {
    return {
      mode: "global",
      commands: [
        {
          id: "oc-purge.open",
          title: "Purge conversation content",
          description: "Replace, hide, or restore message content using local overlays",
          group: "Purge",
          bind: false,
          palette: true,
          slash: { name: "purge", arguments: true },
          run: props.run,
        },
      ],
    }
  })
  return null
}

const undoRedo = (ctx: Plugin.Context, sessionID: string, action: "undo" | "redo") => {
  const changed = action === "undo" ? openStore().undo(sessionID) : openStore().redo(sessionID)
  if (!changed) ctx.ui.toast.show({ message: `Nothing to ${action}.`, variant: "info", sessionID })
  else ctx.ui.toast.show({ message: `Purge ${action} complete.`, variant: "success", sessionID })
}

export default Plugin.define({
  id: "oc-purge",
  setup(ctx) {
    const run = async (input?: string) => {
      const route = ctx.ui.router.current()
      const sessionID =
        route.type === "session"
          ? route.sessionID
          : route.type === "plugin" && typeof route.data?.["sessionID"] === "string"
            ? route.data["sessionID"]
            : ctx.ui.panel.current()?.sessionID
      if (!sessionID) {
        ctx.ui.toast.show({ message: "Open a session before using /purge.", variant: "warning" })
        return
      }

      try {
        await ctx.data.session.sync(sessionID)
        await ctx.data.session.message.sync(sessionID)
        const store = openStore()
        const messages = ctx.data.session.message.list(sessionID)
        const command = input?.trim().toLowerCase()

        if (command === "on" || command === "off") {
          setEnabled(openStore(), sessionID, command === "on")
          ctx.ui.toast.show({
            message: `Purge ${command === "on" ? "enabled" : "disabled"} for this session.`,
            variant: "success",
            sessionID,
          })
          return
        }
        if (command === "undo" || command === "redo") {
          undoRedo(ctx, sessionID, command)
          return
        }
        if (command === "clear") return restoreMessage(ctx, sessionID, store, messages)

        const enabled = isEnabled(store, sessionID)
        const menu = await ctx.ui.dialog.select<
          "toggle" | "edit" | "add" | "remove" | "added" | "restore" | "undo" | "redo" | "presets" | "prefill"
        >({
          title: `Purge · ${enabled ? "ON" : "OFF"} (this session)`,
          options: [
            {
              title: enabled ? "Disable purge" : "Enable purge",
              value: "toggle",
              description: "Overlays and injection are disabled by default for each session",
            },
            {
              title: "Edit or purge content…",
              value: "edit",
              description: "Choose a message, then replace or hide text",
            },
            {
              title: "Add message…",
              value: "add",
              description: "Insert a User or Assistant message into model context",
            },
            {
              title: "Remove message…",
              value: "remove",
              description: "Remove a message from model context without deleting the original",
            },
            { title: "Manage added messages…", value: "added" },
            ...(Object.keys(store.getSessionOverlays(sessionID)).length
              ? [{ title: "Restore a message…", value: "restore" as const }]
              : []),
            ...(store.canUndo(sessionID) ? [{ title: "Undo last purge edit", value: "undo" as const }] : []),
            ...(store.canRedo(sessionID) ? [{ title: "Redo purge edit", value: "redo" as const }] : []),
            {
              title: "Configure chat prefill…",
              value: "prefill",
              description: "Manage active settings and named presets per model",
            },
            {
              title: "Manage saved presets…",
              value: "presets",
              description: "Delete project, session, or global named presets",
            },
          ],
        })

        if (menu === "toggle") {
          setEnabled(openStore(), sessionID, !enabled)
          ctx.ui.toast.show({
            message: `Purge ${enabled ? "disabled" : "enabled"} for this session.`,
            variant: "success",
            sessionID,
          })
        } else if (menu === "edit") await editMessage(ctx, sessionID, store, messages)
        else if (menu === "add") await addMessage(ctx, sessionID, store, messages)
        else if (menu === "remove") await removeMessage(ctx, sessionID, store, messages)
        else if (menu === "added") await manageAddedMessages(ctx, sessionID, store, messages)
        else if (menu === "restore") await restoreMessage(ctx, sessionID, store, messages)
        else if (menu === "prefill") await managePrefill(ctx, sessionID, store)
        else if (menu === "presets") await managePresets(ctx, sessionID, store)
        else if (menu === "undo" || menu === "redo") await undoRedo(ctx, sessionID, menu)
      } catch (error) {
        ctx.ui.toast.show({
          message: `Purge failed: ${error instanceof Error ? error.message : String(error)}`,
          variant: "error",
          sessionID,
        })
      }
    }

    return ctx.ui.slot({ append: "app", render: () => createComponent(CommandsHost, { ctx, run }) })
  },
})
