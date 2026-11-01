export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const WHITESPACE_PATTERN = /\s+/g

export const compact = (value: string, limit = 68) => {
  const text = value.replace(WHITESPACE_PATTERN, " ").trim()
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text || "(empty)"
}

export const messagePreview = (
  message:
    | { type: "user"; text: string }
    | {
        type: "assistant"
        content: readonly ({ type: "text" | "reasoning"; text: string } | { type: "tool"; name: string })[]
      },
) => {
  if (message.type === "user") return message.text
  const first = message.content.find((part) => "text" in part && typeof part.text === "string")
  if (first && "text" in first) return first.text
  const tool = message.content.find((part) => part.type === "tool")
  return tool?.type === "tool" ? `[${tool.name}]` : "(no text content)"
}

export const hasOverlay = (message: { type: "user" | "assistant" }, overlay: Record<string, unknown> | undefined) => {
  if (!overlay) return false
  if (overlay["removed"] === true || (Array.isArray(overlay["after"]) && overlay["after"].length > 0)) return true
  if (message.type === "user") return typeof overlay["text"] === "string"
  return isRecord(overlay["content"]) && Object.values(overlay["content"]).some((text) => typeof text === "string")
}

export const partText = (part: unknown) => {
  if (!isRecord(part)) return "(content)"
  if (typeof part["text"] === "string") return part["text"]
  if (part["type"] === "tool" && typeof part["name"] === "string") return `[tool: ${part["name"]}]`
  return typeof part["type"] === "string" ? `[${part["type"]}]` : "(content)"
}
