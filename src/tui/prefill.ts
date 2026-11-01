import type { Plugin } from "@opencode/plugin/tui"
import { type Adapter, adapters, type PrefillConfig, prefillConfig, selectAdapter } from "../prefill"
import { findActivePreset, openStore, type Store } from "../store"
import { compact } from "../utils"
import { editMultiline } from "./editor"
import { choosePresetScope, namedPresets, type PresetRef, scopesFor } from "./session"

type ModelRef = { providerID: string; modelID: string }

const prefillPreview = (config: PrefillConfig, model?: ModelRef, source?: PresetRef) => {
  const adapter = config.adapter ?? (model ? selectAdapter(model.providerID, model.modelID) : "unknown")
  const support =
    adapter === "kimi"
      ? "Kimi partial mode"
      : adapter === "deepseek"
        ? "DeepSeek prefix completion (requires beta endpoint)"
        : adapter === "qwen"
          ? "Qwen partial mode: supported models, non-thinking mode, assistant prefix only; tool compatibility unverified"
          : adapter === "local" && (config.template || !config.reasoningPrefill)
            ? "Local continuation (reasoning requires a custom template)"
            : "Prefix/reasoning prefill unsupported; only system injection will apply"
  return [
    `Model: ${model ? `${model.providerID}/${model.modelID}` : "No model selected (fallback active)"}`,
    `Active preset: ${source ? `${source.preset.id} · ${source.scope.type}` : "none"}`,
    `System: ${compact(config.system ?? "(not set)", 180)}`,
    `Rules: ${compact(config.rules ?? "(not set)", 180)}`,
    `System injection: ${config.systemPosition ?? "prepend"}`,
    `Assistant prefix: ${compact(config.assistantPrefix ?? "(not set)", 180)}`,
    `Reasoning prefill: ${compact(config.reasoningPrefill ?? "(not set)", 180)}`,
    `Adapter: ${config.adapter ?? (model ? `automatic (${selectAdapter(model.providerID, model.modelID)})` : "automatic")}`,
    `Custom template: ${compact(config.template ?? "(not set)", 180)}`,
    `Protocol: ${support}`,
    `Fallback: ${config.fallback === "system" ? "system guidance for all APIs (also sent with native prefill; not true prefill)" : "off"}`,
  ].join("\n")
}

const activePresetValue = (config: PrefillConfig, model?: ModelRef) => {
  return {
    id: model ? `active:${model.providerID}/${model.modelID}` : "active",
    name: "Active prefill",
    kind: "prefill",
    ...config,
    ...(model ? { model: `${model.providerID}/${model.modelID}` } : {}),
  }
}

const confirmPrefillChange = async (
  ctx: Plugin.Context,
  model: ModelRef | undefined,
  before: PrefillConfig,
  beforeSource: PresetRef | undefined,
  after: PrefillConfig,
) =>
  (await ctx.ui.dialog.confirm({
    title: "Preview active prefill change",
    message: `Before:\n${prefillPreview(before, model, beforeSource)}\n\nAfter:\n${prefillPreview(after, model)}`,
    label: { confirm: "Apply", cancel: "Cancel" },
  })) === true

const configurePrefill = async (ctx: Plugin.Context, sessionID: string, store: Store) => {
  const model = ctx.ui.model.current()
  const current = findActivePreset(store, scopesFor(ctx, sessionID), model?.providerID, model?.modelID)
  const existing = prefillConfig(current?.preset)
  const system = await editMultiline(ctx, "Configure system prefill", existing.system ?? "")
  if (system === undefined) return
  const rules = await editMultiline(ctx, "Configure rule set", existing.rules ?? "")
  if (rules === undefined) return
  const systemPosition = await ctx.ui.dialog.select<"prepend" | "append">({
    title: "System injection strategy",
    current: existing.systemPosition ?? "prepend",
    options: [
      { title: "Before existing system messages", value: "prepend" },
      { title: "After existing system messages", value: "append" },
    ],
  })
  if (systemPosition === undefined) return
  const assistantPrefix = await editMultiline(ctx, "Configure assistant prefix", existing.assistantPrefix ?? "")
  if (assistantPrefix === undefined) return
  const reasoningPrefill = await editMultiline(ctx, "Configure reasoning prefill", existing.reasoningPrefill ?? "")
  if (reasoningPrefill === undefined) return
  const adapter = await ctx.ui.dialog.select<Adapter | null>({
    title: "Choose prefill adapter",
    current: existing.adapter ?? null,
    options: [
      { title: "Automatic (detect from provider/model)", value: null },
      ...adapters.map((value) => {
        return { title: value === "local" ? "local / compatible continuation" : value, value }
      }),
    ],
  })
  if (adapter === undefined) return
  const template = await editMultiline(ctx, "Custom template: {{reasoning}} and {{prefix}}", existing.template ?? "")
  if (template === undefined) return
  const fallback = await ctx.ui.dialog.select<"none" | "system">({
    title: "System guidance fallback",
    current: existing.fallback ?? "none",
    options: [
      { title: "Off", value: "none", description: "Do not alter unsupported requests" },
      {
        title: "System prompt guidance",
        value: "system",
        description: "Sent on all APIs, including native prefill; guidance is not real prefill",
      },
    ],
  })
  if (fallback === undefined) return

  const config: PrefillConfig = {
    system,
    rules,
    systemPosition,
    assistantPrefix,
    reasoningPrefill,
    ...(adapter && { adapter }),
    template,
    fallback,
  }
  if (!(await confirmPrefillChange(ctx, model, existing, current, config))) return
  const scope = await choosePresetScope(ctx, sessionID, "Save active prefill scope")
  if (!scope) return
  openStore().savePreset(scope, activePresetValue(config, model))
  ctx.ui.toast.show({ message: `Active prefill saved (${scope.type}).`, variant: "success", sessionID })
}

const savePrefillPreset = async (ctx: Plugin.Context, sessionID: string, store: Store) => {
  const model = ctx.ui.model.current()
  const active = findActivePreset(store, scopesFor(ctx, sessionID), model?.providerID, model?.modelID)
  const name = await ctx.ui.dialog.prompt({ title: "Save active prefill as preset", placeholder: "Preset name" })
  if (name === undefined) return
  if (!name.trim()) {
    ctx.ui.toast.show({ message: "Preset name cannot be empty.", variant: "warning", sessionID })
    return
  }
  const scope = await choosePresetScope(ctx, sessionID, "Save prefill preset scope")
  if (!scope) return
  openStore().savePreset(scope, {
    id: crypto.randomUUID(),
    name: name.trim(),
    kind: "prefill",
    ...prefillConfig(active?.preset),
  })
  ctx.ui.toast.show({
    message: `Saved prefill preset “${name.trim()}” (${scope.type}).`,
    variant: "success",
    sessionID,
  })
}

const activatePrefillPreset = async (ctx: Plugin.Context, sessionID: string, store: Store) => {
  const presets = namedPresets(ctx, store, sessionID).filter(
    ({ preset }) => preset["kind"] === "prefill" && preset.id !== "active" && !preset.id.startsWith("active:"),
  )
  if (!presets.length) {
    ctx.ui.toast.show({ message: "No named prefill presets are saved yet.", variant: "info", sessionID })
    return
  }
  const selected = await ctx.ui.dialog.select<PresetRef>({
    title: "Activate a prefill preset",
    options: presets.map((ref) => {
      return {
        title: `${ref.preset.name} · ${ref.scope.type}`,
        value: ref,
        description: compact(prefillPreview(prefillConfig(ref.preset), ctx.ui.model.current()), 150),
      }
    }),
  })
  if (!selected) return
  const model = ctx.ui.model.current()
  const current = findActivePreset(store, scopesFor(ctx, sessionID), model?.providerID, model?.modelID)
  const config = prefillConfig(selected.preset)
  if (!(await confirmPrefillChange(ctx, model, prefillConfig(current?.preset), current, config))) return
  const scope = await choosePresetScope(ctx, sessionID, "Activate prefill in scope")
  if (!scope) return
  openStore().savePreset(scope, activePresetValue(config, model))
  ctx.ui.toast.show({ message: `Activated “${selected.preset.name}” (${scope.type}).`, variant: "success", sessionID })
}

const showPrefillStatus = async (ctx: Plugin.Context, sessionID: string, store: Store) => {
  const model = ctx.ui.model.current()
  const active = findActivePreset(store, scopesFor(ctx, sessionID), model?.providerID, model?.modelID)
  await ctx.ui.dialog.alert({
    title: "Active prefill status",
    message: prefillPreview(prefillConfig(active?.preset), model, active),
  })
}

const deleteActivePrefill = async (ctx: Plugin.Context, sessionID: string, store: Store) => {
  const model = ctx.ui.model.current()
  const active = findActivePreset(store, scopesFor(ctx, sessionID), model?.providerID, model?.modelID)
  if (!active) {
    ctx.ui.toast.show({ message: "No active prefill override to delete.", variant: "info", sessionID })
    return
  }
  if (
    !(await ctx.ui.dialog.confirm({
      title: "Delete active prefill override",
      message: `Delete ${active.preset.id} from ${active.scope.type}?\n\n${prefillPreview(prefillConfig(active.preset), ctx.ui.model.current(), active)}\n\nThe next matching active preset will be used, if available.`,
      label: { confirm: "Delete", cancel: "Cancel" },
    }))
  )
    return
  openStore().deletePreset(active.scope, active.preset.id)
  ctx.ui.toast.show({
    message: `Deleted active prefill override (${active.scope.type}).`,
    variant: "success",
    sessionID,
  })
}

export const managePrefill = async (ctx: Plugin.Context, sessionID: string, store: Store) => {
  const model = ctx.ui.model.current()
  const active = findActivePreset(store, scopesFor(ctx, sessionID), model?.providerID, model?.modelID)
  const action = await ctx.ui.dialog.select<"configure" | "activate" | "save" | "status" | "delete">({
    title: "Configure chat prefill",
    options: [
      {
        title: "Configure active prefill…",
        value: "configure",
        description: "System, assistant/reasoning prefixes, adapter, and template",
      },
      { title: "Activate a named prefill preset…", value: "activate" },
      { title: "Save active prefill as named preset…", value: "save" },
      { title: "Show active status / preview", value: "status" },
      ...(active ? [{ title: "Delete active prefill override…", value: "delete" as const }] : []),
    ],
  })
  if (action === "configure") await configurePrefill(ctx, sessionID, store)
  else if (action === "activate") await activatePrefillPreset(ctx, sessionID, store)
  else if (action === "save") await savePrefillPreset(ctx, sessionID, store)
  else if (action === "status") await showPrefillStatus(ctx, sessionID, store)
  else if (action === "delete") await deleteActivePrefill(ctx, sessionID, store)
}

export const managePresets = async (ctx: Plugin.Context, sessionID: string, store: Store) => {
  const presets = namedPresets(ctx, store, sessionID).filter(
    ({ preset }) => preset.id !== "active" && !preset.id.startsWith("active:"),
  )
  if (!presets.length) {
    ctx.ui.toast.show({ message: "No named presets are saved.", variant: "info", sessionID })
    return
  }
  const selected = await ctx.ui.dialog.select<PresetRef>({
    title: "Delete a saved preset",
    options: presets.map((ref) => {
      return {
        title: `${ref.preset.name} · ${ref.scope.type}`,
        value: ref,
        description:
          ref.preset["kind"] === "prefill"
            ? compact(prefillPreview(prefillConfig(ref.preset)), 150)
            : typeof ref.preset["value"] === "string"
              ? compact(ref.preset["value"])
              : "Text replacement preset",
      }
    }),
  })
  if (!selected) return
  if (
    !(await ctx.ui.dialog.confirm({
      title: "Delete preset",
      message: `Delete “${selected.preset.name}”?`,
      label: { confirm: "Delete", cancel: "Cancel" },
    }))
  )
    return
  openStore().deletePreset(selected.scope, selected.preset.id)
  ctx.ui.toast.show({ message: `Deleted preset “${selected.preset.name}”.`, variant: "success", sessionID })
}
