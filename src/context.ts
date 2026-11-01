import type { Plugin } from "@opencode/plugin"
import type { SessionContext } from "@opencode/plugin/promise/session"
import type { MessageOverlay } from "./store"
import { isRecord } from "./utils"

type Message = SessionContext["messages"][number]
type SessionMessageInfo = Awaited<ReturnType<Plugin.Context["session"]["context"]>>[number]

const isTextPart = (
  part: Message["content"][number] | undefined,
): part is Extract<Message["content"][number], { type: "text" | "reasoning" }> =>
  part?.type === "text" || part?.type === "reasoning"

const replaceTextPart = (part: Extract<Message["content"][number], { type: "text" | "reasoning" }>, text: string) => {
  const replacement = { ...part, text }
  delete replacement.providerMetadata
  if (replacement.type === "reasoning") delete replacement.encrypted
  return replacement
}

const createSyntheticMessage = (anchor: Message, id: string, role: "user" | "assistant", text: string) =>
  Object.assign(Object.create(Object.getPrototypeOf(anchor)), {
    id,
    role,
    content: [{ type: "text", text }],
  }) as Message

export const applyContextOverlays = (
  messages: readonly Message[],
  history: readonly SessionMessageInfo[] | undefined,
  overlays: Record<string, MessageOverlay>,
) => {
  const originals = new Map<string, SessionMessageInfo>(history?.map((message) => [message.id, message]))
  const usedIDs = new Set<string>(history?.map((message) => message.id))
  for (const message of messages) {
    if (message.id) usedIDs.add(message.id)
  }

  const removed = new Set<number>()
  const replacements = new Map<number, Message>()
  const additions = new Map<number, Message[]>()

  for (const [messageIndex, message] of messages.entries()) {
    const id = message.id
    if (!(id && Object.hasOwn(overlays, id)) || (message.role !== "user" && message.role !== "assistant")) continue
    const overlay = overlays[id]
    if (!overlay) continue
    const original = originals.get(id)
    if (original && original.type !== message.role) continue

    let content: Message["content"][number][] | undefined
    const contentForEdit = () => (content ??= [...message.content])

    if (message.role === "user" && typeof overlay["text"] === "string") {
      let modelIndex: number | undefined
      if (original?.type === "user") {
        const index = (original.skills ?? []).filter((skill) => skill.text !== undefined).length
        const part = message.content[index]
        if (part?.type === "text" && part.text === original.text) modelIndex = index
      } else {
        const indices = message.content.flatMap((part, index) => (part.type === "text" ? [index] : []))
        if (indices.length === 1) modelIndex = indices[0]
      }
      if (modelIndex !== undefined) {
        const part = message.content[modelIndex]
        if (part?.type === "text") contentForEdit()[modelIndex] = replaceTextPart(part, overlay["text"])
      }
    }

    if (message.role === "assistant" && isRecord(overlay["content"])) {
      const edits = overlay["content"]
      if (original?.type === "assistant") {
        let cursor = 0
        for (const [sessionIndex, source] of original.content.entries()) {
          let modelIndex: number | undefined
          for (let index = cursor; index < message.content.length; index++) {
            const part = message.content[index]
            if (
              source.type === "tool"
                ? part?.type === "tool-call" && part.id === source.id
                : isTextPart(part) && part.type === source.type && part.text === source.text
            ) {
              modelIndex = index
              break
            }
          }
          if (modelIndex === undefined) continue
          cursor = modelIndex + 1
          const replacement = edits[String(sessionIndex)]
          const part = message.content[modelIndex]
          if (typeof replacement === "string" && isTextPart(part))
            contentForEdit()[modelIndex] = replaceTextPart(part, replacement)
        }
      } else if (message.content.every((part) => part.type === "text" || part.type === "reasoning")) {
        for (const [sessionIndex, replacement] of Object.entries(edits)) {
          const modelIndex = Number(sessionIndex)
          const part = Number.isInteger(modelIndex) ? message.content[modelIndex] : undefined
          if (typeof replacement === "string" && isTextPart(part))
            contentForEdit()[modelIndex] = replaceTextPart(part, replacement)
        }
      }
    }

    if (content) {
      const replaced = Object.assign(Object.create(Object.getPrototypeOf(message)), message, { content }) as Message
      Reflect.deleteProperty(replaced, "providerMetadata")
      replacements.set(messageIndex, replaced)
    }

    const protectedContent =
      message.content.some(
        (part) => part.type === "media" || part.type === "tool-call" || part.type === "tool-result",
      ) ||
      (original?.type === "user" && (original.files?.length ?? 0) > 0) ||
      (original?.type === "assistant" && original.content.some((part) => part.type === "tool"))

    if (overlay["removed"] === true && !protectedContent && messages[messageIndex + 1]?.role !== "tool")
      removed.add(messageIndex)

    if (Array.isArray(overlay["after"])) {
      const synthetic: Message[] = []
      for (const value of overlay["after"]) {
        if (!isRecord(value)) continue
        const { id: additionID, role, text } = value
        if (typeof additionID !== "string" || (role !== "user" && role !== "assistant") || typeof text !== "string")
          continue
        let uniqueID = additionID
        let suffix = 1
        while (usedIDs.has(uniqueID)) uniqueID = `${additionID}:${suffix++}`
        usedIDs.add(uniqueID)
        synthetic.push(createSyntheticMessage(message, uniqueID, role, text))
      }
      if (synthetic.length) {
        let insertionIndex = messageIndex
        if (message.role === "assistant") {
          const pendingCalls = new Set(message.content.flatMap((part) => (part.type === "tool-call" ? [part.id] : [])))
          for (let index = messageIndex + 1; pendingCalls.size && index < messages.length; index++) {
            const next = messages[index]
            if (next?.role !== "tool") break
            const results = next.content.filter((part) => part.type === "tool-result")
            if (!results.length || results.some((part) => !pendingCalls.has(part.id))) break
            for (const result of results) pendingCalls.delete(result.id)
            insertionIndex = index
          }
        }
        const queued = additions.get(insertionIndex) ?? []
        queued.push(...synthetic)
        additions.set(insertionIndex, queued)
      }
    }
  }

  const output: Message[] = []
  for (const [messageIndex, message] of messages.entries()) {
    if (!removed.has(messageIndex)) output.push(replacements.get(messageIndex) ?? message)
    const queued = additions.get(messageIndex)
    if (queued) output.push(...queued)
  }

  if (!output.length && messages.length) {
    const anchor = messages[0]
    return anchor ? [createSyntheticMessage(anchor, crypto.randomUUID(), "user", "Continue.")] : output
  }
  const final = output.at(-1)
  if (messages.at(-1)?.role !== "assistant" && final?.role === "assistant")
    return [...output, createSyntheticMessage(final, crypto.randomUUID(), "user", "Continue.")]
  return output
}
