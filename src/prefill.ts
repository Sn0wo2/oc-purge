import type { Preset } from "./store"

export const adapters = ["kimi", "deepseek", "glm", "qwen", "local", "unknown"] as const

export type Adapter = (typeof adapters)[number]

const LOCAL_PROVIDER_PATTERN = /vllm|v-llm|sglang/
const KIMI_PATTERN = /kimi|moonshot/
const DEEPSEEK_PATTERN = /deepseek/
const GLM_PATTERN = /glm|zai|z\.ai/
const QWEN_PATTERN = /qwen|dashscope/
const QWEN_NO_THINKING_PATTERN =
  /^(?:qwen(?:3-coder|-(?:coder|math))(?:[-:].*)?|qwen2\.5(?:-(?:coder|math))?(?:-\d[^/]*)?)$/
const QWEN_THINKING_PATTERN = /^qwen(?:3(?:\.[3567])?-|-(?:max|plus|flash|turbo|vl))/

export const selectAdapter = (provider: string, model: string): Adapter => {
  const value = `${provider}/${model}`.toLowerCase()
  if (LOCAL_PROVIDER_PATTERN.test(provider.toLowerCase())) return "local"
  if (KIMI_PATTERN.test(value)) return "kimi"
  if (DEEPSEEK_PATTERN.test(value)) return "deepseek"
  if (GLM_PATTERN.test(value)) return "glm"
  if (QWEN_PATTERN.test(value)) return "qwen"
  return "unknown"
}

export interface PrefillConfig {
  system?: string
  rules?: string
  systemPosition?: "prepend" | "append"
  assistantPrefix?: string
  reasoningPrefill?: string
  adapter?: Adapter
  template?: string
  fallback?: "none" | "system"
}

export const prefillConfig = (preset?: Preset): PrefillConfig => {
  const source: Partial<Preset> = preset ?? {}
  const adapter = source["adapter"] as Adapter
  return {
    ...(typeof source["system"] === "string" && { system: source["system"] }),
    ...(typeof source["rules"] === "string" && { rules: source["rules"] }),
    ...((source["systemPosition"] === "prepend" || source["systemPosition"] === "append") && {
      systemPosition: source["systemPosition"],
    }),
    ...(typeof source["assistantPrefix"] === "string" && { assistantPrefix: source["assistantPrefix"] }),
    ...(typeof source["reasoningPrefill"] === "string" && { reasoningPrefill: source["reasoningPrefill"] }),
    ...(adapters.includes(adapter) && { adapter }),
    ...(typeof source["template"] === "string" && { template: source["template"] }),
    ...(source["fallback"] === "system" && { fallback: "system" }),
  }
}

export const fallbackHint = (config: PrefillConfig) =>
  [
    config.assistantPrefix ? `Begin the response with this exact text:\n${config.assistantPrefix}` : "",
    config.reasoningPrefill
      ? `Use the following as reasoning guidance (this is not a prefilled reasoning stream):\n${config.reasoningPrefill}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n")

export const rewriteChatRequest = (
  body: Record<string, unknown>,
  provider: string,
  model: string,
  config: PrefillConfig,
) => {
  if (!Array.isArray(body["messages"])) return false
  const adapter = config.adapter ?? selectAdapter(provider, model)
  let changed = false
  const system = [config.system, config.rules]
    .filter((text) => typeof text === "string" && text.length > 0)
    .join("\n\n")
  if (system) {
    const messages = [...body["messages"]]
    const index =
      config.systemPosition === "append"
        ? messages.findIndex(
            (message) => !message || typeof message !== "object" || (message as { role?: unknown }).role !== "system",
          )
        : 0
    messages.splice(index < 0 ? messages.length : index, 0, { role: "system", content: system })
    body["messages"] = messages
    changed = true
  }
  const prefix = config.assistantPrefix ?? ""
  const reasoning = config.reasoningPrefill ?? ""
  if (!(prefix || reasoning)) return changed
  const fallback = () => {
    if (config.fallback !== "system") return changed
    const hint = fallbackHint(config)
    if (!hint) return changed
    ;(body["messages"] as unknown[]).unshift({ role: "system", content: hint })
    return true
  }
  const messages = body["messages"] as Array<Record<string, unknown>>
  if (messages.at(-1)?.["role"] === "assistant") return fallback()
  if (adapter === "kimi") {
    if (
      body["response_format"] &&
      typeof body["response_format"] === "object" &&
      (body["response_format"] as { type?: unknown })["type"] === "json_object"
    )
      return fallback()
    messages.push({
      role: "assistant",
      content: prefix,
      ...(reasoning ? { reasoning_content: reasoning } : {}),
      partial: true,
    })
  } else if (adapter === "deepseek") {
    messages.push({
      role: "assistant",
      content: prefix,
      ...(reasoning ? { reasoning_content: reasoning } : {}),
      prefix: true,
    })
  } else if (adapter === "qwen" && prefix && !reasoning) {
    const name = model.toLowerCase().split("/").at(-1) ?? ""
    if (
      body["enable_thinking"] === true ||
      !(QWEN_NO_THINKING_PATTERN.test(name) || (QWEN_THINKING_PATTERN.test(name) && body["enable_thinking"] === false))
    )
      return fallback()
    messages.push({ role: "assistant", content: prefix, partial: true })
  } else if (adapter === "local" && (!reasoning || config.template)) {
    messages.push({
      role: "assistant",
      content: config.template
        ? config.template.replaceAll("{{reasoning}}", reasoning).replaceAll("{{prefix}}", prefix)
        : prefix,
    })
    body["continue_final_message"] = true
    body["add_generation_prompt"] = false
  } else {
    return fallback()
  }
  return true
}
