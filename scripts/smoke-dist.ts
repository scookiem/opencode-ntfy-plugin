import assert from "node:assert/strict"
import plugin from "../dist/index.js"

assert.equal(plugin.id, "ntfy")
assert.equal(typeof plugin.setup, "function")

const calls: Array<{ url: string; title: string }> = []
const originalFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const headers = new Headers(init?.headers)
  const encodedTitle = headers.get("title") ?? ""
  const title = new TextDecoder().decode(Uint8Array.from(encodedTitle, (character) => character.charCodeAt(0)))
  calls.push({ url: String(input), title })
  return new Response("", { status: 200 })
}

const now = Date.now()
const context = {
  options: { topic: "dist-smoke-topic" },
  location: {
    directory: "C:\\mock\\project",
    project: { id: "proj_smoke", directory: "C:\\mock\\project", canonical: "C:\\mock\\project" },
  },
  session: {
    get: async () => ({
      id: "ses_smoke",
      projectID: "proj_smoke",
      title: "dist smoke",
      model: { providerID: "anthropic", id: "claude-sonnet-4-5" },
      outcome: "succeeded" as const,
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: now - 1_000, idle: now },
      location: { directory: "C:\\mock\\project" },
    }),
    context: async () => [{ id: "msg_smoke_idle", type: "idle", outcome: "succeeded" as const }],
  },
  event: {
    subscribe: async function* () {
      yield { id: "evt_smoke", type: "session.idle", data: { sessionID: "ses_smoke" } }
    },
  },
} as never

let cleanup: unknown
try {
  cleanup = await plugin.setup(context)
  await new Promise<void>((resolve) => setTimeout(resolve, 50))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url.endsWith("/dist-smoke-topic"), true)
  assert.match(calls[0].title, /已完成/)
  console.log("PASS dist smoke", { id: plugin.id, keys: Object.keys(plugin), calls })
} finally {
  if (typeof cleanup === "function") await cleanup()
  globalThis.fetch = originalFetch
}
