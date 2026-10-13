import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import ntfyPlugin, { createBoundedKeyMap, createBoundedKeySet, createBoundedRoundMap, executionEventKey, formDedupKey, parseJsonc, permissionToolKey, reconnectDelayMs, sessionTimeoutValue } from "../src/index.ts"

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
  "NTFY_NOTIFY_STARTED",
  "NTFY_NOTIFY_IDLE",
  "NTFY_NOTIFY_SUCCEEDED",
  "NTFY_NOTIFY_FAILED",
  "NTFY_NOTIFY_INTERRUPTED",
  "NTFY_NOTIFY_PERMISSION",
  "NTFY_NOTIFY_FORM",
  "NTFY_NOTIFY_RETRY",
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
  // Durable envelope metadata the real V2 protocol attaches to execution
  // events ({aggregateID, seq}); the lifecycle dedup prefers it over the
  // envelope id, so the mock can exercise both identity paths.
  durable?: { aggregateID: string; seq: number }
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
  // Reject every send (network/server down): exercises the send-failure
  // path — silent by default, debug-only when enabled, never fatal.
  fetchFails?: boolean
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
    const call: FetchCall = {
      url: String(input),
      headers: headersToObject(init?.headers),
      body: typeof init?.body === "string" ? init.body : String(init?.body ?? ""),
    }
    // Record the attempt even when it fails: the plugin must have tried
    // exactly once per notification, then swallowed the rejection.
    calls.push(call)
    if (options.fetchFails) throw new Error("mock network unreachable")
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
        consoleErrors.some((line) => line.includes("Failed to process event") || line.startsWith("[ntfy]")),
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

  // --- Unit: execution event identity prefers durable seq -----------------
  {
    assert.equal(
      executionEventKey({ id: "evt_1", durable: { aggregateID: "ses_1", seq: 7 } }),
      "ses_1:7",
      "durable identity (aggregateID:seq) wins over the envelope id",
    )
    assert.equal(
      executionEventKey({ id: "evt_1", durable: { aggregateID: "ses_1", seq: 8 } }),
      "ses_1:8",
      "a different seq is a different lifecycle event",
    )
    assert.equal(executionEventKey({ id: "evt_1" }), "evt_1", "no durable metadata → envelope id")
    assert.equal(executionEventKey({ durable: { aggregateID: "ses_1" } }), undefined, "no seq and no id → no identity")
    assert.equal(
      executionEventKey({ id: "evt_1", durable: { aggregateID: "  ", seq: 3 } }),
      "evt_1",
      "blank aggregateID falls back to the envelope id",
    )
    assert.equal(
      executionEventKey({ id: "evt_1", durable: { aggregateID: "ses_1", seq: Number.NaN } }),
      "evt_1",
      "non-finite seq falls back to the envelope id",
    )
    console.log("PASS execution event key prefers durable identity with envelope-id fallback")
  }

  // --- Unit: per-session execution round map ------------------------------
  {
    const rounds = createBoundedRoundMap()
    const first = rounds.ensure("ses_1")
    assert.equal(rounds.get("ses_1"), first, "ensure returns the stored entry")
    assert.equal(rounds.get("ses_missing"), undefined, "unknown session has no round")
    first.startedKey = "ses_1:1"
    first.terminalNotified = true
    assert.equal(rounds.ensure("ses_1").startedKey, "ses_1:1", "mutations persist through ensure")
    assert.equal(rounds.ensure("ses_1").terminalNotified, true, "round state is shared by reference")
    rounds.ensure("ses_2")
    assert.equal(rounds.size, 2)
    for (let index = 3; index <= 21; index += 1) rounds.ensure(`ses_${index}`)
    assert.equal(rounds.size, 20, "round map must cap at DEDUP_ENTRY_LIMIT")
    assert.equal(rounds.get("ses_1"), undefined, "oldest session round must be evicted at the cap")
    assert.notEqual(rounds.get("ses_2"), undefined, "recent sessions must survive")
    console.log("PASS execution round map stores per-session lifecycle and evicts oldest")
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
    captureLogs: true,
    assertCalls(calls) {
      assert.equal(calls.length, 0)
    },
    assertLogs(logs) {
      assert.equal(logs.length, 0, "a missing topic must be completely silent with debug off")
    },
  })

  await runCase("missing topic is observable at debug level", {
    options: { debug: true },
    outcome: "succeeded",
    captureLogs: true,
    assertCalls(calls) {
      assert.equal(calls.length, 0)
    },
    assertLogs(logs) {
      assert.equal(
        logs.filter((line) => line.includes("[ntfy-debug] setup.no-topic")).length,
        1,
        "the no-topic diagnostic must be visible exactly once with debug on",
      )
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

  // (d) form.created finally has its own switch: notifyForm=false must
  // suppress the send entirely (and must not consume a dedup slot).
  await runCase("form disabled", {
    options: { topic: "mock-topic", notifyForm: false },
    outcome: "succeeded",
    events: [{
      id: "evt_form_disabled",
      type: "form.created",
      data: {
        form: { id: "frm_disabled_1", sessionID: "ses_xxx", title: "关闭开关的表单", fields: [{ type: "string", key: "why", title: "原因" }] },
      },
    }],
    assertCalls(calls) {
      assert.equal(calls.length, 0, "notifyForm=false must suppress form notifications")
    },
  })

  // (e) Success has its own switch, shared by execution.succeeded and the
  // succeeded outcome of session.idle (dedup keeps them at one anyway).
  await runCase("succeeded disabled suppresses execution.succeeded and idle success", {
    options: { topic: "mock-topic", notifySucceeded: false },
    outcome: "succeeded",
    events: [
      { id: "evt_succeeded_off", type: "session.execution.succeeded", data: { sessionID: "ses_xxx" } },
      { id: "evt_idle_succeeded_off", type: "session.idle", data: { sessionID: "ses_xxx" } },
    ],
    assertCalls(calls) {
      assert.equal(calls.length, 0, "notifySucceeded=false must suppress both success signals")
    },
  })

  // (f) Interrupted is its own switch and its own dedup record: repeated
  // idle events notify once.
  await runCase("interrupted notifies once", {
    options: { topic: "mock-topic" },
    outcome: "interrupted",
    events: [
      { id: "evt_interrupted_a", type: "session.idle", data: { sessionID: "ses_xxx" } },
      { id: "evt_interrupted_b", type: "session.idle", data: { sessionID: "ses_xxx" } },
    ],
    assertCalls(calls) {
      assert.equal(calls.length, 1, "repeated idle interruptions must notify once")
      assert.equal(calls[0].headers.tags, "information_source")
      assert.equal(calls[0].headers.priority, "4")
      assert.match(calls[0].headers.title, /\[opencode\] 主任务·已中断/)
    },
  })

  await runCase("interrupted disabled", {
    options: { topic: "mock-topic", notifyInterrupted: false },
    outcome: "interrupted",
    events: [{ id: "evt_interrupted_off", type: "session.idle", data: { sessionID: "ses_xxx" } }],
    assertCalls(calls) {
      assert.equal(calls.length, 0, "notifyInterrupted=false must suppress interruption notifications")
    },
  })

  // (g) Failure and interruption are mutually abnormal terminal states:
  // whichever signal arrives first notifies, the other is suppressed.
  await runCase("execution failed suppresses a later idle interruption", {
    options: { topic: "mock-topic" },
    outcome: "interrupted",
    events: [
      {
        id: "evt_failed_before_interrupted",
        type: "session.execution.failed",
        data: { sessionID: "ses_xxx", error: { type: "ProviderError", message: "mock execution failed" } },
      },
      { id: "evt_interrupted_after_failed", type: "session.idle", data: { sessionID: "ses_xxx" } },
    ],
    assertCalls(calls) {
      assert.equal(calls.length, 1, "a failure already notified covers the terminal state")
      assert.equal(calls[0].headers.tags, "x")
    },
  })

  await runCase("idle interruption suppresses a later execution failed", {
    options: { topic: "mock-topic" },
    outcome: "interrupted",
    events: [
      { id: "evt_interrupted_before_failed", type: "session.idle", data: { sessionID: "ses_xxx" } },
      {
        id: "evt_failed_after_interrupted",
        type: "session.execution.failed",
        data: { sessionID: "ses_xxx", error: { type: "ProviderError", message: "mock execution failed" } },
      },
    ],
    assertCalls(calls) {
      assert.equal(calls.length, 1, "an interruption already notified covers the terminal state")
      assert.equal(calls[0].headers.tags, "information_source")
    },
  })

  // (h) The new switches also honor the env layer (NTFY_* style).
  // --- notifyIdle: the session.idle master gate ---------------------------
  // Off ⇒ session.idle never notifies (no IO, no dedup consumed), while
  // execution.* events, permissions and forms are unaffected.
  await runCase("idle disabled suppresses idle notifications", {
    options: { topic: "mock-topic", notifyIdle: false },
    outcome: "succeeded",
    events: [{ id: "evt_idle_off", type: "session.idle", data: { sessionID: "ses_xxx" } }],
    assertCalls(calls) {
      assert.equal(calls.length, 0, "notifyIdle=false must suppress idle notifications")
    },
  })

  await runCase("idle disabled still notifies execution completion", {
    options: { topic: "mock-topic", notifyIdle: false },
    outcome: "succeeded",
    settleMs: 50,
    events: [
      { id: "evt_idle_off_started", type: "session.execution.started", data: { sessionID: "ses_xxx" } },
      { id: "evt_idle_off_succeeded", type: "session.execution.succeeded", data: { sessionID: "ses_xxx" } },
      { id: "evt_idle_off_idle", type: "session.idle", data: { sessionID: "ses_xxx" } },
    ],
    assertCalls(calls) {
      assert.equal(calls.length, 1, "execution completion must survive notifyIdle=false")
      assert.equal(calls[0].headers.tags, "white_check_mark")
    },
  })

  await runCase("idle disabled still notifies execution failure", {
    options: { topic: "mock-topic", notifyIdle: false },
    outcome: "failed",
    events: [
      {
        id: "evt_idle_off_failed",
        type: "session.execution.failed",
        data: { sessionID: "ses_xxx", error: { type: "ProviderError", message: "mock execution failed" } },
      },
      { id: "evt_idle_off_idle_failed", type: "session.idle", data: { sessionID: "ses_xxx" } },
    ],
    assertCalls(calls) {
      assert.equal(calls.length, 1, "execution failure must survive notifyIdle=false")
      assert.equal(calls[0].headers.tags, "x")
    },
  })

  await runCase("idle disabled still notifies explicit execution interruption", {
    options: { topic: "mock-topic", notifyIdle: false },
    outcome: "interrupted",
    events: [
      { id: "evt_idle_off_interrupted", type: "session.execution.interrupted", data: { sessionID: "ses_xxx", reason: "user" } },
      { id: "evt_idle_off_idle_interrupted", type: "session.idle", data: { sessionID: "ses_xxx" } },
    ],
    assertCalls(calls) {
      assert.equal(calls.length, 1, "execution interruption must survive notifyIdle=false and merge with idle")
      assert.equal(calls[0].headers.tags, "information_source")
    },
  })

  await runCase("idle disabled leaves permission and form notifications alone", {
    options: { topic: "mock-topic", notifyIdle: false },
    outcome: "succeeded",
    settleMs: 50,
    events: [
      {
        id: "evt_idle_off_permission",
        type: "permission.asked",
        data: { id: "perm_idle_off", sessionID: "ses_xxx", action: "file.write", resources: ["src/index.ts"] },
      },
      {
        id: "evt_idle_off_form",
        type: "form.created",
        data: { form: { id: "frm_idle_off", sessionID: "ses_xxx", title: "idle 关闭也应答", fields: [] } },
      },
    ],
    assertCalls(calls) {
      assert.equal(calls.length, 2, "notifyIdle must not gate permission or form notifications")
      assert.equal(calls[0].headers.tags, "rotating_light")
      assert.equal(calls[1].headers.tags, "speech_balloon")
    },
  })

  // --- session.execution.interrupted (protocol event, not just idle) ------
  await runCase("execution interrupted notifies with its reason", {
    options: { topic: "mock-topic" },
    outcome: "succeeded",
    events: [{
      id: "evt_execution_interrupted",
      type: "session.execution.interrupted",
      data: { sessionID: "ses_xxx", reason: "user" },
    }],
    assertCalls(calls) {
      assert.equal(calls.length, 1)
      assert.equal(calls[0].headers.tags, "information_source")
      assert.equal(calls[0].headers.priority, "4")
      assert.match(calls[0].headers.title, /\[opencode\] 主任务·已中断/)
      assert.match(calls[0].body, /结果：中断/)
      assert.match(calls[0].body, /原因：用户中断/)
    },
  })

  await runCase("execution interrupted disabled", {
    options: { topic: "mock-topic", notifyInterrupted: false },
    outcome: "succeeded",
    events: [{
      id: "evt_execution_interrupted_off",
      type: "session.execution.interrupted",
      data: { sessionID: "ses_xxx", reason: "shutdown" },
    }],
    assertCalls(calls) {
      assert.equal(calls.length, 0, "notifyInterrupted=false must suppress execution interruptions")
    },
  })

  // --- Lifecycle dedup: rounds, not session identity ----------------------
  // The old sessionID-keyed dedup never reset, so a session's SECOND task
  // was silently swallowed. Rounds fix that: a new started event reopens
  // the session, while the same round's idle + completion still merge.
  await runCase("second round of the same session notifies again", {
    options: { topic: "mock-topic", notifyStarted: true },
    outcome: "succeeded",
    settleMs: 100,
    events: [
      { id: "evt_r1_started", type: "session.execution.started", data: { sessionID: "ses_xxx" } },
      { id: "evt_r1_succeeded", type: "session.execution.succeeded", data: { sessionID: "ses_xxx" } },
      { id: "evt_r1_idle", type: "session.idle", data: { sessionID: "ses_xxx" } },
      { id: "evt_r2_started", type: "session.execution.started", data: { sessionID: "ses_xxx" } },
      { id: "evt_r2_succeeded", type: "session.execution.succeeded", data: { sessionID: "ses_xxx" } },
      { id: "evt_r2_idle", type: "session.idle", data: { sessionID: "ses_xxx" } },
    ],
    assertCalls(calls) {
      // 2 started + 2 succeeded; each round's idle merges into its
      // completion instead of notifying a second time.
      assert.equal(calls.length, 4, "two rounds must each notify started + completion")
      assert.equal(calls[0].headers.tags, "arrow_forward")
      assert.equal(calls[1].headers.tags, "white_check_mark")
      assert.equal(calls[2].headers.tags, "arrow_forward")
      assert.equal(calls[3].headers.tags, "white_check_mark")
    },
  })

  await runCase("second round notifies even with started disabled", {
    options: { topic: "mock-topic", notifyStarted: false },
    outcome: "succeeded",
    settleMs: 100,
    events: [
      { id: "evt_r1b_started", type: "session.execution.started", data: { sessionID: "ses_xxx" } },
      { id: "evt_r1b_succeeded", type: "session.execution.succeeded", data: { sessionID: "ses_xxx" } },
      { id: "evt_r1b_idle", type: "session.idle", data: { sessionID: "ses_xxx" } },
      { id: "evt_r2b_started", type: "session.execution.started", data: { sessionID: "ses_xxx" } },
      { id: "evt_r2b_succeeded", type: "session.execution.succeeded", data: { sessionID: "ses_xxx" } },
      { id: "evt_r2b_idle", type: "session.idle", data: { sessionID: "ses_xxx" } },
    ],
    assertCalls(calls) {
      assert.equal(calls.length, 2, "started stays silent but still maintains the lifecycle")
      assert.equal(calls[0].headers.tags, "white_check_mark")
      assert.equal(calls[1].headers.tags, "white_check_mark")
    },
  })

  await runCase("redelivered started does not reset the notified terminal", {
    options: { topic: "mock-topic", notifyStarted: false },
    outcome: "succeeded",
    settleMs: 100,
    events: [
      { id: "evt_re_started", type: "session.execution.started", data: { sessionID: "ses_xxx" } },
      { id: "evt_re_succeeded", type: "session.execution.succeeded", data: { sessionID: "ses_xxx" } },
      // Re-delivery of the SAME started event (reconnect redelivery): same
      // envelope id, so it must not reopen the already-notified round.
      { id: "evt_re_started", type: "session.execution.started", data: { sessionID: "ses_xxx" } },
      { id: "evt_re_idle", type: "session.idle", data: { sessionID: "ses_xxx" } },
      { id: "evt_re_r2_started", type: "session.execution.started", data: { sessionID: "ses_xxx" } },
      { id: "evt_re_r2_succeeded", type: "session.execution.succeeded", data: { sessionID: "ses_xxx" } },
    ],
    assertCalls(calls) {
      assert.equal(calls.length, 2, "a re-delivered started must not reopen the notified round")
    },
  })

  await runCase("redelivered started under a new envelope id but same durable seq does not reset", {
    options: { topic: "mock-topic", notifyStarted: false },
    outcome: "succeeded",
    settleMs: 50,
    events: [
      { id: "evt_durable_a", type: "session.execution.started", data: { sessionID: "ses_xxx" }, durable: { aggregateID: "ses_xxx", seq: 1 } },
      { id: "evt_durable_succeeded", type: "session.execution.succeeded", data: { sessionID: "ses_xxx" } },
      // Same durable identity, different envelope id: still a re-delivery.
      { id: "evt_durable_b", type: "session.execution.started", data: { sessionID: "ses_xxx" }, durable: { aggregateID: "ses_xxx", seq: 1 } },
      { id: "evt_durable_idle", type: "session.idle", data: { sessionID: "ses_xxx" } },
    ],
    assertCalls(calls) {
      assert.equal(calls.length, 1, "durable identity must win over the envelope id")
    },
  })

  await runCase("started with a new durable seq opens the next round", {
    options: { topic: "mock-topic", notifyStarted: false },
    outcome: "succeeded",
    settleMs: 50,
    events: [
      { id: "evt_seq1_started", type: "session.execution.started", data: { sessionID: "ses_xxx" }, durable: { aggregateID: "ses_xxx", seq: 1 } },
      { id: "evt_seq1_succeeded", type: "session.execution.succeeded", data: { sessionID: "ses_xxx" } },
      { id: "evt_seq2_started", type: "session.execution.started", data: { sessionID: "ses_xxx" }, durable: { aggregateID: "ses_xxx", seq: 2 } },
      { id: "evt_seq2_succeeded", type: "session.execution.succeeded", data: { sessionID: "ses_xxx" } },
    ],
    assertCalls(calls) {
      assert.equal(calls.length, 2, "a new durable seq is a new round")
    },
  })

  await runCase("rounds are independent per session", {
    options: { topic: "mock-topic", notifyStarted: false },
    outcome: "succeeded",
    settleMs: 100,
    events: [
      { id: "evt_multi_a_started", type: "session.execution.started", data: { sessionID: "ses_a" } },
      { id: "evt_multi_b_started", type: "session.execution.started", data: { sessionID: "ses_b" } },
      { id: "evt_multi_a_succeeded", type: "session.execution.succeeded", data: { sessionID: "ses_a" } },
      { id: "evt_multi_a_idle", type: "session.idle", data: { sessionID: "ses_a" } },
      { id: "evt_multi_b_succeeded", type: "session.execution.succeeded", data: { sessionID: "ses_b" } },
      { id: "evt_multi_b_idle", type: "session.idle", data: { sessionID: "ses_b" } },
    ],
    assertCalls(calls) {
      assert.equal(calls.length, 2, "interleaved sessions must not clear each other's rounds")
    },
  })

  await runCase("next round may change outcome", {
    options: { topic: "mock-topic" },
    outcome: "succeeded",
    settleMs: 100,
    events: [
      { id: "evt_mix_r1_started", type: "session.execution.started", data: { sessionID: "ses_xxx" } },
      { id: "evt_mix_r1_succeeded", type: "session.execution.succeeded", data: { sessionID: "ses_xxx" } },
      { id: "evt_mix_r1_idle", type: "session.idle", data: { sessionID: "ses_xxx" } },
      { id: "evt_mix_r2_started", type: "session.execution.started", data: { sessionID: "ses_xxx" } },
      {
        id: "evt_mix_r2_failed",
        type: "session.execution.failed",
        data: { sessionID: "ses_xxx", error: { type: "ProviderError", message: "mock execution failed" } },
      },
    ],
    assertCalls(calls) {
      assert.equal(calls.length, 2, "round 2's failure must notify even after round 1's success")
      assert.equal(calls[0].headers.tags, "white_check_mark")
      assert.equal(calls[1].headers.tags, "x")
    },
  })

  // The deterministic inconsistency the round flag fixes: two idle events
  // of the same round with different outcomes must never double-notify,
  // in either order.
  await runCase("idle interruption then idle failure notifies once", {
    options: { topic: "mock-topic" },
    outcome: "interrupted",
    settleMs: 50,
    events: [
      { id: "evt_i_then_f_a", type: "session.idle", data: { sessionID: "ses_xxx" } },
      { id: "evt_i_then_f_b", type: "session.idle", data: { sessionID: "ses_xxx" } },
    ],
    assertCalls(calls) {
      assert.equal(calls.length, 1, "one terminal notification per round, whichever signal arrives first")
      assert.equal(calls[0].headers.tags, "information_source")
    },
  })

  await runCase("idle failure then idle interruption notifies once", {
    options: { topic: "mock-topic" },
    outcome: "failed",
    settleMs: 50,
    events: [
      { id: "evt_f_then_i_a", type: "session.idle", data: { sessionID: "ses_xxx" } },
      { id: "evt_f_then_i_b", type: "session.idle", data: { sessionID: "ses_xxx" } },
    ],
    assertCalls(calls) {
      assert.equal(calls.length, 1, "one terminal notification per round, whichever signal arrives first")
      assert.equal(calls[0].headers.tags, "warning")
    },
  })

  // --- Orthogonality of the outcome switches -------------------------------
  await runCase("succeeded disabled does not suppress failure", {
    options: { topic: "mock-topic", notifySucceeded: false },
    outcome: "failed",
    events: [{ id: "evt_orth_failed", type: "session.idle", data: { sessionID: "ses_xxx" } }],
    assertCalls(calls) {
      assert.equal(calls.length, 1, "notifySucceeded must not gate failures")
      assert.equal(calls[0].headers.tags, "warning")
    },
  })

  await runCase("failed disabled does not suppress success", {
    options: { topic: "mock-topic", notifyFailed: false },
    outcome: "succeeded",
    events: [{ id: "evt_orth_succeeded", type: "session.idle", data: { sessionID: "ses_xxx" } }],
    assertCalls(calls) {
      assert.equal(calls.length, 1, "notifyFailed must not gate successes")
      assert.equal(calls[0].headers.tags, "white_check_mark")
    },
  })

  // A switch-gated skip must not consume the round's terminal state: only a
  // notification that is actually sent may suppress later signals.
  await runCase("switch-gated skip does not consume the round", {
    options: { topic: "mock-topic", notifySucceeded: false },
    outcome: "failed",
    settleMs: 50,
    events: [
      { id: "evt_noconsume_succeeded", type: "session.execution.succeeded", data: { sessionID: "ses_xxx" } },
      { id: "evt_noconsume_idle_failed", type: "session.idle", data: { sessionID: "ses_xxx" } },
    ],
    assertCalls(calls) {
      assert.equal(calls.length, 1, "the gated success must leave the round open for the failure signal")
      assert.equal(calls[0].headers.tags, "warning")
    },
  })

  // replied/cancelled stay bookkeeping-only even with the form switch off:
  // the switch must never turn them into notifications.
  await runCase("form switch off keeps replied bookkeeping inert", {
    options: { topic: "mock-topic", notifyForm: false },
    outcome: "succeeded",
    settleMs: 50,
    events: [
      {
        id: "evt_form_off_created",
        type: "form.created",
        data: { form: { id: "frm_off_1", sessionID: "ses_xxx", title: "关闭表单开关", fields: [] } },
      },
      { id: "evt_form_off_replied", type: "form.replied", data: { id: "frm_off_1", sessionID: "ses_xxx" } },
      {
        id: "evt_form_off_created_again",
        type: "form.created",
        data: { form: { id: "frm_off_1", sessionID: "ses_xxx", title: "关闭表单开关", fields: [] } },
      },
    ],
    assertCalls(calls) {
      assert.equal(calls.length, 0, "form notifications stay off; replied never notifies")
    },
  })

  await runCase("NTFY_NOTIFY_FORM=false disables form notifications", {
    options: { topic: "mock-topic" },
    env: { NTFY_NOTIFY_FORM: "false" },
    outcome: "succeeded",
    events: [{
      id: "evt_form_env_off",
      type: "form.created",
      data: {
        form: { id: "frm_env_off_1", sessionID: "ses_xxx", title: "环境变量关闭的表单", fields: [{ type: "string", key: "why", title: "原因" }] },
      },
    }],
    assertCalls(calls) {
      assert.equal(calls.length, 0, "NTFY_NOTIFY_FORM=false must reach the config layer")
    },
  })

  await runCase("NTFY_NOTIFY_IDLE=false disables idle notifications", {
    options: { topic: "mock-topic" },
    env: { NTFY_NOTIFY_IDLE: "false" },
    outcome: "succeeded",
    events: [{ id: "evt_idle_env_off", type: "session.idle", data: { sessionID: "ses_xxx" } }],
    assertCalls(calls) {
      assert.equal(calls.length, 0, "NTFY_NOTIFY_IDLE=false must reach the config layer")
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

  // --- Logging contract: silent by default, debug-only diagnostics -------
  // The happy path with debug unset must produce zero output: no
  // [ntfy-debug] lines, no [ntfy] error lines.
  await runCase("default config stays silent on the happy path", {
    options: { topic: "mock-topic" },
    outcome: "succeeded",
    captureLogs: true,
    assertCalls(calls) {
      assert.equal(calls.length, 1)
    },
    assertLogs(logs) {
      assert.equal(logs.length, 0, "debug=false must keep the happy path completely silent")
    },
  })

  // A failing ntfy endpoint is operational noise: silent by default, the
  // rejection swallowed, and the subscription loop keeps processing the
  // next event (two notifications attempted, zero output).
  await runCase("send failure is silent by default and the loop survives", {
    options: { topic: "mock-topic" },
    outcome: "succeeded",
    fetchFails: true,
    captureLogs: true,
    settleMs: 50,
    events: [
      { id: "evt_send_fail_idle", type: "session.idle", data: { sessionID: "ses_xxx" } },
      { id: "evt_send_fail_succeeded", type: "session.execution.succeeded", data: { sessionID: "ses_other" } },
    ],
    assertCalls(calls) {
      assert.equal(calls.length, 2, "both notifications must be attempted despite the failures")
    },
    assertLogs(logs) {
      assert.equal(logs.length, 0, "send failures must not print error lines by default")
    },
  })

  // With debug on, the same failure is observable — and only then.
  await runCase("send failure is observable at debug level", {
    options: { topic: "mock-topic", debug: true },
    outcome: "succeeded",
    fetchFails: true,
    captureLogs: true,
    settleMs: 50,
    events: [
      { id: "evt_send_fail_debug_idle", type: "session.idle", data: { sessionID: "ses_xxx" } },
      { id: "evt_send_fail_debug_succeeded", type: "session.execution.succeeded", data: { sessionID: "ses_other" } },
    ],
    assertCalls(calls) {
      assert.equal(calls.length, 2)
    },
    assertLogs(logs) {
      const sendFailures = logs.filter((line) => line.includes("[ntfy-debug] send.failed"))
      assert.equal(sendFailures.length, 2, "each failed send must be logged at debug level")
      assert.equal(
        logs.some((line) => line.startsWith("[ntfy]")),
        false,
        "debug mode must not upgrade diagnostics to error lines",
      )
    },
  })

  // A malformed event (missing data payload) throws inside the handler:
  // silent by default, debug-observable when enabled, and the loop keeps
  // processing subsequent events either way.
  await runCase("malformed event is skipped silently and the loop keeps going", {
    options: { topic: "mock-topic" },
    outcome: "succeeded",
    captureLogs: true,
    events: [
      { id: "evt_malformed", type: "session.idle", data: undefined as unknown as Record<string, unknown> },
      { id: "evt_after_malformed", type: "session.idle", data: { sessionID: "ses_xxx" } },
    ],
    assertCalls(calls) {
      assert.equal(calls.length, 1, "the subscription loop must survive a malformed event")
    },
    assertLogs(logs) {
      assert.equal(logs.length, 0, "handler failures are debug-only, never error lines")
    },
  })

  await runCase("malformed event is observable at debug level", {
    options: { topic: "mock-topic", debug: true },
    outcome: "succeeded",
    captureLogs: true,
    events: [
      { id: "evt_malformed_debug", type: "session.idle", data: undefined as unknown as Record<string, unknown> },
    ],
    assertCalls(calls) {
      assert.equal(calls.length, 0)
    },
    assertLogs(logs) {
      assert.ok(
        logs.some((line) => line.includes("[ntfy-debug] event.failed type=session.idle")),
        "a handler failure must be observable with debug on",
      )
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

    // (c) 文件不存在：静默跳过——debug=false 时零输出，不崩、无 topic 时不发送。
    await runCase("missing config file is skipped silently", {
      options: {},
      env: { NTFY_CONFIG_FILE: join(directory, "absent.json") },
      outcome: "succeeded",
      captureLogs: true,
      assertCalls(calls) {
        assert.equal(calls.length, 0)
      },
      assertLogs(logs) {
        assert.equal(logs.length, 0, "a missing config file must produce zero output with debug off")
      },
    })

    // (d) 非法 JSON：debug 开启时可见一条解析失败诊断，回退环境变量继续工作。
    const brokenFile = join(directory, "broken.json")
    writeFileSync(brokenFile, "{ this is not json", "utf-8")
    await runCase("invalid config file is debug-visible and falls back to env", {
      options: { debug: true },
      env: { NTFY_CONFIG_FILE: brokenFile, NTFY_TOPIC: "env-fallback-topic" },
      outcome: "succeeded",
      captureLogs: true,
      assertCalls(calls) {
        assert.equal(calls.length, 1)
        assert.equal(calls[0].url.endsWith("/env-fallback-topic"), true)
      },
      assertLogs(logs) {
        assert.equal(
          logs.filter((line) => line.includes("[ntfy-debug] config.file parse failed")).length,
          1,
          "exactly one parse-failure diagnostic, and the plugin stays alive",
        )
      },
    })

    // (d) debug=false：同一故障零输出，行为不变（仍回退环境变量）。
    await runCase("invalid config file is silent with debug off", {
      options: {},
      env: { NTFY_CONFIG_FILE: brokenFile, NTFY_TOPIC: "env-fallback-topic" },
      outcome: "succeeded",
      captureLogs: true,
      assertCalls(calls) {
        assert.equal(calls.length, 1)
        assert.equal(calls[0].url.endsWith("/env-fallback-topic"), true)
      },
      assertLogs(logs) {
        assert.equal(logs.length, 0, "a parse failure must not print anything with debug off")
      },
    })

    // (d) 合法 JSON 但不是对象：同样只留一条 debug 诊断并回退。
    const arrayFile = join(directory, "array.json")
    writeFileSync(arrayFile, "[1, 2, 3]", "utf-8")
    await runCase("non-object config file is debug-visible and falls back", {
      options: { debug: true },
      env: { NTFY_CONFIG_FILE: arrayFile, NTFY_TOPIC: "env-fallback-topic" },
      outcome: "succeeded",
      captureLogs: true,
      assertCalls(calls) {
        assert.equal(calls.length, 1)
        assert.equal(calls[0].url.endsWith("/env-fallback-topic"), true)
      },
      assertLogs(logs) {
        assert.equal(
          logs.filter((line) => line.includes("[ntfy-debug] config.file not an object")).length,
          1,
          "a JSON array is not a config object: one debug diagnostic, still no crash",
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

    // debug 开关也可以来自外部文件；启动阶段诊断经缓冲回放，因此文件里的
    // debug=true 同样能看到配置加载日志。
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
        assert.equal(
          logs.some((line) => line.includes("[ntfy-debug] config.file loaded")),
          true,
          "bootstrap diagnostics must be replayed so config loading is visible",
        )
      },
    })

    // 新增的 hook 开关同样走文件白名单与分层读取。
    const switchFile = join(directory, "switches.json")
    writeFileSync(switchFile, JSON.stringify({ topic: "switch-file-topic", notifyIdle: false, notifySucceeded: false, notifyForm: false }), "utf-8")
    await runCase("config file can disable the new hook switches", {
      options: {},
      env: { NTFY_CONFIG_FILE: switchFile },
      outcome: "succeeded",
      events: [
        { id: "evt_switch_file_idle", type: "session.idle", data: { sessionID: "ses_xxx" } },
        {
          id: "evt_switch_file_form",
          type: "form.created",
          data: { form: { id: "frm_switch_file", sessionID: "ses_xxx", title: "文件层关闭", fields: [] } },
        },
      ],
      assertCalls(calls) {
        assert.equal(calls.length, 0, "file-provided notifyIdle/notifySucceeded/notifyForm=false must apply")
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
        "notifyRoot", "notifyChildren", "notifyStarted", "notifyIdle",
        "notifySucceeded", "notifyFailed", "notifyInterrupted",
        "notifyPermission", "notifyForm", "notifyRetry",
        "debug", "sessionTimeoutMs",
      ]) {
        assert.ok(created.includes(`"${key}"`), `模板必须包含 ${key} 字段`)
      }
      const parsedTemplate = parseJsonc(created) as Record<string, unknown>
      assert.equal(parsedTemplate.topic, "", "topic 默认留空占位，由用户填写")
      assert.equal(parsedTemplate.server, "https://ntfy.sh", "模板 server 保留内置默认值")
      // 新增开关的模板取值必须等于内置默认值，保证首次创建的模板不改变
      // 任何通知行为。
      assert.equal(parsedTemplate.notifyIdle, true, "模板 notifyIdle 保留默认 true")
      assert.equal(parsedTemplate.notifySucceeded, true, "模板 notifySucceeded 保留默认 true")
      assert.equal(parsedTemplate.notifyInterrupted, true, "模板 notifyInterrupted 保留默认 true")
      assert.equal(parsedTemplate.notifyForm, true, "模板 notifyForm 保留默认 true")

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
        options: { debug: true },
        env: { NTFY_CONFIG_FILE: undefined, HOME: home, USERPROFILE: home },
        outcome: "succeeded",
        captureLogs: true,
        assertCalls(calls) {
          assert.equal(calls.length, 0, "旧文件名不在读取范围内")
        },
        assertLogs(logs) {
          assert.equal(
            logs.filter((line) => line.includes("[ntfy-debug] config.file legacy rename hint")).length,
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

    await runCase("unwritable default config path is debug-visible and keeps running", {
      options: { topic: "inline-topic", debug: true },
      env: { NTFY_CONFIG_FILE: undefined, HOME: home, USERPROFILE: home },
      outcome: "succeeded",
      captureLogs: true,
      assertCalls(calls) {
        assert.equal(calls.length, 1)
        assert.equal(calls[0].url.endsWith("/inline-topic"), true)
      },
      assertLogs(logs) {
        assert.equal(
          logs.filter((line) => line.includes("[ntfy-debug] config.file create failed")).length,
          1,
          "创建失败必须只留一条诊断，插件继续工作",
        )
      },
    })

    // debug=false：不可写路径零输出，行为不变。
    await runCase("unwritable default config path is silent with debug off", {
      options: { topic: "inline-topic" },
      env: { NTFY_CONFIG_FILE: undefined, HOME: home, USERPROFILE: home },
      outcome: "succeeded",
      captureLogs: true,
      assertCalls(calls) {
        assert.equal(calls.length, 1)
        assert.equal(calls[0].url.endsWith("/inline-topic"), true)
      },
      assertLogs(logs) {
        assert.equal(logs.length, 0, "an unwritable config path must not print anything with debug off")
      },
    })
  })

  await runReconnectCase()

  console.log("All ntfy self-checks passed")
}

await main()
