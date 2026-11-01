import { Plugin } from "@opencode/plugin"
import { applyContextOverlays } from "./context"
import { fallbackHint, prefillConfig, rewriteChatRequest } from "./prefill"
import { findActivePreset, isEnabled, openStore } from "./store"

export default Plugin.define({
  id: "oc-purge",
  async setup(ctx) {
    const context = await ctx.session.hook("context", async (input) => {
      const store = openStore(true)
      if (!isEnabled(store, input.sessionID)) return
      const config = prefillConfig(
        findActivePreset(
          store,
          [
            { type: "session", sessionId: input.sessionID },
            { type: "project", projectId: ctx.location.project.id },
            { type: "global" },
          ],
          input.model.providerID,
          input.model.id,
        )?.preset,
      )
      const system = [config.system, config.rules, config.fallback === "system" ? fallbackHint(config) : ""]
        .filter(Boolean)
        .join("\n\n")
      if (system) {
        if (config.systemPosition === "append") input["system"].push({ type: "text", text: system })
        else input["system"].unshift({ type: "text", text: system })
      }
      const overlays = store.getSessionOverlays(input.sessionID)
      if (!Object.keys(overlays).length) return
      const history = await ctx.session.context({ sessionID: input.sessionID }).catch(() => undefined)
      if (!history) return
      input["messages"] = applyContextOverlays(input["messages"], history, overlays)
    })
    const http = await ctx.session.hook("http.request", async (input) => {
      if (
        input["kind"] !== "primary" ||
        input.request.method !== "POST" ||
        !new URL(input.request.url).pathname.endsWith("/chat/completions")
      )
        return
      const store = openStore(true)
      if (!isEnabled(store, input.sessionID)) return
      const preset = findActivePreset(
        store,
        [
          { type: "session", sessionId: input.sessionID },
          { type: "project", projectId: ctx.location.project.id },
          { type: "global" },
        ],
        input.model.providerID,
        input.model.id,
      )?.preset
      if (!preset) return
      const body = (await input.request
        .clone()
        .json()
        .catch(() => undefined)) as Record<string, unknown> | undefined
      if (!body || typeof body !== "object") return
      const config = prefillConfig(preset)
      delete config.system
      delete config.rules
      delete config.fallback
      if (!rewriteChatRequest(body, input.model.providerID, input.model.id, config)) return
      const headers = new Headers(input.request.headers)
      headers.delete("content-length")
      input.request = new Request(input.request, { headers, body: JSON.stringify(body) })
    })
    return async () => {
      await Promise.all([context.dispose(), http.dispose()])
    }
  },
})
