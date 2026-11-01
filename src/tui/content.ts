import type { Plugin } from "@opencode/plugin/tui"
import { openStore, type Store } from "../store"
import { compact, hasOverlay, isRecord, messagePreview, partText } from "../utils"
import { editMultiline } from "./editor"
import { choosePresetScope, namedPresets, type PresetRef, scopesFor } from "./session"

type SessionMessage = ReturnType<Plugin.Context["data"]["session"]["message"]["list"]>[number]
type EditableMessage = Extract<SessionMessage, { type: "user" | "assistant" }>

type Target = {
  message: EditableMessage
  index?: number
  original: string
  label: string
}

type ContentAction =
  | { kind: "replace" }
  | { kind: "purge" }
  | { kind: "restore" }
  | { kind: "save" }
  | { kind: "preset"; ref: PresetRef }

const chooseMessage = (
  ctx: Plugin.Context,
  sessionID: string,
  store: Store,
  messages: readonly SessionMessage[],
  onlyOverlaid = false,
) => {
  const eligible = messages
    .filter((message): message is EditableMessage => message.type === "user" || message.type === "assistant")
    .filter(
      (message) =>
        onlyOverlaid ||
        message.type === "user" ||
        message.content.some((part) => part.type === "text" || part.type === "reasoning"),
    )
    .filter((message) => !onlyOverlaid || hasOverlay(message, store.getMessageOverlay(sessionID, message.id)))
    .reverse()
  if (!eligible.length) {
    ctx.ui.toast.show({
      message: onlyOverlaid ? "No purged messages to restore." : "No editable messages in this session.",
      variant: "info",
      sessionID,
    })
    return undefined
  }

  return ctx.ui.dialog.select<EditableMessage>({
    title: onlyOverlaid ? "Restore a message" : "Choose a message to purge",
    placeholder: "Search messages",
    options: eligible.map((message) => {
      return {
        title: `${message.type === "user" ? "User" : "Assistant"} · ${new Date(message.time.created).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${compact(messagePreview(message))}`,
        value: message,
        description: `${message.id.slice(-8)}${hasOverlay(message, store.getMessageOverlay(sessionID, message.id)) ? " · has purge overrides" : ""}`,
      }
    }),
  })
}

const applyTarget = (store: Store, sessionID: string, target: Target, text?: string) => {
  const overlay = store.getMessageOverlay(sessionID, target.message.id)
  if (text === undefined) {
    if (!overlay) return
    if (target.message.type === "user") delete overlay["text"]
    else {
      const content: Record<string, string> = {}
      if (isRecord(overlay["content"])) {
        for (const [index, value] of Object.entries(overlay["content"])) {
          if (typeof value === "string") content[index] = value
        }
      }
      delete content[String(target.index)]
      if (Object.keys(content).length) overlay["content"] = content
      else delete overlay["content"]
    }
    if (Object.keys(overlay).length) store.setMessageOverlay(sessionID, target.message.id, overlay)
    else store.removeMessageOverlay(sessionID, target.message.id)
    return
  }

  if (target.message.type === "user") {
    store.setMessageOverlay(sessionID, target.message.id, { ...overlay, text })
    return
  }
  const content: Record<string, string> = {}
  if (isRecord(overlay?.["content"])) {
    for (const [index, value] of Object.entries(overlay["content"])) {
      if (typeof value === "string") content[index] = value
    }
  }
  content[String(target.index)] = text
  store.setMessageOverlay(sessionID, target.message.id, { ...overlay, content })
}

const confirmTextModification = async (ctx: Plugin.Context, label: string, before: string, after: string) =>
  (await ctx.ui.dialog.confirm({
    title: "Preview purge modification",
    message: `${label}\n\nBefore:\n${compact(before, 220)}\n\nAfter:\n${compact(after, 220)}`,
    label: { confirm: "Apply", cancel: "Cancel" },
  })) === true

const savePreset = async (ctx: Plugin.Context, sessionID: string, value: string) => {
  const name = await ctx.ui.dialog.prompt({ title: "Save replacement as a preset", placeholder: "Preset name" })
  if (name === undefined) return
  if (!name.trim()) {
    ctx.ui.toast.show({ message: "Preset name cannot be empty.", variant: "warning", sessionID })
    return
  }
  const selectedScope = await choosePresetScope(
    ctx,
    sessionID,
    "Save preset scope",
    scopesFor(ctx, sessionID).find((scope) => scope.type === "project"),
  )
  if (!selectedScope) return
  openStore().savePreset(selectedScope, { id: crypto.randomUUID(), name: name.trim(), kind: "text", value })
  ctx.ui.toast.show({ message: `Saved “${name.trim()}” (${selectedScope.type}).`, variant: "success", sessionID })
}

const editTarget = async (ctx: Plugin.Context, sessionID: string, store: Store, target: Target) => {
  const overlay = store.getMessageOverlay(sessionID, target.message.id)
  const content = isRecord(overlay?.["content"]) ? overlay["content"] : undefined
  const replacement = target.message.type === "user" ? overlay?.["text"] : content?.[String(target.index)]
  const existingText = typeof replacement === "string" ? replacement : target.original

  const action = await ctx.ui.dialog.select<ContentAction>({
    title: `Purge · ${target.label}`,
    options: [
      { kind: "replace" as const },
      { kind: "purge" as const },
      ...(typeof replacement === "string" ? [{ kind: "restore" as const }] : []),
      ...namedPresets(ctx, store, sessionID)
        .filter(({ preset }) => typeof preset["value"] === "string")
        .map((ref) => {
          return { kind: "preset" as const, ref }
        }),
      { kind: "save" as const },
    ].map((option) => {
      if (option.kind === "replace")
        return { title: "Replace text…", description: "Keep a custom text overlay", value: option }
      if (option.kind === "purge")
        return { title: "Purge text", description: "Overlay this content with an empty string", value: option }
      if (option.kind === "restore") return { title: "Restore original", value: option }
      if (option.kind === "save") return { title: "Save current text as preset…", value: option }
      return {
        title: `Apply preset: ${option.ref.preset.name}`,
        description: `${option.ref.scope.type} · ${compact(option.ref.preset["value"] as string, 48)}`,
        value: option,
      }
    }),
  })
  if (!action) return

  if (action.kind === "replace") {
    const text = await editMultiline(ctx, "Replace content text", existingText)
    if (text === undefined) return
    if (!(await confirmTextModification(ctx, target.label, existingText, text))) return
    applyTarget(openStore(), sessionID, target, text)
    ctx.ui.toast.show({ message: "Replacement saved.", variant: "success", sessionID })
    return
  }

  if (action.kind === "purge") {
    if (!(await confirmTextModification(ctx, target.label, existingText, ""))) return
    applyTarget(openStore(), sessionID, target, "")
    ctx.ui.toast.show({ message: "Content purged.", variant: "success", sessionID })
    return
  }

  if (action.kind === "restore") {
    if (!(await confirmTextModification(ctx, target.label, existingText, target.original))) return
    applyTarget(openStore(), sessionID, target)
    ctx.ui.toast.show({ message: "Original content restored.", variant: "success", sessionID })
    return
  }

  if (action.kind === "preset") {
    const value = action.ref.preset["value"] as string
    if (!(await confirmTextModification(ctx, target.label, existingText, value))) return
    applyTarget(openStore(), sessionID, target, value)
    ctx.ui.toast.show({ message: `Applied preset “${action.ref.preset.name}”.`, variant: "success", sessionID })
    return
  }

  await savePreset(ctx, sessionID, existingText)
}

export const editMessage = async (
  ctx: Plugin.Context,
  sessionID: string,
  store: Store,
  messages: readonly SessionMessage[],
) => {
  const message = await chooseMessage(ctx, sessionID, store, messages)
  if (!message) return

  if (message.type === "user") {
    await editTarget(ctx, sessionID, store, { message, original: message.text, label: "user text" })
    return
  }

  if (!message.content.length) {
    ctx.ui.toast.show({ message: "This assistant message has no content to edit.", variant: "info", sessionID })
    return
  }
  const selectedIndex = await ctx.ui.dialog.select<number>({
    title: "Choose assistant content",
    placeholder: "Search content",
    options: message.content.flatMap((part, index) =>
      part.type === "text" || part.type === "reasoning"
        ? [
            {
              title: `Content ${index} · ${part.type} · ${compact(partText(part))}`,
              value: index,
              description: `Original array index ${index}`,
            },
          ]
        : [],
    ),
  })
  if (selectedIndex === undefined) return
  const part = message.content[selectedIndex]
  if (!part) return
  await editTarget(ctx, sessionID, store, {
    message,
    index: selectedIndex,
    original: partText(part),
    label: `assistant content ${selectedIndex}`,
  })
}

export const addMessage = async (
  ctx: Plugin.Context,
  sessionID: string,
  store: Store,
  messages: readonly SessionMessage[],
) => {
  const anchor = await chooseMessage(ctx, sessionID, store, messages)
  if (!anchor) return
  const role = await ctx.ui.dialog.select<"user" | "assistant">({
    title: "Add a message after the selected message",
    options: [
      { title: "User", value: "user" },
      { title: "Assistant", value: "assistant" },
    ],
  })
  if (!role) return
  const text = await editMultiline(ctx, "New message", "")
  if (text === undefined || !text) return
  if (
    !(await ctx.ui.dialog.confirm({
      title: "Preview added message",
      message: `${role}:\n\n${text}`,
      label: { confirm: "Add", cancel: "Cancel" },
    }))
  )
    return
  const latest = openStore()
  const overlay = latest.getMessageOverlay(sessionID, anchor.id) ?? {}
  const after = Array.isArray(overlay["after"]) ? overlay["after"] : []
  latest.setMessageOverlay(sessionID, anchor.id, {
    ...overlay,
    after: [...after, { id: crypto.randomUUID(), role, text }],
  })
  ctx.ui.toast.show({ message: "Message added to the context overlay.", variant: "success", sessionID })
}

export const removeMessage = async (
  ctx: Plugin.Context,
  sessionID: string,
  store: Store,
  messages: readonly SessionMessage[],
) => {
  const message = await chooseMessage(ctx, sessionID, store, messages)
  if (!message) return
  if (message.type === "assistant" && message.content.some((part) => part.type === "tool")) {
    ctx.ui.toast.show({
      message: "Cannot remove a message containing tool calls; edit its text instead.",
      variant: "warning",
      sessionID,
    })
    return
  }
  if (message.type === "user" && message.files?.length) {
    ctx.ui.toast.show({
      message: "Cannot remove a message containing attachments; edit its text instead.",
      variant: "warning",
      sessionID,
    })
    return
  }
  if (
    !(await ctx.ui.dialog.confirm({
      title: "Remove message from model context",
      message: `Remove this ${message.type} message?\n\n${messagePreview(message)}\n\nThe original remains in the session.`,
      label: { confirm: "Remove", cancel: "Cancel" },
    }))
  )
    return
  const latest = openStore()
  latest.setMessageOverlay(sessionID, message.id, {
    ...latest.getMessageOverlay(sessionID, message.id),
    removed: true,
  })
  ctx.ui.toast.show({ message: "Message removed from model context.", variant: "success", sessionID })
}

export const manageAddedMessages = async (
  ctx: Plugin.Context,
  sessionID: string,
  store: Store,
  messages: readonly SessionMessage[],
) => {
  const options = messages.flatMap((message) => {
    const overlay = store.getMessageOverlay(sessionID, message.id)
    return Array.isArray(overlay?.["after"])
      ? overlay["after"].flatMap((entry: unknown, index: number) =>
          isRecord(entry) &&
          (entry["role"] === "user" || entry["role"] === "assistant") &&
          typeof entry["text"] === "string"
            ? [
                {
                  title: `${entry["role"]} · ${compact(entry["text"])}`,
                  value: { messageID: message.id, index, entry },
                },
              ]
            : [],
        )
      : []
  })
  if (!options.length) {
    ctx.ui.toast.show({ message: "No added messages in this session.", variant: "info", sessionID })
    return
  }
  const selected = await ctx.ui.dialog.select({ title: "Manage added message", options })
  if (!selected) return
  const action = await ctx.ui.dialog.select<"edit" | "remove">({
    title: "Added message",
    options: [
      { title: "Edit", value: "edit" },
      { title: "Remove", value: "remove" },
    ],
  })
  if (!action) return
  const oldText = String(selected.entry["text"])
  const text = action === "edit" ? await editMultiline(ctx, "Edit added message", oldText) : ""
  if (text === undefined || !(await confirmTextModification(ctx, "Added message", oldText, text))) return
  const latest = openStore()
  const overlay = latest.getMessageOverlay(sessionID, selected.messageID)
  if (!(overlay && Array.isArray(overlay["after"]))) return
  const after = [...overlay["after"]]
  if (action === "remove") after.splice(selected.index, 1)
  else after[selected.index] = { ...selected.entry, text }
  if (after.length) overlay["after"] = after
  else delete overlay["after"]
  if (Object.keys(overlay).length) latest.setMessageOverlay(sessionID, selected.messageID, overlay)
  else latest.removeMessageOverlay(sessionID, selected.messageID)
  ctx.ui.toast.show({
    message: action === "edit" ? "Added message updated." : "Added message removed.",
    variant: "success",
    sessionID,
  })
}

export const restoreMessage = async (
  ctx: Plugin.Context,
  sessionID: string,
  store: Store,
  messages: readonly SessionMessage[],
) => {
  const message = await chooseMessage(ctx, sessionID, store, messages, true)
  if (!message) return
  if (
    !(await ctx.ui.dialog.confirm({
      title: "Restore message",
      message: "Remove all purge overrides from this message?",
      label: { confirm: "Restore", cancel: "Cancel" },
    }))
  )
    return
  openStore().removeMessageOverlay(sessionID, message.id)
  ctx.ui.toast.show({ message: "Message restored to its original content.", variant: "success", sessionID })
}
