import ntfyPlugin from "../src/index.ts"

type PluginContext = Parameters<typeof ntfyPlugin.setup>[0]
type Outcome = "succeeded" | "failed" | "interrupted"

interface LiveEvent {
  id: string
  type: string
  data: Record<string, unknown>
}

async function* mockEvents(signal: AbortSignal, events: ReadonlyArray<LiveEvent>): AsyncGenerator<unknown> {
  const onAbort = () => {}
  signal.addEventListener("abort", onAbort, { once: true })
  try {
    for (const event of events) yield event
  } finally {
    signal.removeEventListener("abort", onAbort)
  }
}

async function waitForEventLoop(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await Promise.resolve()
  await new Promise<void>((resolve) => setTimeout(resolve, 5_000))
}

function makeSession(sessionID: string, title: string, outcome: Outcome) {
  const now = Date.now()
  return {
    id: sessionID,
    projectID: "proj_local",
    title,
    model: { providerID: "openai", id: "gpt-4o-mini" },
    outcome,
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    time: { created: now - 83_000, idle: now },
    location: { directory: "C:\\mock\\project" },
  }
}

async function main(): Promise<void> {
  const sessions = {
    ses_live_ok: makeSession("ses_live_ok", "ntfy 完成联调", "succeeded"),
    ses_live_fail: makeSession("ses_live_fail", "ntfy 失败联调", "failed"),
    ses_live_intr: makeSession("ses_live_intr", "ntfy 中断联调", "interrupted"),
    ses_live_perm: makeSession("ses_live_perm", "ntfy 授权联调", "succeeded"),
    ses_live_start: makeSession("ses_live_start", "ntfy 开始联调", "succeeded"),
    ses_live_retry: makeSession("ses_live_retry", "ntfy 重试联调", "succeeded"),
  }

  const events: LiveEvent[] = [
    { id: "evt_live_ok", type: "session.idle", data: { sessionID: "ses_live_ok" } },
    {
      id: "evt_live_fail",
      type: "session.execution.failed",
      data: {
        sessionID: "ses_live_fail",
        error: { type: "MockFailure", message: "联调模拟执行失败" },
      },
    },
    { id: "evt_live_intr", type: "session.idle", data: { sessionID: "ses_live_intr" } },
    {
      id: "evt_live_perm",
      type: "permission.asked",
      data: {
        id: "perm_live_1",
        sessionID: "ses_live_perm",
        action: "file.write",
        resources: ["src/index.ts"],
        message: "联调模拟授权请求",
      },
    },
    { id: "evt_live_start", type: "session.execution.started", data: { sessionID: "ses_live_start" } },
    {
      id: "evt_live_retry",
      type: "session.retry.scheduled",
      data: {
        sessionID: "ses_live_retry",
        assistantMessageID: "msg_live_retry",
        attempt: 2,
        at: Date.now() + 1_000,
        error: { type: "MockRetry", message: "联调模拟重试" },
      },
    },
  ]

  const context = {
    options: {
      server: "https://ntfy.sh",
      topic: "opencode-oZ7vgHOxFHMfstgF",
      notifyRoot: true,
      notifyChildren: true,
      notifyStarted: true,
      notifyFailed: true,
      notifyPermission: true,
      notifyRetry: true,
    },
    location: {
      directory: "C:\\mock\\project",
      project: {
        id: "proj_local",
        directory: "C:\\mock\\project",
        canonical: "C:\\mock\\project",
      },
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => sessions[sessionID as keyof typeof sessions],
      context: async ({ sessionID }: { sessionID: string }) => [
        {
          id: `msg_${sessionID}_assistant`,
          type: "assistant",
          model: { providerID: "anthropic", id: "claude-opus-4-1" },
        },
        {
          id: `msg_${sessionID}_idle`,
          type: "idle",
          outcome: sessions[sessionID as keyof typeof sessions]?.outcome,
        },
      ],
    },
    event: {
      subscribe: ({ signal }: { signal: AbortSignal }) => mockEvents(signal, events),
    },
  } as unknown as PluginContext

  let cleanup: Awaited<ReturnType<typeof ntfyPlugin.setup>>
  try {
    cleanup = await ntfyPlugin.setup(context)
    await waitForEventLoop()
    console.log("Live ntfy six-event emoji demonstration completed without a plugin error")
  } catch (error) {
    console.error("Live ntfy notification failed:", error)
    process.exitCode = 1
  } finally {
    if (typeof cleanup === "function") await cleanup()
  }
}

await main()
