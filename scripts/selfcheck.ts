import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import ntfyPlugin, { createBoundedKeyMap, createBoundedKeySet, formDedupKey, parseJsonc, permissionToolKey, reconnectDelayMs, sessionTimeoutValue } from "../src/index.ts"

type Outcome = "succeeded" | "failed" | "interrupted"
type PluginContext = Parameters<typeof ntfyPlugin.setup>[0]

const ENV_KEYS = [
  "NTFY_SERVER",
  "NTFY_TOPIC",
  "NTFY_TOKEN",
  "NTFY_TAG",
  "NTFY_PRIORITY",
  "NTFY_NOTIFY_ROOT",
  "NTFY_NOTIFY_CHILDREN",
  "NTFY_DEBUG",
  "NTFY_SESSION_TIMEOUT_MS",
  "NTFY_CONFIG_FILE",
  "HOME",
  "USERPROFILE",
]

interface FetchCall {
  url: string
  headers: Record<string, string>
  body: string
}

interface MockEvent {
  id: string
  type: string
  data: Record<string, unknown>
}

interface CaseOptions {
  options: Record<string, unknown>
  env?: Record<string, string | undefined>
  parentID?: string
  outcome: Outcome
  assistantModel?: { providerID: string; id: string; variant?: string }
  events?: MockEvent[]
  locationProjectID?: string
  sessionProjectID?: string
  sessionGetFails?: boolean
  sessionGetHangsFor?: string
  settleMs?: number
  expectNoProcessError?: boolean
  captureLogs?: boolean
  captureErrors?: boolean
  assertLogs?(logs: string[]): void
  assertErrors?(errors: string[]): void
  assertCalls(calls: FetchCall[]): void
}

function saveEnvironment(): Record<string, string | undefined> {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
}

function clearEnvironment(): void {
  for (const key of ENV_KEYS) delete process.env[key]
}

function restoreEnvironment(saved: Record<string, string | undefined>): void {
  clearEnvironment()
  for (const [key, value] of Object.entries(saved)) {
    if (value !== undefined) process.env[key] = value
  }
}

// Hermetic config environment: the explicit configFile points at a path
// that cannot exist AND the home directory points at a fresh temp path, so
// a case only sees an external config file when it opts in via
// options.env. Machines that happen to ship
// ~/.config/opencode/ntfy.local.jsonc must not perturb the suite, and the
// default-path auto-create must never write into the developer's real home.
// The returned temp home is removed by the caller's finally block.
function useHermeticConfigEnv(): string {
  const isolatedHome = mkdtempSync(join(tmpdir(), "ntfy-selfcheck-home-"))
  process.env.NTFY_CONFIG_FILE = join(
    tmpdir(),
    `ntfy-selfcheck-absent-${process.pid}-${Math.random().toString(36).slice(2)}.jsonc`,
  )
  process.env.HOME = join(isolatedHome, "no-such-home")
  process.env.USERPROFILE = join(isolatedHome, "no-such-home")
  return isolatedHome
}

function headersToObject(headers: HeadersInit | undefined): Record<string, string> {
  const result: Record<string, string> = {}
  new Headers(headers).forEach((value, key) => {
    result[key] = key === "title"
      ? new TextDecoder().decode(Uint8Array.from(value, (character) => character.charCodeAt(0)))
      : value
  })
  return result
}

async function* mockEvents(
  signal: AbortSignal,
  events: ReadonlyArray<MockEvent> = [{
    id: "evt1",
    type: "session.idle",
    data: { sessionID: "ses_xxx" },
  }],
): AsyncGenerator<unknown> {
  if (signal.aborted) return

  let aborted = false
  const onAbort = () => {
    aborted = true
  }
  signal.addEventListener("abort", onAbort, { once: true })
  try {
    for (const event of events) {
      if (aborted) return
      yield event
    }
  } finally {
    signal.removeEventListener("abort", onAbort)
  }
}

async function waitForEventLoop(settleMs = 10): Promise<void> {
  for (let index = 0; index < 4; index += 1) await Promise.resolve()
  await new Promise<void>((resolve) => setTimeout(resolve, settleMs))
}

async function runCase(name: string, options: CaseOptions): Promise<void> {
  const savedEnvironment = saveEnvironment()
  const originalFetch = globalThis.fetch
  const originalConsoleError = console.error
  const calls: FetchCall[] = []
  const consoleErrors: string[] = []
  const logs: string[] = []
  clearEnvironment()
  const isolatedHome = useHermeticConfigEnv()
  for (const [key, value] of Object.entries(options.env ?? {})) {
    // undefined deletes the key — e.g. cases that need the default-path
    // search unset NTFY_CONFIG_FILE explicitly.
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }

  globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      headers: headersToObject(init?.headers),
      body: typeof init?.body === "string" ? init.body : String(init?.body ?? ""),
    })
    return new Response("", { status: 200 })
  }

  if (options.expectNoProcessError || options.captureErrors || options.captureLogs) {
    console.error = (...args: unknown[]): void => {
      const line = args.map((arg) => String(arg)).join(" ")
      if (options.expectNoProcessError || options.captureErrors) consoleErrors.push(line)
      if (options.captureLogs) logs.push(line)
    }
  }

  const T0 = 1_700_000_000_000
  const sessionProjectID = Object.prototype.hasOwnProperty.call(options, "sessionProjectID")
    ? options.sessionProjectID
    : "proj_1"
  const locationProjectID = Object.prototype.hasOwnProperty.call(options, "locationProjectID")
    ? options.locationProjectID
    : "proj_1"
  const session = {
    id: "ses_xxx",
    parentID: options.parentID,
    projectID: sessionProjectID,
    title: "Mock task",
    model: { providerID: "anthropic", id: "claude-sonnet-4-5" },
    outcome: options.outcome,
    cost: 0,
    tokens: {
      input: 800,
      output: 300,
      reasoning: 100,
      cache: { read: 200, write: 0 },
    },
    time: { created: T0, idle: T0 + 83_000 },
    location: { directory: "C:\\mock\\project" },
  }

  const context = {
    options: options.options,
    location: {
      directory: "C:\\mock\\project",
      project: {
        id: locationProjectID,
        directory: "C:\\mock\\project",
        canonical: "C:\\mock\\project",
      },
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        if (options.sessionGetFails) throw new Error("mock session lookup failed")
        // A wedged host lookup: never settles, so only the configured
        // timeout can unblock the subscription loop.
        if (options.sessionGetHangsFor === sessionID) return await new Promise<typeof session>(() => {})
        return session
      },
      context: async () => [
        ...(options.assistantModel
          ? [{ id: "msg_asst", type: "assistant", model: options.assistantModel }]
          : []),
        { id: "msg_idle1", type: "idle", outcome: options.outcome },
      ],
    },
    event: {
      subscribe: ({ signal }: { signal: AbortSignal }) => mockEvents(signal, options.events),
    },
  } as unknown as PluginContext

  let cleanup: Awaited<ReturnType<typeof ntfyPlugin.setup>>
  try {
    cleanup = await ntfyPlugin.setup(context)
    await waitForEventLoop(options.settleMs ?? 10)
    options.assertCalls(calls)
    if (options.assertLogs) options.assertLogs(logs)
    if (options.assertErrors) options.assertErrors(consoleErrors)
    if (options.expectNoProcessError) {
      assert.equal(
        consoleErrors.some((line) => line.includes("Failed to process event")),
        false,
        "timeouts must skip events at debug level, not log process errors",
      )
    }
    console.log(`PASS ${name}`)
  } finally {
    if (typeof cleanup === "function") await cleanup()
    globalThis.fetch = originalFetch
    console.error = originalConsoleError
    rmSync(isolatedHome, { recursive: true, force: true })
    restoreEnvironment(savedEnvironment)
  }
}

// Reconnect semantics for the hardened consumer: a transport that keeps
// dropping must be retried forever (never a give-up), each retry logged at
// debug level with a growing, capped backoff, and cleanup() must abort the
// pending wait immediately so no further subscribe() call happens.
async function runReconnectCase(): Promise<void> {
  const savedEnvironment = saveEnvironment()
  const originalConsoleError = console.error
  const logs: string[] = []
  clearEnvironment()
  const isolatedHome = useHermeticConfigEnv()
  process.env.NTFY_DEBUG = "1"
  console.error = (...args: unknown[]): void => {
    logs.push(args.map((arg) => String(arg)).join(" "))
  }

  let subscribeCalls = 0
  const context = {
    options: { topic: "mock-topic" },
    location: { directory: "C:\\mock\\project", project: { id: "proj_1" } },
    session: { get: async () => ({}), context: async () => [] },
    event: {
      // Ends immediately, every time: simulates a transport that keeps dying.
      subscribe: async function* subscribe(): AsyncGenerator<unknown> {
        subscribeCalls += 1
      },
    },
  } as unknown as PluginContext

  let cleanup: Awaited<ReturnType<typeof ntfyPlugin.setup>> | undefined
  try {
    cleanup = await ntfyPlugin.setup(context)
    // 2.4s spans the first (~1s) and second (~2s) backoff windows, so the
    // plugin must still be reconnecting rather than sitting in silence.
    await waitForEventLoop(2_400)
    assert.ok(subscribeCalls >= 2, `expected repeated reconnects, got ${subscribeCalls}`)
    const reconnectLogs = logs.filter((line) => line.includes("[ntfy-debug] subscribe.reconnect"))
    assert.ok(reconnectLogs.length >= 2, `expected debug reconnect logs, got ${reconnectLogs.length}`)
    assert.equal(logs.some((line) => line.includes("gave up")), false, "reconnects must never give up")
    const delays = reconnectLogs.map((line) => Number(/delay=(\d+)ms/.exec(line)?.[1]))
    assert.ok(delays[0] >= 900 && delays[0] <= 1_100, `first backoff ~1s, got ${delays[0]}`)
    assert.ok(delays[1] >= 1_800 && delays[1] <= 2_200, `second backoff ~2s, got ${delays[1]}`)
    assert.ok(
      delays.every((delay) => Number.isFinite(delay) && delay > 0),
      "backoff must always be positive (never a tight loop)",
    )

    // cleanup() must abort the pending reconnect wait at once: no further
    // subscribe() call may happen, even though 1.5s exceeds the minimum delay.
    cleanup?.()
    const frozenAtCleanup = subscribeCalls
    await waitForEventLoop(1_500)
    assert.equal(subscribeCalls, frozenAtCleanup, "cleanup must stop reconnecting")
    console.log("PASS reconnects forever with capped backoff; abort stops the loop")
  } finally {
    cleanup?.()
    console.error = originalConsoleError
    rmSync(isolatedHome, { recursive: true, force: true })
    restoreEnvironment(savedEnvironment)
  }
}

// Temp-dir harness for the external local config file: every fixture lives
// under a unique mkdtemp directory and is removed afterwards, so the suite
// never touches the repo or the developer's real OpenCode config directory.
async function withTempConfigDir(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "ntfy-selfcheck-"))
  try {
    await run(directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  assert.equal(typeof globalThis.fetch, "function", "Node fetch is required")

  // --- Unit: bounded dedup set (risk 1) --------------------------------
  {
    const bounded = createBoundedKeySet()
    for (let index = 0; index < 21; index += 1) bounded.add(`key-${index}`)
    assert.equal(bounded.size, 20, "dedup set must cap at 20 entries")
    assert.equal(bounded.has("key-0"), false, "oldest key must be evicted")
    assert.equal(bounded.has("key-1"), true, "recent keys must survive")
    assert.equal(bounded.has("key-20"), true, "newest key must be kept")
    bounded.add("key-1") // duplicate add: no eviction, no LRU refresh
    assert.equal(bounded.size, 20, "duplicate add must not evict others")
    assert.equal(bounded.has("key-2"), true, "duplicate add must not drop neighbors")
    console.log("PASS bounded dedup set evicts oldest keys at the cap")
  }

  // --- Unit: permission tool-call key (dual identity) -------------------
  {
    const source = { type: "tool", messageID: "msg_1", id: "tool_1" }
    assert.equal(permissionToolKey("ses_1", source), "ses_1:msg_1:tool_1", "tool key = session + messageID + tool id")
    assert.equal(permissionToolKey("ses_1", undefined), undefined, "no source → fall back to content key")
    assert.equal(permissionToolKey("ses_1", { type: "tool", messageID: "", id: "tool_1" }), undefined, "blank messageID → no tool key")
    assert.equal(permissionToolKey("ses_1", { type: "tool", messageID: "msg_1", id: "" }), undefined, "blank tool id → no tool key")
    assert.equal(permissionToolKey("", source), undefined, "blank session → no tool key")
    assert.equal(
      permissionToolKey("ses_1", { type: "tool", messageID: "msg_1", id: "tool_1" }),
      permissionToolKey("ses_1", { type: "tool", messageID: "msg_1", id: "tool_1" }),
      "re-asks of the same tool call must derive the same key",
    )
    assert.notEqual(
      permissionToolKey("ses_1", { type: "tool", messageID: "msg_1", id: "tool_1" }),
      permissionToolKey("ses_1", { type: "tool", messageID: "msg_1", id: "tool_2" }),
      "different tool calls must derive different keys",
    )
    console.log("PASS permission tool key pins session + messageID + tool call id")
  }

  // --- Unit: form dedup key pins the stable form.id ----------------------
  {
    assert.equal(formDedupKey({ id: "frm_1", sessionID: "ses_1", title: "t" }), "frm_1", "form.id is the sole identity when present")
    assert.equal(
      formDedupKey({ id: "frm_1", sessionID: "ses_1", title: "t" }),
      formDedupKey({ id: "frm_1", sessionID: "ses_1", title: "t" }),
      "re-delivery of one form id derives the same key",
    )
    assert.notEqual(
      formDedupKey({ id: "frm_1", sessionID: "ses_1", title: "t" }),
      formDedupKey({ id: "frm_2", sessionID: "ses_1", title: "t" }),
      "different form ids derive different keys even with the same title",
    )
    assert.equal(formDedupKey({ sessionID: "ses_1", title: "t" }), "ses_1:t", "missing id falls back to sessionID:title")
    assert.equal(formDedupKey({ id: "", sessionID: "ses_1", title: "t" }), "ses_1:t", "blank id falls back to sessionID:title")
    assert.equal(formDedupKey({ id: "   ", sessionID: "ses_1" }), "ses_1:", "whitespace id falls back; missing title yields empty")
    assert.equal(formDedupKey(undefined), "未知:", "missing form still yields a stable fallback key")
    console.log("PASS form dedup key pins the stable form.id with a content fallback")
  }

  // --- Unit: bounded request → tool-call mapping ------------------------
  {
    const requests = createBoundedKeyMap()
    requests.set("perm_1", "ses_1:msg_1:tool_1")
    assert.equal(requests.has("perm_1"), true)
    assert.equal(requests.get("perm_1"), "ses_1:msg_1:tool_1")
    assert.equal(requests.size, 1)
    assert.equal(requests.delete("perm_1"), true, "delete reports the mapping it removed")
    assert.equal(requests.has("perm_1"), false, "mapping must be gone after delete")
    assert.equal(requests.delete("perm_1"), false, "second delete finds nothing")
    requests.set("perm_2", undefined) // source-less ask: no tool-call key
    assert.equal(requests.get("perm_2"), undefined)
    assert.equal(requests.has("perm_2"), true, "source-less requests are still tracked for cleanup")
  }

  {
    // Fresh map so the cap check mirrors the bounded-set test exactly.
    const capped = createBoundedKeyMap()
    for (let index = 0; index < 21; index += 1) capped.set(`perm_${index}`, `tool_${index}`)
    assert.equal(capped.size, 20, "request map must cap at DEDUP_ENTRY_LIMIT")
    assert.equal(capped.has("perm_0"), false, "oldest mapping must be evicted at the cap")
    assert.equal(capped.has("perm_20"), true, "newest mapping must be kept")
    console.log("PASS request → tool-call map deletes on reply and evicts at the cap")
  }

  // --- Unit: session timeout resolution + clamping (risk 3) ------------
  {
    assert.equal(sessionTimeoutValue(undefined), 5_000, "missing → default")
    assert.equal(sessionTimeoutValue(null), 5_000, "null → default")
    assert.equal(sessionTimeoutValue(""), 5_000, "empty string → default")
    assert.equal(sessionTimeoutValue("   "), 5_000, "whitespace → default")
    assert.equal(sessionTimeoutValue("abc"), 5_000, "non-numeric → default")
    assert.equal(sessionTimeoutValue(-1), 5_000, "negative → default")
    assert.equal(sessionTimeoutValue(0), 5_000, "zero → default")
    assert.equal(sessionTimeoutValue(true), 5_000, "wrong type → default")
    assert.equal(sessionTimeoutValue(999), 1_000, "below min → clamped up")
    assert.equal(sessionTimeoutValue(31_415), 30_000, "above max → clamped down")
    assert.equal(sessionTimeoutValue(2_500), 2_500, "in-range number kept")
    assert.equal(sessionTimeoutValue("2500"), 2_500, "numeric string parsed")
    assert.equal(sessionTimeoutValue(" 2500 "), 2_500, "padded numeric string parsed")
    console.log("PASS session timeout resolution falls back and clamps")
  }

  // --- Unit: reconnect backoff is exponential, capped, never tight ------
  {
    const first = reconnectDelayMs(0)
    const second = reconnectDelayMs(1)
    assert.ok(first >= 900 && first <= 1_100, `attempt 0 ≈1s (±jitter), got ${first}`)
    assert.ok(second >= 1_800 && second <= 2_200, `attempt 1 ≈2s (±jitter), got ${second}`)
    assert.ok(second > first, "backoff must grow")
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const delay = reconnectDelayMs(attempt)
      assert.ok(delay >= 500, `floor 500ms keeps retries off a tight loop, got ${delay} at attempt ${attempt}`)
      assert.ok(delay <= 66_000, `60s cap + 10% jitter, got ${delay} at attempt ${attempt}`)
    }
    // Capping, not unbounded growth: huge attempt counts stay at ~60s.
    for (const attempt of [30, 500, 100_000]) {
      const delay = reconnectDelayMs(attempt)
      assert.ok(delay >= 54_000 && delay <= 66_000, `cap holds at attempt ${attempt}, got ${delay}`)
    }
    console.log("PASS reconnect backoff grows exponentially and caps at 60s")
  }

  await runCase("root success", {
    options: { topic: "mock-topic" },
    outcome: "succeeded",
    assistantModel: { providerID: "anthropic", id: "claude-opus-4-1" },
    assertCalls(calls) {
      assert.equal(calls.length, 1)
      assert.equal(calls[0].url.endsWith("/mock-topic"), true)
      assert.match(calls[0].body, /主任务/)
       assert.match(calls[0].body, /anthropic\/claude-opus-4-1/)
       assert.doesNotMatch(calls[0].body, /claude-sonnet-4-5/)
       assert.match(calls[0].body, /1m 23s/)
        assert.match(calls[0].body, /Token：输入 0\.08万｜输出 0\.03万｜推理 0\.01万｜缓存读 0\.02万｜缓存写 0万｜缓存率 20\.0%/)
       assert.doesNotMatch(calls[0].headers.title, /✅|❌|🚀|🚨|🔁|⏸️/)
       assert.match(calls[0].headers.title, /\[opencode\].*主任务.*已完成/)
       assert.ok(calls[0].body.includes("项目：project"))
       assert.ok(calls[0].body.includes("目录：C:\\mock\\project"))
      assert.equal(calls[0].headers.tags, "white_check_mark")
      assert.equal(calls[0].headers.priority, "3")
    },
  })

  await runCase("child disabled", {
    options: { topic: "mock-topic", notifyChildren: false },
    parentID: "ses_parent",
    outcome: "succeeded",
    assertCalls(calls) {
      assert.equal(calls.length, 0)
    },
  })

  await runCase("failed outcome", {
    options: { topic: "mock-topic" },
    outcome: "failed",
    assertCalls(calls) {
      assert.equal(calls.length, 1)
      assert.equal(calls[0].headers.tags, "warning")
      assert.equal(calls[0].headers.priority, "4")
       assert.doesNotMatch(calls[0].headers.title, /✅|❌|🚀|🚨|🔁|⏸️/)
    },
  })

  await runCase("missing topic", {
    options: {},
    outcome: "succeeded",
    assertCalls(calls) {
      assert.equal(calls.length, 0)
    },
  })

  await runCase("assistant without model falls back to session model", {
    options: { topic: "mock-topic" },
    outcome: "succeeded",
    assertCalls(calls) {
      assert.equal(calls.length, 1)
      assert.match(calls[0].body, /anthropic\/claude-sonnet-4-5/)
    },
  })

  await runCase("execution failed", {
    options: { topic: "mock-topic" },
    outcome: "failed",
    events: [{
      id: "evt_failed",
      type: "session.execution.failed",
      data: {
        sessionID: "ses_xxx",
        error: { type: "ProviderError", message: "mock execution failed" },
      },
    }],
    assertCalls(calls) {
      assert.equal(calls.length, 1)
      assert.equal(calls[0].headers.tags, "x")
      assert.equal(calls[0].headers.priority, "5")
      assert.match(calls[0].body, /失败/)
       assert.doesNotMatch(calls[0].headers.title, /✅|❌|🚀|🚨|🔁|⏸️/)
    },
  })

  await runCase("execution succeeded", {
    options: { topic: "mock-topic" },
    outcome: "succeeded",
    events: [{
      id: "evt_succeeded",
      type: "session.execution.succeeded",
      data: { sessionID: "ses_xxx" },
    }],
    assertCalls(calls) {
      assert.equal(calls.length, 1)
      assert.equal(calls[0].headers.tags, "white_check_mark")
      assert.equal(calls[0].headers.priority, "3")
       assert.doesNotMatch(calls[0].headers.title, /✅|❌|🚀|🚨|🔁|⏸️/)
    },
  })

  await runCase("execution succeeded and idle are deduplicated", {
    options: { topic: "mock-topic" },
    outcome: "succeeded",
    events: [
      {
        id: "evt_succeeded_then_idle",
        type: "session.execution.succeeded",
        data: { sessionID: "ses_xxx" },
      },
      {
        id: "evt_idle_after_succeeded",
        type: "session.idle",
        data: { sessionID: "ses_xxx" },
      },
    ],
    assertCalls(calls) {
      assert.equal(calls.length, 1)
      assert.equal(calls[0].headers.tags, "white_check_mark")
    },
  })

  await runCase("permission asked", {
    options: { topic: "mock-topic" },
    outcome: "succeeded",
    events: [{
      id: "evt_permission",
      type: "permission.asked",
      data: {
        id: "perm_1",
        sessionID: "ses_xxx",
        action: "file.write",
        resources: ["src/index.ts"],
        message: "需要写入文件",
      },
    }],
    assertCalls(calls) {
      assert.equal(calls.length, 1)
      assert.equal(calls[0].headers.tags, "rotating_light")
      assert.equal(calls[0].headers.priority, "5")
      assert.match(calls[0].body, /权限|授权/)
       assert.doesNotMatch(calls[0].headers.title, /✅|❌|🚀|🚨|🔁|⏸️/)
    },
  })

  await runCase("form created notifies", {
    options: { topic: "mock-topic" },
    outcome: "succeeded",
    events: [{
      id: "evt_form",
      type: "form.created",
      data: {
        id: "form_1",
        sessionID: "ses_xxx",
        title: "需要确认部署参数",
        questions: [{ type: "select", key: "region", title: "部署区域", options: [{ value: "east", label: "华东" }] }],
      },
    }],
    assertCalls(calls) {
      assert.equal(calls.length, 1)
      assert.match(calls[0].headers.title, /\[opencode\] 主任务·需要回答问题/)
      assert.match(calls[0].body, /需要确认部署参数/)
      assert.match(calls[0].body, /- \[region\] 部署区域/)
    },
  })

  await runCase("form created notifies with protocol form.fields shape", {
    options: { topic: "mock-topic" },
    outcome: "succeeded",
    events: [{
      id: "evt_form_protocol",
      type: "form.created",
      data: {
        form: {
          id: "form_protocol_1",
          sessionID: "ses_xxx",
          title: "确认部署环境",
          fields: [
            { type: "string", key: "region", title: "部署区域", options: [{ value: "east", label: "华东" }, { value: "north", label: "华北" }] },
            { type: "boolean", key: "rollback", title: "启用回滚", description: "失败时自动回滚" },
          ],
        },
      },
    }],
    assertCalls(calls) {
      assert.equal(calls.length, 1)
      assert.equal(calls[0].headers.tags, "speech_balloon")
      assert.equal(calls[0].headers.priority, "5")
      assert.match(calls[0].headers.title, /\[opencode\] 主任务·需要回答问题/)
      assert.match(calls[0].body, /确认部署环境/)
      assert.match(calls[0].body, /- \[region\] 部署区域 \(华东、华北\)/)
      assert.match(calls[0].body, /- \[rollback\] 启用回滚 \(是\/否\)：失败时自动回滚/)
    },
  })

  // (a) The host re-publishing the same form — MCP elicitation resurfacing,
  // reconnect redelivery — must not push a second notification.
  await runCase("form re-delivered under the same id notifies once", {
    options: { topic: "mock-topic" },
    outcome: "succeeded",
    events: [
      {
        id: "evt_form_same_id_a",
        type: "form.created",
        data: {
          form: { id: "frm_same_1", sessionID: "ses_xxx", title: "确认部署参数", fields: [{ type: "string", key: "region", title: "部署区域" }] },
        },
      },
      {
        id: "evt_form_same_id_b",
        type: "form.created",
        data: {
          form: { id: "frm_same_1", sessionID: "ses_xxx", title: "确认部署参数", fields: [{ type: "string", key: "region", title: "部署区域" }] },
        },
      },
    ],
    assertCalls(calls) {
      assert.equal(calls.length, 1, "same form.id re-delivered must notify once")
      assert.equal(calls[0].headers.tags, "speech_balloon")
    },
  })

  // (b) Two genuinely different forms sharing session + title: the old
  // sessionID:title fallback key suppressed the second; form.id must not.
  await runCase("distinct forms sharing session and title each notify", {
    options: { topic: "mock-topic" },
    outcome: "succeeded",
    events: [
      {
        id: "evt_form_distinct_a",
        type: "form.created",
        data: {
          form: { id: "frm_distinct_1", sessionID: "ses_xxx", title: "同名表单", fields: [{ type: "string", key: "region", title: "部署区域" }] },
        },
      },
      {
        id: "evt_form_distinct_b",
        type: "form.created",
        data: {
          form: { id: "frm_distinct_2", sessionID: "ses_xxx", title: "同名表单", fields: [{ type: "string", key: "region", title: "部署区域" }] },
        },
      },
    ],
    assertCalls(calls) {
      assert.equal(calls.length, 2, "different form.id = different form, even with identical session + title")
      assert.equal(calls[0].headers.tags, "speech_balloon")
      assert.equal(calls[1].headers.tags, "speech_balloon")
    },
  })

  // (c) form.replied never notifies, correlates the answered form id against
  // the notified record (debug evidence), and the aftermath re-delivery of
  // the same form id stays suppressed after the answer.
  await runCase("form.replied is bookkeeping only and aftermath stays muted", {
    options: { topic: "mock-topic", debug: true },
    outcome: "succeeded",
    captureLogs: true,
    events: [
      {
        id: "evt_form_replied_a",
        type: "form.created",
        data: {
          form: { id: "frm_replied_1", sessionID: "ses_xxx", title: "回答后的话题", fields: [{ type: "boolean", key: "ok", title: "确认" }] },
        },
      },
      {
        id: "evt_form_replied_b",
        type: "form.replied",
        data: { id: "frm_replied_1", sessionID: "ses_xxx", answer: { ok: true } },
      },
      {
        id: "evt_form_replied_c",
        type: "form.created",
        data: {
          form: { id: "frm_replied_1", sessionID: "ses_xxx", title: "回答后的话题", fields: [{ type: "boolean", key: "ok", title: "确认" }] },
        },
      },
    ],
    assertCalls(calls) {
      assert.equal(calls.length, 1, "replied never notifies; aftermath re-delivery stays suppressed")
    },
    assertLogs(logs) {
      assert.equal(
        logs.some((line) => line.includes("[ntfy-debug] form.replied cleared form=frm_replied_1")),
        true,
        "replied must correlate the answered form id against the notified record",
      )
      assert.equal(
        logs.some((line) => line.includes("Failed to process event")),
        false,
        "replied bookkeeping must not surface as a process error",
      )
    },
  })

  // (c) form.cancelled behaves symmetrically: no notification, debug
  // evidence of the correlation, aftermath re-delivery still suppressed.
  await runCase("form.cancelled is bookkeeping only and aftermath stays muted", {
    options: { topic: "mock-topic", debug: true },
    outcome: "succeeded",
    captureLogs: true,
    events: [
      {
        id: "evt_form_cancelled_a",
        type: "form.created",
        data: {
          form: { id: "frm_cancelled_1", sessionID: "ses_xxx", title: "放弃的话题", fields: [{ type: "string", key: "why", title: "原因" }] },
        },
      },
      {
        id: "evt_form_cancelled_b",
        type: "form.cancelled",
        data: { id: "frm_cancelled_1", sessionID: "ses_xxx" },
      },
      {
        id: "evt_form_cancelled_c",
        type: "form.created",
        data: {
          form: { id: "frm_cancelled_1", sessionID: "ses_xxx", title: "放弃的话题", fields: [{ type: "string", key: "why", title: "原因" }] },
        },
      },
    ],
    assertCalls(calls) {
      assert.equal(calls.length, 1, "cancelled never notifies; aftermath re-delivery stays suppressed")
    },
    assertLogs(logs) {
      assert.equal(
        logs.some((line) => line.includes("[ntfy-debug] form.cancelled cleared form=frm_cancelled_1")),
        true,
        "cancelled must correlate the cancelled form id against the notified record",
      )
      assert.equal(
        logs.some((line) => line.includes("Failed to process event")),
        false,
        "cancelled bookkeeping must not surface as a process error",
      )
    },
  })

  await runCase("permission notifies when session lookup fails", {
    options: { topic: "mock-topic" },
    outcome: "succeeded",
    sessionGetFails: true,
    events: [{
      id: "evt_permission_lookup_failed",
      type: "permission.asked",
      data: { id: "perm_lookup_failed", sessionID: "ses_xxx", action: "file.write", resources: ["src/index.ts"] },
    }],
    assertCalls(calls) {
      assert.equal(calls.length, 1)
      assert.match(calls[0].headers.title, /需要授权/)
    },
  })

  await runCase("permission dedupes repeated requests with different ids", {
    options: { topic: "mock-topic" },
    outcome: "succeeded",
    events: [
      // Same permission re-published with a fresh request id each time: the id
      // key does not catch it, but the semantic key (session + action + sorted
      // resources) suppresses the duplicate so the pair yields one notification.
      {
        id: "evt_permission_repeat_a",
        type: "permission.asked",
        data: { id: "perm_1", sessionID: "ses_xxx", action: "file.write", resources: ["src/index.ts"] },
      },
      {
        id: "evt_permission_repeat_b",
        type: "permission.asked",
        data: { id: "perm_2", sessionID: "ses_xxx", action: "file.write", resources: ["src/index.ts"] },
      },
      // A different resource set is a genuinely different request → notifies again.
      {
        id: "evt_permission_repeat_c",
        type: "permission.asked",
        data: { id: "perm_3", sessionID: "ses_xxx", action: "file.write", resources: ["src/other.ts"] },
      },
    ],
    assertCalls(calls) {
      // perm_1/perm_2 deduped to one via the semantic key; perm_3 differs by
      // resource set so a second, distinct notification is sent.
      assert.equal(calls.length, 2)
      assert.equal(calls[0].headers.tags, "rotating_light")
      assert.equal(calls[1].headers.tags, "rotating_light")
    },
  })

  // (a) Same tool call, fresh permission id: the host re-asking one tool
  // call must not push a second notification.
  await runCase("permission re-asked under the same tool call notifies once", {
    options: { topic: "mock-topic" },
    outcome: "succeeded",
    events: [
      {
        id: "evt_permission_tool_key_a",
        type: "permission.asked",
        data: {
          id: "perm_tool_1",
          sessionID: "ses_xxx",
          action: "file.write",
          resources: ["src/index.ts"],
          source: { type: "tool", messageID: "msg_1", id: "tool_1" },
        },
      },
      {
        id: "evt_permission_tool_key_b",
        type: "permission.asked",
        data: {
          id: "perm_tool_2",
          sessionID: "ses_xxx",
          action: "file.write",
          resources: ["src/index.ts"],
          source: { type: "tool", messageID: "msg_1", id: "tool_1" },
        },
      },
    ],
    assertCalls(calls) {
      assert.equal(calls.length, 1)
      assert.equal(calls[0].headers.tags, "rotating_light")
    },
  })

  // (b) Different tool calls with identical action + resources: the old
  // content key suppressed the second; the tool-call key must not.
  await runCase("permission for a different tool call with identical content notifies again", {
    options: { topic: "mock-topic" },
    outcome: "succeeded",
    events: [
      {
        id: "evt_permission_tool_c",
        type: "permission.asked",
        data: {
          id: "perm_tool_3",
          sessionID: "ses_xxx",
          action: "file.write",
          resources: ["src/index.ts"],
          source: { type: "tool", messageID: "msg_1", id: "tool_1" },
        },
      },
      {
        id: "evt_permission_tool_d",
        type: "permission.asked",
        data: {
          id: "perm_tool_4",
          sessionID: "ses_xxx",
          action: "file.write",
          resources: ["src/index.ts"],
          source: { type: "tool", messageID: "msg_2", id: "tool_1" },
        },
      },
    ],
    assertCalls(calls) {
      assert.equal(calls.length, 2)
      assert.equal(calls[0].headers.tags, "rotating_light")
      assert.equal(calls[1].headers.tags, "rotating_light")
    },
  })

  // (c) replied clears the request → tool-call mapping, sends nothing itself,
  // and the aftermath re-ask of the same tool call stays suppressed.
  await runCase("permission.replied clears the mapping and aftermath stays muted", {
    options: { topic: "mock-topic", debug: true },
    outcome: "succeeded",
    captureLogs: true,
    events: [
      {
        id: "evt_permission_replied_a",
        type: "permission.asked",
        data: {
          id: "perm_replied_1",
          sessionID: "ses_xxx",
          action: "file.write",
          resources: ["src/index.ts"],
          source: { type: "tool", messageID: "msg_1", id: "tool_1" },
        },
      },
      {
        id: "evt_permission_replied_b",
        type: "permission.replied",
        data: { sessionID: "ses_xxx", requestID: "perm_replied_1", reply: "once" },
      },
      {
        id: "evt_permission_replied_c",
        type: "permission.asked",
        data: {
          id: "perm_replied_2",
          sessionID: "ses_xxx",
          action: "file.write",
          resources: ["src/index.ts"],
          source: { type: "tool", messageID: "msg_1", id: "tool_1" },
        },
      },
    ],
    assertCalls(calls) {
      assert.equal(calls.length, 1, "reply never notifies; aftermath re-ask stays suppressed")
    },
    assertLogs(logs) {
      assert.equal(
        logs.some((line) => line.includes("[ntfy-debug] permission.replied cleared request=perm_replied_1")),
        true,
        "replied must find and clear the request → tool-call mapping",
      )
      assert.equal(
        logs.some((line) => line.includes("Failed to process event")),
        false,
        "replied bookkeeping must not surface as a process error",
      )
    },
  })

  await runCase("started disabled", {
    options: { topic: "mock-topic", notifyStarted: false },
    outcome: "succeeded",
    events: [{
      id: "evt_started_disabled",
      type: "session.execution.started",
      data: { sessionID: "ses_xxx" },
    }],
    assertCalls(calls) {
      assert.equal(calls.length, 0)
    },
  })

  await runCase("started enabled", {
    options: { topic: "mock-topic", notifyStarted: true },
    outcome: "succeeded",
    events: [{
      id: "evt_started_enabled",
      type: "session.execution.started",
      data: { sessionID: "ses_xxx" },
    }],
    assertCalls(calls) {
      assert.equal(calls.length, 1)
      assert.equal(calls[0].headers.tags, "arrow_forward")
      assert.equal(calls[0].headers.priority, "2")
       assert.doesNotMatch(calls[0].headers.title, /✅|❌|🚀|🚨|🔁|⏸️/)
    },
  })

  await runCase("execution failed and idle are deduplicated", {
    options: { topic: "mock-topic" },
    outcome: "failed",
    events: [
      {
        id: "evt_failed_then_idle",
        type: "session.execution.failed",
        data: {
          sessionID: "ses_xxx",
          error: { type: "ProviderError", message: "mock execution failed" },
        },
      },
      {
        id: "evt_idle_after_failed",
        type: "session.idle",
        data: { sessionID: "ses_xxx" },
      },
    ],
    assertCalls(calls) {
      assert.equal(calls.length, 1)
      assert.equal(calls[0].headers.tags, "x")
    },
  })

  await runCase("duplicate idle event", {
    options: { topic: "mock-topic" },
    outcome: "succeeded",
    events: [
      { id: "evt1", type: "session.idle", data: { sessionID: "ses_xxx" } },
      { id: "evt2", type: "session.idle", data: { sessionID: "ses_xxx" } },
    ],
    assertCalls(calls) {
      assert.equal(calls.length, 1)
    },
  })

  await runCase("project mismatch", {
    options: { topic: "mock-topic" },
    outcome: "succeeded",
    sessionProjectID: "proj_2",
    locationProjectID: "proj_1",
    assertCalls(calls) {
      assert.equal(calls.length, 0)
    },
  })

  await runCase("missing location project id", {
    options: { topic: "mock-topic" },
    outcome: "succeeded",
    sessionProjectID: "proj_1",
    locationProjectID: undefined,
    assertCalls(calls) {
      assert.equal(calls.length, 1)
    },
  })

  await runCase("wedged session lookup times out and the loop keeps going", {
    options: { topic: "mock-topic", sessionTimeoutMs: 1 },
    outcome: "succeeded",
    sessionGetHangsFor: "ses_hang",
    settleMs: 1_500,
    expectNoProcessError: true,
    events: [
      { id: "evt_hang", type: "session.idle", data: { sessionID: "ses_hang" } },
      { id: "evt_ok", type: "session.idle", data: { sessionID: "ses_xxx" } },
    ],
    assertCalls(calls) {
      // The first event's host lookup never settles; after the clamped
      // timeout (1ms → 1000ms) it is skipped, and the next event still
      // notifies — the subscription loop never stalls on a wedged lookup.
      assert.equal(calls.length, 1)
    },
  })

  // --- Unit: JSONC comment stripping is string-safe ----------------------
  {
    const parsed = parseJsonc(`{
      // 行注释
      "topic": "jsonc-topic", /* 块注释 */
      "server": "https://ntfy.sh"
    }`) as Record<string, unknown>
    assert.equal(parsed.topic, "jsonc-topic", "values around comments survive")
    assert.equal(parsed.server, "https://ntfy.sh", "// inside a string must not be eaten by the comment stripper")
    const tricky = parseJsonc('{"note":"/* not a comment */ \\"quoted\\" // either"}') as Record<string, string>
    assert.equal(tricky.note, '/* not a comment */ "quoted" // either', "comment markers inside strings stay intact")
    assert.throws(() => parseJsonc("{ nope }"), "invalid JSON must throw for the caller to log")
    assert.throws(() => parseJsonc('{"topic": }'), "truncated values must throw")
    console.log("PASS JSONC comment stripping is string-safe and delegates invalid JSON to JSON.parse")
  }

  // --- External local config file: layering, silence, fallback -----------
  await withTempConfigDir(async (directory) => {
    const configFile = join(directory, "ntfy.local.json")
    writeFileSync(configFile, `${JSON.stringify({
      topic: "file-topic",
      server: "https://ntfy.file.example",
      tag: "file-tag",
      unknownField: { nested: true },
    }, null, 2)}\n`, "utf-8")

    // (a) 外部文件提供 topic 时生效；同文件的 server/tag 一并进入配置，
    // 未知字段被忽略。
    await runCase("external config file supplies topic, server and tag", {
      options: {},
      env: { NTFY_CONFIG_FILE: configFile },
      outcome: "succeeded",
      assertCalls(calls) {
        assert.equal(calls.length, 1)
        assert.equal(calls[0].url.startsWith("https://ntfy.file.example/"), true, `file server must apply, got ${calls[0].url}`)
        assert.equal(calls[0].url.endsWith("/file-topic"), true)
        assert.equal(calls[0].headers.tags, "file-tag")
      },
    })

    // (b) 内联 options 优先于外部文件；文件仍补齐未被覆盖的字段。
    await runCase("inline options beat the external config file", {
      options: { topic: "inline-topic" },
      env: { NTFY_CONFIG_FILE: configFile },
      outcome: "succeeded",
      assertCalls(calls) {
        assert.equal(calls.length, 1)
        assert.equal(calls[0].url.startsWith("https://ntfy.file.example/"), true, "untouched fields still come from the file")
        assert.equal(calls[0].url.endsWith("/inline-topic"), true)
      },
    })

    // (b) 环境变量优先于外部文件。
    await runCase("environment variables beat the external config file", {
      options: {},
      env: { NTFY_CONFIG_FILE: configFile, NTFY_TOPIC: "env-topic" },
      outcome: "succeeded",
      assertCalls(calls) {
        assert.equal(calls.length, 1)
        assert.equal(calls[0].url.endsWith("/env-topic"), true)
      },
    })

    // (b) 内联 options 仍然优先于环境变量（既有语义在文件层存在时不回归）。
    await runCase("inline options beat environment variables with a file present", {
      options: { topic: "inline-topic" },
      env: { NTFY_CONFIG_FILE: configFile, NTFY_TOPIC: "env-topic" },
      outcome: "succeeded",
      assertCalls(calls) {
        assert.equal(calls.length, 1)
        assert.equal(calls[0].url.endsWith("/inline-topic"), true)
      },
    })

    // (c) 文件不存在：静默跳过——不报错、不崩溃、无 topic 时不发送。
    await runCase("missing config file is skipped silently", {
      options: {},
      env: { NTFY_CONFIG_FILE: join(directory, "absent.json") },
      outcome: "succeeded",
      captureErrors: true,
      assertCalls(calls) {
        assert.equal(calls.length, 0)
      },
      assertErrors(errors) {
        assert.equal(
          errors.some((line) => line.toLowerCase().includes("config file")),
          false,
          "a missing config file must not produce an error line",
        )
      },
    })

    // (d) 非法 JSON：只记一条 error，不崩，回退到环境变量继续工作。
    const brokenFile = join(directory, "broken.json")
    writeFileSync(brokenFile, "{ this is not json", "utf-8")
    await runCase("invalid config file logs one error and falls back to env", {
      options: {},
      env: { NTFY_CONFIG_FILE: brokenFile, NTFY_TOPIC: "env-fallback-topic" },
      outcome: "succeeded",
      captureErrors: true,
      assertCalls(calls) {
        assert.equal(calls.length, 1)
        assert.equal(calls[0].url.endsWith("/env-fallback-topic"), true)
      },
      assertErrors(errors) {
        assert.equal(
          errors.filter((line) => line.includes("[ntfy] Failed to parse config file")).length,
          1,
          "exactly one parse-failure line, and the plugin stays alive",
        )
      },
    })

    // (d) 合法 JSON 但不是对象：同样记一条 error 并回退。
    const arrayFile = join(directory, "array.json")
    writeFileSync(arrayFile, "[1, 2, 3]", "utf-8")
    await runCase("non-object config file logs one error and falls back", {
      options: {},
      env: { NTFY_CONFIG_FILE: arrayFile, NTFY_TOPIC: "env-fallback-topic" },
      outcome: "succeeded",
      captureErrors: true,
      assertCalls(calls) {
        assert.equal(calls.length, 1)
        assert.equal(calls[0].url.endsWith("/env-fallback-topic"), true)
      },
      assertErrors(errors) {
        assert.equal(
          errors.filter((line) => line.includes("[ntfy] Config file must contain a JSON object")).length,
          1,
          "a JSON array is not a config object: one error line, still no crash",
        )
      },
    })

    // JSONC 注释容忍（端到端）：带注释与 BOM 的文件正常加载。
    const jsoncFile = join(directory, "jsonc.json")
    writeFileSync(jsoncFile, `\uFEFF{
      // 本机差异配置：放在 opencode 用户目录，已在 .gitignore
      /* 块注释 */
      "topic": "jsonc-topic",
      "server": "https://ntfy.sh"
    }`, "utf-8")
    await runCase("config file tolerates JSONC comments and a BOM", {
      options: {},
      env: { NTFY_CONFIG_FILE: jsoncFile },
      outcome: "succeeded",
      assertCalls(calls) {
        assert.equal(calls.length, 1)
        assert.equal(calls[0].url.endsWith("/jsonc-topic"), true)
      },
    })

    // 白名单：未知字段被忽略——拼错的 "sever" 不会变成 server。
    const typoFile = join(directory, "typo.json")
    writeFileSync(typoFile, JSON.stringify({ sever: "https://typo.example", topic: "whitelist-topic" }), "utf-8")
    await runCase("unknown config file fields are ignored", {
      options: {},
      env: { NTFY_CONFIG_FILE: typoFile },
      outcome: "succeeded",
      assertCalls(calls) {
        assert.equal(calls[0].url.startsWith("https://ntfy.sh/"), true, "unknown keys must not be aliased to real options")
        assert.equal(calls[0].url.endsWith("/whitelist-topic"), true)
      },
    })

    // debug 开关也可以来自外部文件。
    const debugFile = join(directory, "debug.json")
    writeFileSync(debugFile, JSON.stringify({ topic: "debug-file-topic", debug: true }), "utf-8")
    await runCase("debug flag can come from the config file", {
      options: {},
      env: { NTFY_CONFIG_FILE: debugFile },
      outcome: "succeeded",
      captureLogs: true,
      assertCalls(calls) {
        assert.equal(calls.length, 1)
      },
      assertLogs(logs) {
        assert.equal(logs.some((line) => line.includes("[ntfy-debug] setup")), true, "file-provided debug must enable diagnostics")
      },
    })
  })

  // --- 默认路径：$HOME/.config/opencode/ntfy.local.jsonc 自动创建 ----------
  // 单一路径：$HOME/.config/opencode/ntfy.local.jsonc（Windows 下 HOME 取
  // USERPROFILE），不再有 XDG / %APPDATA% 搜索链。
  await withTempConfigDir(async (directory) => {
    // (a) 默认文件不存在 → 自动创建（含目录递归创建）带中文注释的模板，
    //     且模板可被正确读取：用户填入 topic 后按默认路径生效。
    {
      const home = join(directory, "home-auto")
      const defaultFile = join(home, ".config", "opencode", "ntfy.local.jsonc")
      const defaultEnv = { NTFY_CONFIG_FILE: undefined, HOME: home, USERPROFILE: home }

      await runCase("default config file is auto-created with a commented template", {
        options: {},
        env: defaultEnv,
        outcome: "succeeded",
        captureErrors: true,
        assertCalls(calls) {
          // 自动创建的模板 topic 留空 → 不发送通知，等用户填写。
          assert.equal(calls.length, 0)
        },
        assertErrors(errors) {
          assert.equal(
            errors.some((line) => line.includes("Failed to create default config file")),
            false,
            "自动创建成功时不得记录错误",
          )
        },
      })
      assert.ok(existsSync(defaultFile), "默认配置文件应被自动创建")
      const created = readFileSync(defaultFile, "utf-8")
      assert.ok(created.includes("//"), "自动创建的模板必须带注释")
      for (const key of [
        "server", "topic", "token", "tag",
        "notifyRoot", "notifyChildren", "notifyStarted",
        "notifyFailed", "notifyPermission", "notifyRetry",
        "debug", "sessionTimeoutMs",
      ]) {
        assert.ok(created.includes(`"${key}"`), `模板必须包含 ${key} 字段`)
      }
      const parsedTemplate = parseJsonc(created) as Record<string, unknown>
      assert.equal(parsedTemplate.topic, "", "topic 默认留空占位，由用户填写")
      assert.equal(parsedTemplate.server, "https://ntfy.sh", "模板 server 保留内置默认值")

      // 模板可读：用户自行填入 topic 后（对既有文件的用户编辑，非覆盖），
      // 插件按默认单一路径读取并生效。
      writeFileSync(defaultFile, created.replace('"topic": ""', '"topic": "auto-created-topic"'), "utf-8")
      await runCase("auto-created default config file is read back", {
        options: {},
        env: defaultEnv,
        outcome: "succeeded",
        assertCalls(calls) {
          assert.equal(calls.length, 1)
          assert.equal(calls[0].url.endsWith("/auto-created-topic"), true)
        },
      })
    }

    // (b) 已存在的文件不被覆盖：自定义内容（含用户自己写的注释）原样保留。
    {
      const home = join(directory, "home-existing")
      const configDir = join(home, ".config", "opencode")
      const existingFile = join(configDir, "ntfy.local.jsonc")
      mkdirSync(configDir, { recursive: true })
      const custom = `{
  // 用户自己写的注释，Created by user
  "topic": "existing-topic",
  "server": "https://ntfy.existing.example"
}
`
      writeFileSync(existingFile, custom, "utf-8")

      await runCase("existing default config file is never overwritten", {
        options: {},
        env: { NTFY_CONFIG_FILE: undefined, HOME: home, USERPROFILE: home },
        outcome: "succeeded",
        assertCalls(calls) {
          assert.equal(calls.length, 1)
          assert.equal(calls[0].url.startsWith("https://ntfy.existing.example/"), true)
          assert.equal(calls[0].url.endsWith("/existing-topic"), true)
        },
      })
      assert.equal(readFileSync(existingFile, "utf-8"), custom, "已存在的文件内容不得被改写")
    }

    // 旧版 ntfy.local.json 仍在：只提示改名，不读取旧文件、不创建新文件。
    // （否则自动创建一个 topic 留空的新文件会把用户真实配置悄悄盖住。）
    {
      const home = join(directory, "home-legacy")
      const configDir = join(home, ".config", "opencode")
      const legacyFile = join(configDir, "ntfy.local.json")
      mkdirSync(configDir, { recursive: true })
      const legacyContent = JSON.stringify({ topic: "legacy-topic" })
      writeFileSync(legacyFile, legacyContent, "utf-8")

      await runCase("legacy ntfy.local.json triggers a rename hint, nothing else", {
        options: {},
        env: { NTFY_CONFIG_FILE: undefined, HOME: home, USERPROFILE: home },
        outcome: "succeeded",
        captureErrors: true,
        assertCalls(calls) {
          assert.equal(calls.length, 0, "旧文件名不在读取范围内")
        },
        assertErrors(errors) {
          assert.equal(
            errors.filter((line) => line.includes("legacy config file")).length,
            1,
            "必须提示用户改名，而不是静默忽略旧文件",
          )
        },
      })
      assert.equal(existsSync(join(configDir, "ntfy.local.jsonc")), false, "旧文件存在时不得创建竞争配置")
      assert.equal(readFileSync(legacyFile, "utf-8"), legacyContent, "旧文件不得被改写")
    }
  })

  // (c) 显式 configFile：只读取、不创建；缺失时静默跳过。
  await withTempConfigDir(async (directory) => {
    const explicitDir = join(directory, "explicit", "nested")
    const explicitFile = join(explicitDir, "custom.jsonc")
    await runCase("missing explicit config file is not created, only skipped silently", {
      options: { topic: "inline-topic" },
      env: {
        NTFY_CONFIG_FILE: explicitFile,
        HOME: join(directory, "no-home"),
        USERPROFILE: join(directory, "no-home"),
      },
      outcome: "succeeded",
      captureErrors: true,
      assertCalls(calls) {
        assert.equal(calls.length, 1)
        assert.equal(calls[0].url.endsWith("/inline-topic"), true)
      },
      assertErrors(errors) {
        assert.equal(
          errors.some((line) => line.toLowerCase().includes("config file")),
          false,
          "显式配置缺失 → 静默跳过，不得报错",
        )
      },
    })
    assert.equal(existsSync(explicitFile), false, "显式指定的配置文件不得被创建")
    assert.equal(existsSync(explicitDir), false, "显式路径的目录也不得被创建")
  })

  // (d) 默认路径不可写：只记一条 error、不崩，其余来源照常生效。
  await withTempConfigDir(async (directory) => {
    const home = join(directory, "home-blocked")
    mkdirSync(join(home, ".config"), { recursive: true })
    // 用一个"文件"霸占默认目录位置：mkdir recursive 必然失败。
    writeFileSync(join(home, ".config", "opencode"), "not a directory", "utf-8")

    await runCase("unwritable default config path logs one error and keeps running", {
      options: { topic: "inline-topic" },
      env: { NTFY_CONFIG_FILE: undefined, HOME: home, USERPROFILE: home },
      outcome: "succeeded",
      captureErrors: true,
      assertCalls(calls) {
        assert.equal(calls.length, 1)
        assert.equal(calls[0].url.endsWith("/inline-topic"), true)
      },
      assertErrors(errors) {
        assert.equal(
          errors.filter((line) => line.includes("Failed to create default config file")).length,
          1,
          "创建失败必须只记一条错误，插件继续工作",
        )
      },
    })
  })

  await runReconnectCase()

  console.log("All ntfy self-checks passed")
}

await main()
