import type { Plugin } from "@opencode/plugin/tui"
import { enabledPresetId, type Preset, type PresetScope, type Store } from "../store"

export type PresetRef = { preset: Preset; scope: PresetScope }

export const scopesFor = (ctx: Plugin.Context, sessionID: string) => {
  const session = ctx.data.session.get(sessionID)
  const scopes: PresetScope[] = [{ type: "global" }]
  if (session?.projectID) scopes.push({ type: "project", projectId: session.projectID })
  scopes.push({ type: "session", sessionId: sessionID })
  return scopes
}

export const namedPresets = (ctx: Plugin.Context, store: Store, sessionID: string) =>
  scopesFor(ctx, sessionID).flatMap((scope) =>
    store
      .getPresets(scope)
      .filter((preset) => preset.id !== enabledPresetId)
      .map((preset) => {
        return { preset, scope }
      }),
  )

export const choosePresetScope = (ctx: Plugin.Context, sessionID: string, title: string, preferred?: PresetScope) => {
  const scopes = scopesFor(ctx, sessionID)
  const current = preferred ?? scopes.find((scope) => scope.type === "session")
  return ctx.ui.dialog.select<PresetScope>({
    title,
    ...(current ? { current } : {}),
    options: scopes.map((scope) => {
      return {
        title: scope.type,
        value: scope,
        description:
          scope.type === "project"
            ? scope.projectId
            : scope.type === "session"
              ? sessionID
              : "Available in every project",
      }
    }),
  })
}
