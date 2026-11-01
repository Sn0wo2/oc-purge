import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { isRecord } from "./utils"

export type MessageOverlay = Record<string, unknown>

export type PresetScope =
  | { type: "global" }
  | { type: "project"; projectId: string }
  | { type: "session"; sessionId: string }

export interface Preset {
  id: string
  name: string
  [key: string]: unknown
}

export interface Store {
  getMessageOverlay(sessionId: string, messageId: string): MessageOverlay | undefined
  getSessionOverlays(sessionId: string): Record<string, MessageOverlay>
  setMessageOverlay(sessionId: string, messageId: string, overlay: MessageOverlay): void
  removeMessageOverlay(sessionId: string, messageId: string): boolean
  canUndo(sessionId: string): boolean
  canRedo(sessionId: string): boolean
  undo(sessionId: string): boolean
  redo(sessionId: string): boolean
  getPresets(scope: PresetScope): Preset[]
  getPreset(scope: PresetScope, presetId: string): Preset | undefined
  savePreset(scope: PresetScope, preset: Preset): void
  deletePreset(scope: PresetScope, presetId: string): boolean
}

const HISTORY_LIMIT = 100

export const enabledPresetId = "__oc-purge-enabled__"

export const isEnabled = (store: Store, sessionId: string) =>
  store.getPreset({ type: "session", sessionId }, enabledPresetId)?.["enabled"] === true

export const setEnabled = (store: Store, sessionId: string, enabled: boolean) => {
  const scope = { type: "session", sessionId } as const
  if (enabled) store.savePreset(scope, { id: enabledPresetId, name: "Enabled", enabled: true })
  else store.deletePreset(scope, enabledPresetId)
}

export const findActivePreset = (
  store: Store,
  scopes: readonly PresetScope[],
  providerID?: string,
  modelID?: string,
) => {
  for (const scope of scopes) {
    for (const id of providerID && modelID ? [`active:${providerID}/${modelID}`, "active"] : ["active"]) {
      const preset = store.getPreset(scope, id)
      if (preset) return { preset, scope }
    }
  }
  return undefined
}

const overlayMap = (value: unknown) => {
  const overlays: Record<string, MessageOverlay> = Object.create(null)
  if (!isRecord(value)) return overlays
  for (const [messageId, overlay] of Object.entries(value)) if (isRecord(overlay)) overlays[messageId] = overlay
  return overlays
}

const presetMap = (value: unknown) => {
  const presets: Record<string, Preset> = Object.create(null)
  if (!isRecord(value)) return presets
  for (const [presetId, preset] of Object.entries(value)) {
    if (isRecord(preset) && typeof preset["id"] === "string" && typeof preset["name"] === "string")
      presets[presetId] = preset as Preset
  }
  return presets
}

const scopeKey = (scope: PresetScope) => {
  if (scope.type === "global") return "global"
  const id = scope.type === "project" ? scope.projectId : scope.sessionId
  if (!id) throw new TypeError(`${scope.type}Id must not be empty`)
  return `${scope.type}:${JSON.stringify(id)}`
}

export const openStore = (readOnly = false): Store => {
  const path = process.env["OC_PURGE_STORE"] || join(homedir(), ".local", "share", "opencode", "oc-purge.json")
  const read = () => {
    try {
      return readFileSync(path, "utf8")
    } catch (error) {
      if (isRecord(error) && error["code"] === "ENOENT") return null
      throw error
    }
  }
  const write = (value: string) => {
    if (readOnly) throw new Error("Read-only store")
    mkdirSync(dirname(path), { recursive: true })
    const temporary = `${path}.${crypto.randomUUID()}.tmp`
    try {
      writeFileSync(temporary, value, { encoding: "utf8", mode: 0o600 })
      renameSync(temporary, path)
    } finally {
      rmSync(temporary, { force: true })
    }
  }

  let state: PersistedState = { version: 1, sessions: Object.create(null), presets: Object.create(null) }
  const serialized = read()
  if (serialized) {
    const value: unknown = JSON.parse(serialized)
    if (!isRecord(value) || value["version"] !== 1 || !isRecord(value["sessions"]) || !isRecord(value["presets"]))
      throw new Error("Invalid oc-purge store")
    for (const [sessionId, raw] of Object.entries(value["sessions"])) {
      if (!isRecord(raw)) continue
      state.sessions[sessionId] = {
        overlays: overlayMap(raw["overlays"]),
        undo: Array.isArray(raw["undo"]) ? raw["undo"].map(overlayMap) : [],
        redo: Array.isArray(raw["redo"]) ? raw["redo"].map(overlayMap) : [],
      }
    }
    for (const [scope, raw] of Object.entries(value["presets"])) state.presets[scope] = presetMap(raw)
  }

  const persist = (next: PersistedState) => {
    write(JSON.stringify(next))
    state = next
  }

  const updateOverlays = (sessionId: string, update: (overlays: Record<string, MessageOverlay>) => boolean) => {
    const next = structuredClone(state)
    const session = next.sessions[sessionId] ?? {
      overlays: Object.create(null) as Record<string, MessageOverlay>,
      undo: [],
      redo: [],
    }
    if (!update(session.overlays)) return false
    session.undo.push(structuredClone(state.sessions[sessionId]?.overlays ?? Object.create(null)))
    if (session.undo.length > HISTORY_LIMIT) session.undo.splice(0, session.undo.length - HISTORY_LIMIT)
    session.redo = []
    next.sessions[sessionId] = session
    persist(next)
    return true
  }

  return {
    getMessageOverlay(sessionId, messageId) {
      return structuredClone(state.sessions[sessionId]?.overlays[messageId])
    },

    getSessionOverlays(sessionId) {
      return structuredClone(state.sessions[sessionId]?.overlays ?? Object.create(null))
    },

    setMessageOverlay(sessionId, messageId, overlay) {
      if (!(sessionId && messageId)) throw new TypeError("sessionId and messageId must not be empty")
      if (!isRecord(overlay)) throw new TypeError("overlay must be an object")
      updateOverlays(sessionId, (overlays) => {
        overlays[messageId] = structuredClone(overlay)
        return true
      })
    },

    removeMessageOverlay(sessionId, messageId) {
      if (!(sessionId && messageId)) throw new TypeError("sessionId and messageId must not be empty")
      return updateOverlays(sessionId, (overlays) => {
        if (!Object.hasOwn(overlays, messageId)) return false
        delete overlays[messageId]
        return true
      })
    },

    canUndo(sessionId) {
      return (state.sessions[sessionId]?.undo.length ?? 0) > 0
    },

    canRedo(sessionId) {
      return (state.sessions[sessionId]?.redo.length ?? 0) > 0
    },

    undo(sessionId) {
      if (!state.sessions[sessionId]?.undo.length) return false
      const next = structuredClone(state)
      const session = next.sessions[sessionId]
      if (!session) return false
      const previous = session.undo.pop()
      if (!previous) return false
      session.redo.push(structuredClone(session.overlays))
      session.overlays = previous
      persist(next)
      return true
    },

    redo(sessionId) {
      if (!state.sessions[sessionId]?.redo.length) return false
      const next = structuredClone(state)
      const session = next.sessions[sessionId]
      if (!session) return false
      const nextOverlays = session.redo.pop()
      if (!nextOverlays) return false
      session.undo.push(structuredClone(session.overlays))
      if (session.undo.length > HISTORY_LIMIT) session.undo.splice(0, session.undo.length - HISTORY_LIMIT)
      session.overlays = nextOverlays
      persist(next)
      return true
    },

    getPresets(scope) {
      const presets = state.presets[scopeKey(scope)]
      return presets ? structuredClone(Object.values(presets)) : []
    },

    getPreset(scope, presetId) {
      return structuredClone(state.presets[scopeKey(scope)]?.[presetId])
    },

    savePreset(scope, preset) {
      if (!isRecord(preset) || typeof preset.id !== "string" || !preset.id || typeof preset.name !== "string") {
        throw new TypeError("preset must have a non-empty id and a name")
      }
      const next = structuredClone(state)
      const key = scopeKey(scope)
      const presets = next.presets[key] ?? (Object.create(null) as Record<string, Preset>)
      presets[preset.id] = structuredClone(preset) as Preset
      next.presets[key] = presets
      persist(next)
    },

    deletePreset(scope, presetId) {
      const key = scopeKey(scope)
      if (!(state.presets[key] && Object.hasOwn(state.presets[key], presetId))) return false
      const next = structuredClone(state)
      const presets = next.presets[key]
      if (!presets) return false
      delete presets[presetId]
      if (Object.keys(presets).length === 0) delete next.presets[key]
      persist(next)
      return true
    },
  }
}

interface PersistedState {
  version: 1
  sessions: Record<
    string,
    {
      overlays: Record<string, MessageOverlay>
      undo: Record<string, MessageOverlay>[]
      redo: Record<string, MessageOverlay>[]
    }
  >
  presets: Record<string, Record<string, Preset>>
}
