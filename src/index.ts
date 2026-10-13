import { Plugin } from "@opencode/plugin"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

type Outcome = "succeeded" | "failed" | "interrupted"

interface ModelLike {
  providerID: string
  id: string
  variant?: string
}

interface FormOptionLike {
  label?: string
  value?: string
  description?: string
}

interface FormQuestionLike {
  type?: string
  key?: string
  title?: string
  description?: string
  required?: boolean
  default?: unknown
  options?: ReadonlyArray<FormOptionLike>
}

interface FormEventLike {
  id?: string
  sessionID?: string
  title?: string
  // OpenCode 2.0.16 protocol shape: form.fields (string/number/integer/boolean/multiselect/external).
  fields?: ReadonlyArray<FormQuestionLike>
  // Tolerate the flattened shape some builds emit.
  questions?: ReadonlyArray<FormQuestionLike>
}

interface FormCreatedEventLike {
  type: "form.created"
  data: FormEventLike | { form?: FormEventLike }
}

// Runtime tolerance for the permission protocol's tool-call source: the
// schema guarantees { type: "tool", messageID, id }, but the dedup key
// below must degrade gracefully when a build omits or blanks a field.
interface PermissionSourceLike {
  type?: string
  messageID?: string
  id?: string
}

interface Config {
  server: string
  topic?: string
  token?: string
  tag?: string
  priority?: number
  notifyRoot: boolean
  notifyChildren: boolean
  notifyStarted: boolean
  notifyIdle: boolean
  notifySucceeded: boolean
  notifyFailed: boolean
  notifyInterrupted: boolean
  notifyPermission: boolean
  notifyForm: boolean
  notifyRetry: boolean
  debug: boolean
  sessionTimeoutMs: number
}

interface MessageLike {
  id: string
  type: string
  outcome?: Outcome
  model?: ModelLike
}

interface LocationLike {
  directory?: string
  project?: {
    id?: string
    directory?: string
    canonical?: string
    name?: string
  }
}

interface TokensLike {
  input?: number
  output?: number
  reasoning?: number
  cache?: {
    read?: number
    write?: number
  }
}

interface SessionLike {
  projectID?: string
  parentID?: string
  title?: string
  model?: ModelLike
  outcome?: Outcome
  location?: LocationLike
  tokens?: TokensLike
  time: {
    created: number
    idle?: number
  }
}

interface SessionReaderContext {
  location?: LocationLike
  session: {
    get(input: { sessionID: string }): Promise<SessionLike>
    context(input: { sessionID: string }): Promise<ReadonlyArray<MessageLike>>
  }
}

const DEFAULT_SERVER = "https://ntfy.sh"
const REQUEST_TIMEOUT_MS = 8_000
// External local config file (see README "多电脑配置"): lives at
// $HOME/.config/opencode/ntfy.local.jsonc — the OpenCode user config
// directory — and holds per-machine overrides (topic/server/token/...) so
// the git-synced opencode.jsonc can stay identical across machines. The
// default file is auto-created (with a commented template) the first time
// the plugin runs on a machine; an explicitly specified configFile is
// read-only and never written.
const CONFIG_FILE_NAME = "ntfy.local.jsonc"
// Pre-rename name. If the default .jsonc file is missing but this legacy
// file sits next to it, creating a fresh blank template would silently
// shadow the user's real settings — so we tell them to rename instead.
const LEGACY_CONFIG_FILE_NAME = "ntfy.local.json"
// Whitelist of keys read from the external file — exactly the Config
// surface. Unknown keys are ignored so a stale or hand-edited file can
// never inject an unrecognized option. `satisfies` keeps the list honest
// if Config ever gains or loses a field.
const CONFIG_FILE_KEYS = [
  "server",
  "topic",
  "token",
  "tag",
  "priority",
  "notifyRoot",
  "notifyChildren",
  "notifyStarted",
  "notifyIdle",
  "notifySucceeded",
  "notifyFailed",
  "notifyInterrupted",
  "notifyPermission",
  "notifyForm",
  "notifyRetry",
  "debug",
  "sessionTimeoutMs",
] as const satisfies ReadonlyArray<keyof Config>

// A hung session lookup stalls the single subscription loop, so every host
// call is raced against a timeout instead of waiting indefinitely.
// Overridable via options.sessionTimeoutMs / NTFY_SESSION_TIMEOUT_MS;
// invalid values fall back to the default and acceptables are clamped.
const SESSION_LOOKUP_TIMEOUT_DEFAULT_MS = 5_000
const SESSION_LOOKUP_TIMEOUT_MIN_MS = 1_000
const SESSION_LOOKUP_TIMEOUT_MAX_MS = 30_000
// Dedup keys are unique per session/request, so a busy host keeps minting new
// ones forever. Cap membership and evict the oldest key first (insertion
// order == LRU here, since keys are written once) to keep memory flat over
// multi-week uptime. Dedup still suppresses duplicates exactly like a plain
// Set — only keys older than the cap lose their protection.
const DEDUP_ENTRY_LIMIT = 20
// Reconnects are unlimited: exponential backoff from 1s, capped at 60s with
// jitter, so a flaky transport degrades into slow idle polling instead of
// silence, and never spins in a tight loop.
const RECONNECT_BASE_DELAY_MS = 1_000
const RECONNECT_MAX_DELAY_MS = 60_000

// The host emits a high volume of events (message parts, tool calls, ...).
// Only these types can produce a notification; anything else is dropped
// before any logging or session IO happens.
const NOTIFIED_EVENT_TYPES: ReadonlySet<string> = new Set([
  "session.idle",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "permission.asked",
  "permission.replied",
  "form.created",
  // Reply/cancel events are whitelisted for bookkeeping only (form.id
  // correlation + debug trace); they never produce a notification.
  "form.replied",
  "form.cancelled",
  "session.retry.scheduled",
])

// Logging policy (single tier): EVERY plugin log line is a debug
// diagnostic. With debug=false the plugin is completely silent — no
// topic, legacy file hints, config read/parse failures and template
// write failures are diagnostics too, because an unconditional line per
// setup still reaches the host log on every load and a broken host
// console must never turn a log call into a plugin failure. With
// debug=true the [ntfy-debug] stream covers config loading, event
// filtering/skips, send failures, event-handler failures and reconnects.
// The flag is captured per setup() call: a module-level variable would let
// one instance's debug setting overwrite another's (multi-project hosts,
// hot reloads). Module scope holds pure, stateless code only.
type DebugLogger = (message: string) => void

function createDebugLogger(enabled: boolean): DebugLogger {
  return (message: string): void => {
    if (!enabled) return
    try {
      console.error(`[ntfy-debug] ${message}`)
    } catch {
      // Diagnostics must never affect plugin behavior.
    }
  }
}

// The final debug flag is only known AFTER the external config file is
// read, but the file reader itself needs a logger (a file-provided
// debug=true must still show config loading). Bootstrap diagnostics are
// therefore buffered — bounded, oldest-first — and replayed through the
// final logger once config.debug is resolved. The buffer is not a second
// source of truth: it never prints on its own, and with debug=false
// everywhere it is simply discarded, so the plugin stays silent. Debug
// resolution itself keeps the normal priority options > env > file >
// default (see readConfig), so options.debug=false wins over a file's
// true — the buffer does not change that.
const BOOTSTRAP_LOG_LIMIT = 50

interface BootstrapLogger {
  log: DebugLogger
  replay(log: DebugLogger): void
}

function createBootstrapLogger(): BootstrapLogger {
  const buffer: string[] = []
  return {
    log: (message: string): void => {
      if (buffer.length >= BOOTSTRAP_LOG_LIMIT) buffer.shift()
      buffer.push(message)
    },
    replay: (log: DebugLogger): void => {
      const pending = buffer.splice(0, buffer.length)
      for (const message of pending) log(message)
    },
  }
}

function envValue(name: string): string | undefined {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name]
}

function optionOrEnv(options: Record<string, unknown>, option: string, env: string): unknown {
  return options[option] ?? envValue(env)
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const result = value.trim()
  return result.length > 0 ? result : undefined
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value
  if (typeof value !== "string") return fallback

  switch (value.trim().toLowerCase()) {
    case "false":
    case "0":
    case "no":
    case "off":
      return false
    case "true":
    case "1":
    case "yes":
    case "on":
      return true
    default:
      return fallback
  }
}

function priorityValue(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value)
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 5 ? parsed : undefined
}

// Timeout resolution order: options/env first, default otherwise. Missing,
// non-numeric or non-positive values are invalid → default; valid values are
// clamped into [MIN, MAX] so a typo can neither stall the loop forever nor
// make every lookup fail. Exported for self-tests.
export function sessionTimeoutValue(value: unknown): number {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" ? Number(stringValue(value)) : Number.NaN
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return SESSION_LOOKUP_TIMEOUT_DEFAULT_MS
  }
  return Math.min(
    SESSION_LOOKUP_TIMEOUT_MAX_MS,
    Math.max(SESSION_LOOKUP_TIMEOUT_MIN_MS, Math.round(parsed)),
  )
}

interface BoundedKeySet {
  has(key: string): boolean
  add(key: string): void
  readonly size: number
}

interface BoundedKeyMap {
  has(key: string): boolean
  get(key: string): string | undefined
  set(key: string, value: string | undefined): void
  delete(key: string): boolean
  readonly size: number
}

// Pure: backoff for reconnect attempt N (0-based). Exponential from 1s,
// capped at 60s, ±10% jitter, floored at 500ms so retries never become a
// hot loop. Module-level and stateless so it can be unit-tested directly.
export function reconnectDelayMs(attempt: number): number {
  const base = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** Math.min(attempt, 20))
  const jitter = base * 0.1 * (Math.random() * 2 - 1)
  return Math.max(RECONNECT_BASE_DELAY_MS / 2, Math.round(base + jitter))
}

// Insertion-ordered dedup set with a hard cap. `has`/`add` mirror Set
// semantics; once the cap is exceeded the oldest key is evicted, so
// membership always covers the most recent activity only. Implemented over
// a Map because Map preserves insertion order while Set eviction would
// require rehashing the whole store. Exported for self-tests.
export function createBoundedKeySet(): BoundedKeySet {
  const entries = new Map<string, true>()
  return {
    has: (key: string): boolean => entries.has(key),
    add: (key: string): void => {
      if (entries.has(key)) return // re-insert never refreshes LRU age
      entries.set(key, true)
      if (entries.size > DEDUP_ENTRY_LIMIT) {
        const oldest = entries.keys().next()
        if (!oldest.done) entries.delete(oldest.value)
      }
    },
    get size(): number { return entries.size },
  }
}

// Insertion-ordered bounded map with the same cap and oldest-first eviction
// as createBoundedKeySet, for permission.id → tool-call-key bookkeeping.
// Entries are deleted when the host reports the reply; the cap is the
// backstop for replies that never arrive, so a host that drops reply events
// cannot grow the table either. Exported for self-tests.
export function createBoundedKeyMap(): BoundedKeyMap {
  const entries = new Map<string, string | undefined>()
  return {
    has: (key: string): boolean => entries.has(key),
    get: (key: string): string | undefined => entries.get(key),
    set: (key: string, value: string | undefined): void => {
      entries.set(key, value) // re-set overwrites without refreshing age
      if (entries.size > DEDUP_ENTRY_LIMIT) {
        const oldest = entries.keys().next()
        if (!oldest.done) entries.delete(oldest.value)
      }
    },
    delete: (key: string): boolean => entries.delete(key),
    get size(): number { return entries.size },
  }
}

// Per-session execution-round state — the lifecycle dedup that replaces
// the old sessionID-keyed notified sets (which never reset and therefore
// swallowed every notification after the first round of a session):
//   - startedKey: identity of the started event that opened the current
//     round. A re-delivered started event (same durable identity) must NOT
//     reopen a round whose terminal was already notified.
//   - terminalNotified: whether this round already produced a terminal
//     notification. It merges the round's idle + execution completion
//     signals into one notification and is only ever set when a
//     notification is actually sent (never consumed by a skipped event).
// One entry per session, same cap and oldest-first eviction as the other
// bounded stores; eviction merely makes that session's next round look
// unopened (one extra notification at worst). Exported for self-tests.
interface SessionRound {
  startedKey?: string
  terminalNotified?: boolean
}

interface BoundedRoundMap {
  get(sessionID: string): SessionRound | undefined
  ensure(sessionID: string): SessionRound
  readonly size: number
}

export function createBoundedRoundMap(): BoundedRoundMap {
  const entries = new Map<string, SessionRound>()
  return {
    get: (sessionID: string): SessionRound | undefined => entries.get(sessionID),
    ensure: (sessionID: string): SessionRound => {
      const existing = entries.get(sessionID)
      if (existing !== undefined) return existing // never refreshes LRU age
      const created: SessionRound = {}
      entries.set(sessionID, created)
      if (entries.size > DEDUP_ENTRY_LIMIT) {
        const oldest = entries.keys().next()
        if (!oldest.done) entries.delete(oldest.value)
      }
      return created
    },
    get size(): number { return entries.size },
  }
}

// Stable identity of an execution-lifecycle event, per the local V2
// protocol (@opencode/client generated types): durable events carry
// { aggregateID, seq }, and that pair survives transport redelivery even
// when the envelope id differs, so it is preferred. Events without durable
// metadata (session.idle, permission.*, form.*) or with a blank/non-finite
// seq fall back to the envelope id; a completely unidentified event yields
// undefined so callers can stay conservative. Pure and exported for
// self-tests; never returns an empty key.
export function executionEventKey(event: {
  id?: string
  durable?: { aggregateID?: string; seq?: number }
}): string | undefined {
  const aggregateID = stringValue(event.durable?.aggregateID)
  const seq = event.durable?.seq
  if (aggregateID !== undefined && typeof seq === "number" && Number.isFinite(seq)) {
    return `${aggregateID}:${seq}`
  }
  return stringValue(event.id)
}

// A permission.asked carries two identities: permission.id names one request
// instance, while the tool call (messageID + tool call id) names the tool
// that raised it. The host may re-ask the same tool call with a fresh
// permission.id, so the tool call is the stable notification identity:
// `sessionID:messageID:source.id`. Pure and exported for self-tests; a
// missing or blank piece yields undefined so callers fall back to
// content-based dedup instead of inventing a colliding key.
export function permissionToolKey(
  sessionID: string,
  source: PermissionSourceLike | undefined,
): string | undefined {
  const messageID = stringValue(source?.messageID)
  const toolID = stringValue(source?.id)
  const session = stringValue(sessionID)
  if (!session || !messageID || !toolID) return undefined
  return `${session}:${messageID}:${toolID}`
}

// A form carries one stable identity: form.id (the frm_ ID from
// Form.Info). The host may re-publish the same form — an MCP elicitation
// re-surfacing, a reconnect redelivery — under an identical id, so the
// id alone is the notification identity: re-delivery of one id notifies
// once, while a different id notifies even when session + title match
// exactly (the old sessionID:title content key silently killed those).
// Only when the id is missing or not a non-blank string (older,
// flattened builds) do we fall back to the content key. Pure and
// exported for self-tests; never returns an empty key.
export function formDedupKey(form: FormEventLike | undefined): string {
  const formID = stringValue(form?.id)
  if (formID !== undefined) return formID
  const sessionID = typeof form?.sessionID === "string" ? form.sessionID : "未知"
  return `${sessionID}:${form?.title ?? ""}`
}

// Tolerance layer over JSON.parse for the local config file: strips //
// line comments and /* */ block comments outside of string literals, then
// delegates to JSON.parse. The scan is character-based and string-aware, so
// URLs ("https://ntfy.sh") and comment-like text inside string values
// survive intact. Trailing commas are NOT tolerated — comments are the only
// JSONC affordance the file format promises. Throws on invalid JSON; the
// caller turns that into one error line and a silent fallback.
export function parseJsonc(text: string): unknown {
  let stripped = ""
  let inString = false
  let inLineComment = false
  let inBlockComment = false

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    const next = text[index + 1]

    if (inLineComment) {
      if (character === "\n") {
        inLineComment = false
        stripped += character
      }
      continue
    }
    if (inBlockComment) {
      if (character === "*" && next === "/") {
        inBlockComment = false
        index += 1
      }
      continue
    }
    if (inString) {
      stripped += character
      if (character === "\\") {
        // Consume the escape pair so an escaped quote cannot terminate the
        // string (and the comment scan below never sees string content).
        stripped += next ?? ""
        index += 1
      } else if (character === '"') {
        inString = false
      }
      continue
    }
    if (character === '"') {
      inString = true
      stripped += character
      continue
    }
    if (character === "/" && next === "/") {
      inLineComment = true
      index += 1
      continue
    }
    if (character === "/" && next === "*") {
      inBlockComment = true
      index += 1
      continue
    }
    stripped += character
  }

  return JSON.parse(stripped)
}

// The single default location: $HOME/.config/opencode (Windows resolves HOME
// to USERPROFILE, i.e. C:\Users\<user>\.config\opencode) — the OpenCode user
// config directory that also holds the global opencode.jsonc. No XDG or
// %APPDATA% fallback chain: one path, created on demand, no ambiguity about
// which file wins.
function defaultConfigDirectory(): string | undefined {
  const home = homeDirectory()
  return home !== undefined ? join(home, ".config", "opencode") : undefined
}

function homeDirectory(): string | undefined {
  try {
    const fromOs = stringValue(homedir())
    if (fromOs !== undefined) return fromOs
  } catch {
    // Fall through to the environment variables below.
  }
  return stringValue(envValue("HOME")) ?? stringValue(envValue("USERPROFILE"))
}

interface ConfigFileTarget {
  path: string
  // Only the plugin-owned default path is created when missing and seeded
  // with the template below. An explicitly specified file belongs to the
  // user: read it, never write it (their path may be shared, read-only,
  // or managed by another tool).
  autoCreate: boolean
}

// Explicit configFile (options.configFile / NTFY_CONFIG_FILE) wins outright
// and stays read-only; otherwise the default $HOME/.config/opencode single
// path is used and auto-created on first run. Returning undefined means "no
// external file" — only possible when the home directory cannot be
// determined at all — which is a silent skip, never an error. Relative
// explicit paths resolve against the host process's working directory;
// absolute paths are recommended (see README).
function resolveConfigFileTarget(options: Record<string, unknown>): ConfigFileTarget | undefined {
  const explicit = stringValue(optionOrEnv(options, "configFile", "NTFY_CONFIG_FILE"))
  if (explicit !== undefined) return { path: explicit, autoCreate: false }
  const directory = defaultConfigDirectory()
  if (directory === undefined) return undefined
  return { path: join(directory, CONFIG_FILE_NAME), autoCreate: true }
}

// The template seeded into the default config file on first run. Every
// field carries a Chinese comment stating its purpose, format and default;
// `topic`/`token`/`tag` ship blank placeholders for the user to fill in.
// `priority` is deliberately left commented out so the automatic
// per-outcome priority (success 3, failure/interrupted 4, permission 5)
// stays intact until the user opts into a fixed value. All other values
// equal the built-in defaults, so a freshly created file changes behavior
// only in that the template itself documents every option.
const DEFAULT_CONFIG_FILE_TEMPLATE = `{
  // =====================================================
  // ntfy 通知插件 · 本机差异配置（首次运行时自动创建）
  //
  // 文件用途：存放只对「这一台电脑」生效的 ntfy 插件配置
  //   （topic、server、token 等）。路径固定为：
  //   $HOME/.config/opencode/ntfy.local.jsonc
  //   （Windows 即 C:\\Users\\<用户名>\\.config\\opencode），
  //   按机器各自维护，请勿随 git 同步（加入 .gitignore）。
  //
  // 与 opencode.jsonc 的分工：
  //   - opencode.jsonc（项目/全局，可跟 git 同步）：放各处一致的
  //     公共配置，如通知开关、server 等；
  //   - 本文件：放本机差异，主要是 topic、token 以及排障用的 debug。
  //
  // 优先级（从高到低）：
  //   opencode.jsonc 的 options 内联值
  //     > 环境变量（NTFY_TOPIC 等 NTFY_* 变量）
  //       > 本文件
  //         > 内置默认值
  //
  // 格式：JSON，支持 // 行注释和 /* */ 块注释（不支持尾逗号）；
  //   只读取下方列出的字段，其它字段一律忽略。
  //   修改本文件后需要重启 OpenCode 才会生效。
  // =====================================================

  // ntfy 服务地址。默认 https://ntfy.sh；自建服务填你自己的地址。
  "server": "https://ntfy.sh",

  // topic：必填。通知发送到哪个 ntfy topic。
  //   公共 ntfy.sh 上 topic 名相当于"密码"，请使用足够长、难猜测的
  //   名字（如 my-opencode-alerts-8f3k2j），避免无关人员也能收到。
  //   留空则插件不发送任何通知：仅 debug=true 时记录一条诊断日志，
  //   否则完全静默。
  "topic": "",

  // token：可选。ntfy 访问令牌，用于私有/受保护的 topic，
  //   发送时以 Authorization: Bearer <token> 请求头携带。
  //   与通知正文里的"Token 消耗"无关。仅自建或受保护的服务需要。
  "token": "",

  // tag：可选。覆盖默认的 ntfy 图标标签（emoji 短代码，如
  //   white_check_mark、warning、rotating_light、x、information_source）。
  //   不填则按通知类型自动选择。
  "tag": "",

  // priority：可选，整数 1~5（1 最低、5 最高）。
  //   不填则按结果自动选择：成功 3、失败/中断 4、需要授权 5。
  //   填了固定值则所有通知统一使用该优先级。
  // "priority": 3,

  // notifyRoot：主任务（无父会话的执行）完成/失败时是否通知。
  "notifyRoot": true,

  // notifyChildren：子任务（有父会话的执行）完成/失败时是否通知。
  "notifyChildren": true,

  // notifyStarted：任务刚开始执行时是否推送一条通知（默认关，避免刷屏）。
  //   无论开关与否，started 事件都会维护执行生命周期（去重），
  //   不会影响后续轮次的通知。
  "notifyStarted": false,

  // notifyIdle：session.idle 空闲事件的通知总闸（默认开）。
  //   关闭后只有 session.execution.* 系列事件会通知；
  //   开启时仍需对应结果开关（notifySucceeded / notifyFailed /
  //   notifyInterrupted）同时打开才会发送（二者取交集）。
  "notifyIdle": true,

  // notifySucceeded：任务成功完成时是否通知。覆盖
  //   session.execution.succeeded 与 session.idle 的成功结果，
  //   同一轮执行内过去重只会推送一条。
  "notifySucceeded": true,

  // notifyFailed：任务执行失败时是否通知。
  "notifyFailed": true,

  // notifyInterrupted：任务被中断时是否通知。覆盖
  //   session.execution.interrupted 与 session.idle 的中断结果，
  //   同一轮执行内过去重只会推送一条。
  "notifyInterrupted": true,

  // notifyPermission：工具调用需要你授权（批准/拒绝）时是否通知。
  "notifyPermission": true,

  // notifyForm：表单提问（需要你回答问题时）是否通知。
  "notifyForm": true,

  // notifyRetry：请求失败、即将自动重试时是否通知（默认关）。
  "notifyRetry": false,

  // debug：是否输出调试日志（[ntfy-debug] 前缀，写入 OpenCode 日志）。
  //   关闭时插件完全静默（连缺 topic、配置文件异常也不输出）；
  //   排障时打开。优先级同其它配置：options > 环境变量 > 本文件 > 默认。
  "debug": false,

  // sessionTimeoutMs：单次会话信息查询的超时时间（毫秒）。
  //   超出即跳过该次事件的通知，避免卡住整个事件循环。
  //   合法范围 1000~30000，默认 5000。
  "sessionTimeoutMs": 5000
}
`

// The plugin only ever reads the one default .jsonc file. When it is missing
// but the pre-rename .json file sits next to it, seeding a fresh blank
// template would silently shadow the user's real settings with an empty
// topic — so we point at the rename instead and create nothing.
function warnLegacyConfigFile(directory: string, log: DebugLogger): boolean {
  const legacy = join(directory, LEGACY_CONFIG_FILE_NAME)
  let legacyExists = false
  try {
    legacyExists = existsSync(legacy)
  } catch {
    legacyExists = false
  }
  if (!legacyExists) return false
  log(`config.file legacy rename hint path=${legacy} -> ${join(directory, CONFIG_FILE_NAME)}`)
  return true
}

// Creates the default config file (directory tree included) the first time
// the plugin runs on a machine. Never throws: an unwritable path, a file
// blocking the directory, or a pre-rename file in the way all resolve to at
// most one log line, and the plugin continues with the remaining config
// sources. Concurrent setups are idempotent — the existence guard plus an
// identical template makes a racing double-write harmless.
function ensureDefaultConfigFile(path: string, log: DebugLogger): void {
  try {
    if (existsSync(path)) return
    const directory = dirname(path)
    mkdirSync(directory, { recursive: true })
    if (warnLegacyConfigFile(directory, log)) return
    writeFileSync(path, DEFAULT_CONFIG_FILE_TEMPLATE, "utf-8")
    log(`config.file auto-created path=${path}`)
  } catch (error) {
    log(`config.file create failed path=${path} error=${String(error)}`)
  }
}

// Reads the external local config file and extracts the whitelisted keys.
// Never throws: a missing file is a silent skip (debug only), and any read
// or parse failure yields no values (one debug line), so setup continues
// with the remaining config sources.
function readConfigFileValues(path: string, log: DebugLogger): Partial<Record<keyof Config, unknown>> {
  let text: string
  try {
    // A UTF-8 BOM (Windows editors) would otherwise break JSON.parse.
    text = readFileSync(path, "utf-8").replace(/^\uFEFF/, "")
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR") {
      log(`config.file skipped path=${path} reason=missing`)
      return {}
    }
    log(`config.file read failed path=${path} error=${String(error)}`)
    return {}
  }

  let parsed: unknown
  try {
    parsed = parseJsonc(text)
  } catch (error) {
    log(`config.file parse failed path=${path} error=${String(error)}`)
    return {}
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    log(`config.file not an object path=${path}`)
    return {}
  }

  const source = parsed as Record<string, unknown>
  const values: Partial<Record<keyof Config, unknown>> = {}
  for (const key of CONFIG_FILE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(source, key)) values[key] = source[key]
  }
  log(`config.file loaded path=${path} keys=${CONFIG_FILE_KEYS.filter((key) => key in values).join(",")}`)
  return values
}

// Resolution order per field: inline options > environment variables >
// external config file > built-in defaults. The file layer only fills what
// options/env left unset (nullish), so a single blank value never blocks a
// lower layer.
function readConfig(options: Record<string, unknown>, log: DebugLogger): Config {
  const target = resolveConfigFileTarget(options)
  if (target !== undefined && target.autoCreate) ensureDefaultConfigFile(target.path, log)
  const fileValues = target !== undefined ? readConfigFileValues(target.path, log) : {}
  const layered = (option: keyof Config, env: string): unknown =>
    optionOrEnv(options, option, env) ?? fileValues[option]

  return {
    server: stringValue(layered("server", "NTFY_SERVER")) ?? DEFAULT_SERVER,
    topic: stringValue(layered("topic", "NTFY_TOPIC")),
    token: stringValue(layered("token", "NTFY_TOKEN")),
    tag: stringValue(layered("tag", "NTFY_TAG")),
    priority: priorityValue(layered("priority", "NTFY_PRIORITY")),
    notifyRoot: booleanValue(layered("notifyRoot", "NTFY_NOTIFY_ROOT"), true),
    notifyChildren: booleanValue(layered("notifyChildren", "NTFY_NOTIFY_CHILDREN"), true),
    notifyStarted: booleanValue(layered("notifyStarted", "NTFY_NOTIFY_STARTED"), false),
    notifyIdle: booleanValue(layered("notifyIdle", "NTFY_NOTIFY_IDLE"), true),
    notifySucceeded: booleanValue(layered("notifySucceeded", "NTFY_NOTIFY_SUCCEEDED"), true),
    notifyFailed: booleanValue(layered("notifyFailed", "NTFY_NOTIFY_FAILED"), true),
    notifyInterrupted: booleanValue(layered("notifyInterrupted", "NTFY_NOTIFY_INTERRUPTED"), true),
    notifyPermission: booleanValue(layered("notifyPermission", "NTFY_NOTIFY_PERMISSION"), true),
    notifyForm: booleanValue(layered("notifyForm", "NTFY_NOTIFY_FORM"), true),
    notifyRetry: booleanValue(layered("notifyRetry", "NTFY_NOTIFY_RETRY"), false),
    debug: booleanValue(layered("debug", "NTFY_DEBUG"), false),
    sessionTimeoutMs: sessionTimeoutValue(layered("sessionTimeoutMs", "NTFY_SESSION_TIMEOUT_MS")),
  }
}

function formatDuration(start: number, end: number | undefined): string {
  if (end === undefined || !Number.isFinite(start) || !Number.isFinite(end) || end < start) return "未知"

  const milliseconds = Math.round(end - start)
  if (milliseconds < 1_000) return `${milliseconds}ms`

  const seconds = Math.floor(milliseconds / 1_000)
  if (seconds < 60) return `${seconds}s`

  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) return remainingSeconds === 0 ? `${minutes}m` : `${minutes}m ${remainingSeconds}s`

  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`
}

function tokenValue(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? value : 0
}

function formatTokenCount(value: number): string {
  if (!Number.isFinite(value)) return "0万"

  const formatted = (value / 10_000).toFixed(2).replace(/\.?0+$/, "")
  return `${formatted}万`
}

function tokenSummary(tokens: TokensLike | undefined): string {
  const input = tokenValue(tokens?.input)
  const output = tokenValue(tokens?.output)
  const reasoning = tokenValue(tokens?.reasoning)
  const cacheRead = tokenValue(tokens?.cache?.read)
  const cacheWrite = tokenValue(tokens?.cache?.write)
  // 缓存率 = cache.read / (input + cache.read + cache.write) * 100；output 不计入分母。
  const totalInput = input + cacheRead + cacheWrite
  const cacheRate = totalInput === 0 ? "--" : `${((cacheRead / totalInput) * 100).toFixed(1)}%`

  return `Token：输入 ${formatTokenCount(input)}｜输出 ${formatTokenCount(output)}｜推理 ${formatTokenCount(reasoning)}｜缓存读 ${formatTokenCount(cacheRead)}｜缓存写 ${formatTokenCount(cacheWrite)}｜缓存率 ${cacheRate}`
}

function pathSegment(path: string | undefined): string | undefined {
  const value = stringValue(path)?.replace(/[\\/]+$/, "")
  if (!value) return undefined
  const segment = value.split(/[\\/]/).pop()
  return stringValue(segment)
}

function projectName(location: LocationLike | undefined): string {
  return stringValue(location?.project?.name)
    ?? pathSegment(location?.project?.canonical)
    ?? pathSegment(location?.directory)
    ?? "未知"
}

function projectDirectory(session: SessionLike | undefined, location: LocationLike | undefined): string {
  return stringValue(session?.location?.directory)
    ?? stringValue(location?.directory)
    ?? stringValue(location?.project?.directory)
    ?? "未知"
}

function projectInfoLines(session: SessionLike | undefined, location: LocationLike | undefined): string[] {
  return [
    `项目：${projectName(location)}`,
    `目录：${projectDirectory(session, location)}`,
  ]
}

function outcomeLabel(outcome: Outcome): { result: string; title: string; tag: string; defaultPriority: number } {
  switch (outcome) {
    case "failed":
      return { result: "失败", title: "已失败", tag: "warning", defaultPriority: 4 }
    case "interrupted":
      return { result: "中断", title: "已中断", tag: "information_source", defaultPriority: 4 }
    case "succeeded":
    default:
      return { result: "成功", title: "已完成", tag: "white_check_mark", defaultPriority: 3 }
  }
}

// session.execution.interrupted carries a machine-readable reason
// (user | shutdown | superseded | inactivity); map it for the notification
// body and fall back to the raw value for unknown future reasons.
function interruptReasonLabel(reason: string | undefined): string {
  switch (reason) {
    case "user": return "用户中断"
    case "shutdown": return "宿主关闭"
    case "superseded": return "被新任务取代"
    case "inactivity": return "长时间无活动"
    default: return stringValue(reason) ?? "未知"
  }
}

function toHeaderByteString(value: string): string {
  return Array.from(new TextEncoder().encode(value), (byte) => String.fromCharCode(byte)).join("")
}

// Timeouts are expected operational noise (a stale or wedged host lookup),
// not plugin failures: they reject with this marker so the per-event handler
// can skip the event with a debug log instead of an error line.
class SessionLookupTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`session lookup timed out after ${timeoutMs}ms`)
    this.name = "SessionLookupTimeoutError"
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new SessionLookupTimeoutError(timeoutMs)), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function readSession(ctx: SessionReaderContext, sessionID: string, timeoutMs: number): Promise<SessionLike> {
  // Rejects on lookup failure or timeout, exactly like a direct call, so the
  // per-event error handling below keeps its existing skip semantics.
  return await withTimeout(ctx.session.get({ sessionID }), timeoutMs)
}

async function readSessionMessages(
  ctx: SessionReaderContext,
  sessionID: string,
  timeoutMs: number,
): Promise<ReadonlyArray<MessageLike>> {
  try {
    return await withTimeout(ctx.session.context({ sessionID }), timeoutMs)
  } catch {
    return []
  }
}

function latestIdleMessage(messages: ReadonlyArray<MessageLike>): MessageLike | undefined {
  return [...messages].reverse().find((message) => message.type === "idle")
}

function resolveModel(messages: ReadonlyArray<MessageLike>, sessionModel: ModelLike | undefined): string {
  const assistantModel = [...messages]
    .reverse()
    .find((message) => message.type === "assistant" && message.model)?.model
  const model = assistantModel ?? sessionModel
  return model
    ? `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`
    : "未知模型"
}

async function sendNotification(
  config: Config,
  title: string,
  tag: string,
  priority: number,
  body: string,
  log: DebugLogger,
): Promise<void> {
  if (!config.topic) return

  try {
    const server = config.server.replace(/\/+$/, "")
    const headers = new Headers()
    // Fetch's Headers uses ByteString; preserve UTF-8 bytes for ntfy's Title header.
    headers.set("Title", toHeaderByteString(title))
    headers.set("Tags", toHeaderByteString(tag))
    headers.set("Priority", String(priority))
    headers.set("Content-Type", "text/plain; charset=utf-8")
    if (config.token) headers.set("Authorization", toHeaderByteString(`Bearer ${config.token}`))

    const response = await fetch(`${server}/${config.topic}`, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`ntfy returned HTTP ${response.status}`)
  } catch (error) {
    // A failing ntfy endpoint is operational noise, not a plugin defect:
    // it must never surface as an error line (a down server would otherwise
    // print one line per notification and flood the host log) and must never
    // break the caller. Debug-only, with enough detail to diagnose.
    log(`send.failed topic=${config.topic} error=${String(error)}`)
  }
}

export default Plugin.define({
  id: "ntfy",
  setup(ctx) {
    // The debug flag itself can come from the external config file, but the
    // file reader needs a logger first. Bootstrap diagnostics are buffered
    // and replayed through the final logger once the fully layered config
    // (options > env > file > default) is known — so a file-provided
    // debug=true still shows config loading, while debug=false everywhere
    // discards the buffer and the plugin stays completely silent.
    const bootstrap = createBootstrapLogger()
    const config = readConfig(ctx.options, bootstrap.log)
    const debugLog = createDebugLogger(config.debug)
    bootstrap.log("setup")
    if (!config.topic) {
      // Diagnostic only: without a topic nothing is ever sent, and with
      // debug=false the plugin must not print anything at all.
      bootstrap.log("setup.no-topic: notifications disabled (set options.topic or NTFY_TOPIC)")
    }
    bootstrap.replay(debugLog)
    const location = ctx.location as unknown as LocationLike | undefined
    const sessionTimeoutMs = config.sessionTimeoutMs

    // Per-session execution-round state (lifecycle dedup, replaces the old
    // sessionID-keyed notified sets): the identity of the started event
    // that opened the current round plus whether this round already
    // produced a terminal notification. Bounded exactly like the other
    // dedup stores; evicting a session merely makes its next round look
    // unopened (one extra notification at worst), never a cross-session
    // leak. Permission/form/retry dedup stays event-shaped and separate.
    const executionRounds = createBoundedRoundMap()
    const permissionNotified = createBoundedKeySet()
    const permissionKeyNotified = createBoundedKeySet()
    // Tool-call-precise permission dedup: tool keys already notified, plus
    // the request → tool-call mapping that permission.replied cleans up.
    const permissionToolNotified = createBoundedKeySet()
    const permissionRequestTools = createBoundedKeyMap()
    const formNotified = createBoundedKeySet()
    const retryNotified = createBoundedKeySet()
    const controller = new AbortController()

    const projectMatches = (session: { projectID?: string }): boolean => {
      const projectID = location?.project?.id
      if (session.projectID != null && projectID != null && session.projectID !== projectID) {
        debugLog(`skip(project mismatch) session=${session.projectID} plugin=${projectID}`)
        return false
      }
      return true
    }

    const sessionKind = (session: { parentID?: string }): string => session.parentID ? "子任务" : "主任务"

    const sessionEnabled = (session: { parentID?: string }): boolean =>
      session.parentID ? config.notifyChildren : config.notifyRoot

    const notifyCompletion = async (
      sessionID: string,
      session: SessionLike,
      messages: ReadonlyArray<MessageLike>,
      outcome: Outcome,
    ): Promise<void> => {
      const labels = outcomeLabel(outcome)
      const kind = sessionKind(session)
      const sessionTitle = session.title?.trim() || `未命名会话 ${sessionID.slice(-8)}`
      const title = `[opencode] ${kind}·${labels.title}`
      const body = [
        `标题：${sessionTitle}`,
        `类型：${kind}`,
        ...projectInfoLines(session, location),
        `模型：${resolveModel(messages, session.model)}`,
        `结果：${labels.result}`,
        `执行时长：${formatDuration(session.time.created, session.time.idle)}`,
        tokenSummary(session.tokens),
        `会话 ID：${sessionID}`,
      ].join("\n")

      await sendNotification(config, title, config.tag ?? labels.tag, config.priority ?? labels.defaultPriority, body, debugLog)
    }

    const sleepBeforeReconnect = (ms: number): Promise<void> =>
      new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        const onAbort = () => {
          if (timer !== undefined) clearTimeout(timer)
          resolve()
        }
        if (controller.signal.aborted) {
          resolve()
          return
        }
        timer = setTimeout(() => {
          controller.signal.removeEventListener("abort", onAbort)
          resolve()
        }, ms)
        controller.signal.addEventListener("abort", onAbort, { once: true })
      })

    // Events are consumed from a single live subscription. When the host
    // transport drops and we reconnect below, events emitted during the gap
    // are NOT replayed: the host exposes no catch-up/replay API, and inventing
    // one (polling session state on reconnect) would risk duplicate or stale
    // notifications plus extra host IO. Dedup sets therefore only suppress
    // duplicates of events we actually received — the same "no backfill"
    // contract as a fresh plugin start (see README).
    const subscribeOnce = async (): Promise<void> => {
      debugLog("subscribe.start")
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          try {
            // Backpressure: drop events that cannot produce a notification
            // before any logging or session IO touches the host.
            if (!NOTIFIED_EVENT_TYPES.has(event.type)) continue
            debugLog(`event.type=${event.type}`)
            if (event.type === "session.idle") {
              // Entry gate, before any IO or state: notifyIdle=false means
              // session.idle never notifies (execution.* events still do).
              if (!config.notifyIdle) continue
              const sessionID = event.data.sessionID
              // Lifecycle dedup: the round's terminal flag merges this idle
              // with the round's execution completion (either order) and
              // suppresses re-deliveries, while a newer started event has
              // already reopened the round for the next task.
              const round = executionRounds.ensure(sessionID)
              if (round.terminalNotified) continue

              const session = await readSession(ctx, sessionID, sessionTimeoutMs)
              if (!projectMatches(session)) continue

              const messages = await readSessionMessages(ctx, sessionID, sessionTimeoutMs)
              const idleMessage = latestIdleMessage(messages)
              const isFailed = (session.outcome ?? idleMessage?.outcome) === "failed"
              const outcome = session.outcome ?? idleMessage?.outcome ?? "succeeded"
              // An idle notification is the INTERSECTION of notifyIdle and
              // the outcome switch; either one off skips the event without
              // consuming the round's terminal flag.
              if (isFailed) {
                if (!config.notifyFailed) continue
              } else if (outcome === "interrupted") {
                if (!config.notifyInterrupted) continue
              } else if (outcome === "succeeded") {
                if (!config.notifySucceeded) continue
              }
              if (!sessionEnabled(session)) continue
              // Only a notification that is actually sent consumes the
              // round's terminal state — never a skipped one.
              round.terminalNotified = true

              await notifyCompletion(sessionID, session, messages, outcome)
              continue
            }

            if (event.type === "session.execution.succeeded") {
              const sessionID = event.data.sessionID
              const round = executionRounds.ensure(sessionID)
              if (round.terminalNotified) continue
              if (!config.notifySucceeded) continue

              const session = await readSession(ctx, sessionID, sessionTimeoutMs)
              if (!projectMatches(session) || !sessionEnabled(session)) continue
              const messages = await readSessionMessages(ctx, sessionID, sessionTimeoutMs)
              round.terminalNotified = true
              await notifyCompletion(sessionID, session, messages, "succeeded")
              continue
            }

            if (event.type === "session.execution.started") {
              const sessionID = event.data.sessionID
              // Lifecycle bookkeeping runs regardless of notifyStarted: the
              // round identity is what lets the NEXT execution of the same
              // session notify again, and a re-delivered started event
              // (same durable identity) must never reopen a round whose
              // terminal was already notified. This deliberately sits
              // before the notifyStarted gate.
              const round = executionRounds.ensure(sessionID)
              const key = executionEventKey(event)
              const isNewRound = key !== undefined && round.startedKey !== key
              if (!isNewRound) continue
              round.startedKey = key
              round.terminalNotified = false
              if (!config.notifyStarted) continue

              const session = await readSession(ctx, sessionID, sessionTimeoutMs)
              if (!projectMatches(session) || !sessionEnabled(session)) continue
              const messages = await readSessionMessages(ctx, sessionID, sessionTimeoutMs)
              const kind = sessionKind(session)
              const sessionTitle = session.title?.trim() || `未命名会话 ${sessionID.slice(-8)}`
              const body = [
                `标题：${sessionTitle}`,
                `类型：${kind}`,
                ...projectInfoLines(session, location),
                `模型：${resolveModel(messages, session.model)}`,
                `会话 ID：${sessionID}`,
              ].join("\n")
              await sendNotification(config, `[opencode] ${kind}·开始`, "arrow_forward", 2, body, debugLog)
              continue
            }

            if (event.type === "session.execution.failed") {
              const sessionID = event.data.sessionID
              const round = executionRounds.ensure(sessionID)
              if (round.terminalNotified) continue
              if (!config.notifyFailed) continue
              const session = await readSession(ctx, sessionID, sessionTimeoutMs)
              if (!projectMatches(session) || !sessionEnabled(session)) continue
              const messages = await readSessionMessages(ctx, sessionID, sessionTimeoutMs)
              round.terminalNotified = true
              const kind = sessionKind(session)
              const sessionTitle = session.title?.trim() || `未命名会话 ${sessionID.slice(-8)}`
              const body = [
                `标题：${sessionTitle}`,
                `类型：${kind}`,
                ...projectInfoLines(session, location),
                "结果：失败",
                `错误：${event.data.error.message}`,
                `模型：${resolveModel(messages, session.model)}`,
                `执行时长：${formatDuration(session.time.created, session.time.idle)}`,
                tokenSummary(session.tokens),
                `会话 ID：${sessionID}`,
              ].join("\n")
              await sendNotification(config, `[opencode] ${kind}·执行失败`, "x", 5, body, debugLog)
              continue
            }

            if (event.type === "session.execution.interrupted") {
              // The protocol's explicit interruption signal
              // ({sessionID, reason: user|shutdown|superseded|inactivity}).
              // It is an execution event like succeeded/failed, so it is
              // gated by notifyInterrupted alone — NOT by notifyIdle — and
              // merges with an idle interruption of the same round through
              // the shared terminal flag.
              const sessionID = event.data.sessionID
              const round = executionRounds.ensure(sessionID)
              if (round.terminalNotified) continue
              if (!config.notifyInterrupted) continue
              const session = await readSession(ctx, sessionID, sessionTimeoutMs)
              if (!projectMatches(session) || !sessionEnabled(session)) continue
              const messages = await readSessionMessages(ctx, sessionID, sessionTimeoutMs)
              round.terminalNotified = true
              const kind = sessionKind(session)
              const sessionTitle = session.title?.trim() || `未命名会话 ${sessionID.slice(-8)}`
              const body = [
                `标题：${sessionTitle}`,
                `类型：${kind}`,
                ...projectInfoLines(session, location),
                "结果：中断",
                `原因：${interruptReasonLabel(event.data.reason)}`,
                `模型：${resolveModel(messages, session.model)}`,
                `执行时长：${formatDuration(session.time.created, session.time.idle)}`,
                tokenSummary(session.tokens),
                `会话 ID：${sessionID}`,
              ].join("\n")
              await sendNotification(config, `[opencode] ${kind}·已中断`, "information_source", 4, body, debugLog)
              continue
            }

            if (event.type === "permission.asked") {
              const permission = event.data
              const resources = permission.resources ?? []
              // Dual-identity dedup: permission.id names one request
              // instance, while the tool call (session + source.messageID +
              // source.id) names the tool that raised it. The host may
              // re-ask the SAME tool call with a fresh permission.id, so
              // whenever a source is present the notification is keyed on
              // the tool call: re-delivery of that tool call notifies once,
              // while a genuinely different tool call notifies even when
              // action + resources match exactly — the old content key
              // (session + action + resources) silently killed those.
              // Source-less asks keep the previous semantics: exact request
              // id, else the content key (order-insensitive).
              const idMarker = stringValue(permission.id)
              const toolKey = permissionToolKey(permission.sessionID, permission.source)
              const permissionKey = `${permission.sessionID}:${permission.action}:${[...resources].sort().join(",")}`
              if (!config.notifyPermission) continue
              if (toolKey !== undefined) {
                if (permissionToolNotified.has(toolKey)) continue
              } else if ((idMarker !== undefined && permissionNotified.has(idMarker))
                || permissionKeyNotified.has(permissionKey)) {
                continue
              }
              let session: SessionLike | undefined
              try {
                session = await readSession(ctx, permission.sessionID, sessionTimeoutMs)
              } catch {
                session = undefined
              }
              if (session && (!projectMatches(session) || !sessionEnabled(session))) continue
              const messages = session ? await readSessionMessages(ctx, permission.sessionID, sessionTimeoutMs) : []
              if (idMarker !== undefined) {
                permissionNotified.add(idMarker)
                // Request → tool-call bookkeeping; dropped when the host
                // reports the reply (see permission.replied below).
                permissionRequestTools.set(idMarker, toolKey)
              }
              if (toolKey !== undefined) {
                permissionToolNotified.add(toolKey)
                debugLog(`permission.notified tool=${toolKey} request=${idMarker ?? "-"}`)
              } else {
                // Never record the content key for a tool-identified ask: it
                // would suppress the next genuine request with the same
                // action + resources.
                permissionKeyNotified.add(permissionKey)
                debugLog(`permission.notified semantic request=${idMarker ?? "-"}`)
              }
              const kind = session ? sessionKind(session) : "主任务"
              const sessionTitle = session?.title?.trim() || `未命名会话 ${permission.sessionID.slice(-8)}`
              const details = [
                `权限：${permission.action}`,
                `资源：${resources.join(", ") || "未指定"}`,
                permission.message ? `说明：${permission.message}` : undefined,
                permission.save?.length ? `保存：${permission.save.join(", ")}` : undefined,
                permission.source ? `来源：${permission.source.type}${permission.source.id ? ` ${permission.source.id}` : ""}${permission.source.messageID ? `（消息 ${permission.source.messageID}）` : ""}` : undefined,
              ].filter((line): line is string => line !== undefined)
              const body = [
                `标题：${sessionTitle}`,
                `类型：${kind}`,
                ...projectInfoLines(session, location),
                ...details,
                `模型：${resolveModel(messages, session?.model)}`,
                `会话 ID：${permission.sessionID}`,
              ].join("\n")
              await sendNotification(config, `[opencode] ${kind}·需要授权`, "rotating_light", 5, body, debugLog)
              continue
            }

            if (event.type === "permission.replied") {
              // Bookkeeping only — a reply never produces a notification.
              // Dropping the request → tool-call mapping keeps that table
              // flat; the tool-call notification record is deliberately
              // kept, so aftermath re-asks of the same tool call stay
              // suppressed even after the user has answered.
              try {
                const requestID = stringValue(event.data.requestID)
                if (requestID !== undefined && permissionRequestTools.delete(requestID)) {
                  debugLog(`permission.replied cleared request=${requestID}`)
                }
              } catch {
                // Diagnostics and bookkeeping must never affect plugin behavior.
              }
              continue
            }

            if (event.type === "form.created") {
              // Independent switch: with notifyForm=false a form must not
              // send, and must not even consume a dedup slot (so the
              // switch stays the only gate, before any session IO).
              if (!config.notifyForm) continue
              // Keep the generated event union's narrowing intact; the local
              // plugin shape describes the runtime form.created payload.
              const formEvent = event as unknown as FormCreatedEventLike
              // OpenCode 2.0.16 publishes { form: {...} }; tolerate the
              // flattened shape as well so either build notifies correctly.
              const container = (formEvent.data as { form?: FormEventLike }).form
              const form: FormEventLike = container ?? (formEvent.data as FormEventLike) ?? {}
              const sessionID = typeof form?.sessionID === "string" ? form.sessionID : "未知"
              // Dedup on the stable form.id alone: re-delivery of one id
              // notifies once, a different id notifies even when session +
              // title match (the sessionID:title key was only ever the
              // missing-id fallback, see formDedupKey).
              const marker = formDedupKey(form)
              if (formNotified.has(marker)) continue
              let session: SessionLike | undefined
              if (sessionID !== "未知") {
                try {
                  session = await readSession(ctx, sessionID, sessionTimeoutMs)
                } catch {
                  session = undefined
                }
              }
              if (session && (!projectMatches(session) || !sessionEnabled(session))) continue
              const messages = session && sessionID !== "未知" ? await readSessionMessages(ctx, sessionID, sessionTimeoutMs) : []
              formNotified.add(marker)
              const kind = session ? sessionKind(session) : "主任务"
              const questions = Array.isArray(form?.fields)
                ? form.fields
                : Array.isArray(form?.questions) ? form.questions : []
              const questionLines = questions.slice(0, 10).map((question) => {
                const key = typeof question?.key === "string" ? question.key : "未知"
                const title = typeof question?.title === "string" ? question.title : "未命名问题"
                const type = typeof question?.type === "string" ? question.type : ""
                const options = Array.isArray(question?.options) ? question.options : []
                let annotation = ""
                if (type === "boolean") annotation = " (是/否)"
                else if (type === "number" || type === "integer") annotation = " (数字)"
                else if (type === "select" || type === "multiselect" || ((type === "string" || type === "text") && options.length > 0)) {
                  const labels = options.slice(0, 5).map((option: FormOptionLike) => typeof option?.label === "string" ? option.label : "").filter(Boolean)
                  const remainder = options.length > 5 ? ` 等${options.length - 5}项` : ""
                  annotation = ` (${labels.join("、")}${remainder})`
                }
                const description = typeof question?.description === "string" && question.description.length > 0
                  ? `：${question.description}`
                  : ""
                return `- [${key}] ${title}${annotation}${description}`
              })
              if (questions.length > 10) questionLines.push(`等 ${questions.length - 10} 个问题`)
              const title = typeof form?.title === "string" ? form.title : "未命名表单"
              const body = [
                `标题：${title}`,
                `类型：${kind}`,
                ...projectInfoLines(session, location),
                "问题：",
                ...(questionLines.length ? questionLines : ["- 无问题详情"]),
                `模型：${resolveModel(messages, session?.model)}`,
                `会话 ID：${sessionID}`,
              ].join("\n")
              await sendNotification(config, `[opencode] ${kind}·需要回答问题`, "speech_balloon", 5, body, debugLog)
              continue
            }

            if (event.type === "form.replied") {
              // Bookkeeping only — an answer never produces a notification.
              // A form has a single stable identity (form.id) that is both
              // the notification key and the correlation key, so unlike
              // permissions (request id vs tool-call key) there is no
              // request → marker map to maintain: it would duplicate
              // formNotified one-for-one as write-only state. The notified
              // record is deliberately kept, so aftermath re-deliveries of
              // the same form id stay suppressed even after the answer.
              try {
                const formID = stringValue(event.data.id)
                if (formID !== undefined && formNotified.has(formID)) {
                  debugLog(`form.replied cleared form=${formID}`)
                }
              } catch {
                // Diagnostics and bookkeeping must never affect plugin behavior.
              }
              continue
            }

            if (event.type === "form.cancelled") {
              // Same bookkeeping as form.replied: correlate the cancelled
              // form id against the notified record and keep the record.
              try {
                const formID = stringValue(event.data.id)
                if (formID !== undefined && formNotified.has(formID)) {
                  debugLog(`form.cancelled cleared form=${formID}`)
                }
              } catch {
                // Diagnostics and bookkeeping must never affect plugin behavior.
              }
              continue
            }

            if (event.type === "session.retry.scheduled") {
              const retry = event.data
              const marker = event.id || `${retry.sessionID}:${retry.attempt}`
              if (!config.notifyRetry || retryNotified.has(marker)) continue
              const session = await readSession(ctx, retry.sessionID, sessionTimeoutMs)
              if (!projectMatches(session) || !sessionEnabled(session)) continue
              const messages = await readSessionMessages(ctx, retry.sessionID, sessionTimeoutMs)
              retryNotified.add(marker)
              const kind = sessionKind(session)
              const sessionTitle = session.title?.trim() || `未命名会话 ${retry.sessionID.slice(-8)}`
              const body = [
                `标题：${sessionTitle}`,
                `类型：${kind}`,
                ...projectInfoLines(session, location),
                `第几次：${retry.attempt}`,
                `原因：${retry.error.message}`,
                `模型：${resolveModel(messages, session.model)}`,
                `会话 ID：${retry.sessionID}`,
              ].join("\n")
              await sendNotification(config, `[opencode] ${kind}·即将重试`, "hourglass", 3, body, debugLog)
            }
          } catch (error) {
            if (error instanceof SessionLookupTimeoutError) {
              // Expected: a slow host lookup. Skip this event silently and
              // keep the subscription loop moving; never an error line.
              debugLog(`event skipped: session lookup timed out (type=${event.type})`)
            } else {
              // Unexpected per-event failure (malformed payload, host IO):
              // debug-only, so a host that keeps emitting broken events
              // cannot flood the log. The loop always keeps moving either
              // way — this line is diagnostics, never a behavior change.
              debugLog(`event.failed type=${event.type} error=${String(error)}`)
            }
          }
        }
        debugLog("subscribe.end")
      } catch (error) {
        if (!controller.signal.aborted) {
          // A stopped subscription is retried with backoff by consumeEvents;
          // each retry is debug-level so reconnects never flood host logs.
          debugLog(`subscribe.stopped will reconnect reason=${String(error)}`)
        }
      }
    }

    const consumeEvents = async (): Promise<void> => {
      // Never give up: an unbounded attempt loop with capped backoff keeps the
      // plugin alive through arbitrarily long transport outages.
      for (let attempt = 0; ; attempt += 1) {
        try {
          await subscribeOnce()
        } catch (error) {
          // subscribeOnce already swallows its own failures; this only guards
          // the await machinery itself. Nothing here may reach the host.
          debugLog(`consumer.iteration failed error=${String(error)}`)
        }
        // Cleanup aborted the controller: exit immediately, never reconnect.
        if (controller.signal.aborted) return
        const delay = reconnectDelayMs(attempt)
        debugLog(`subscribe.reconnect attempt=${attempt + 1} delay=${delay}ms`)
        await sleepBeforeReconnect(delay)
        if (controller.signal.aborted) return
      }
    }

    consumeEvents().catch((error) => {
      // Belt and braces: the consumer must never surface as an unhandled
      // rejection, which the host may treat as fatal. It should never get
      // here (consumeEvents cannot throw); if it ever does, the line is
      // debug-only so a latent bug cannot flood the host log either.
      debugLog(`consumer.failed error=${String(error)}`)
    })
    return () => {
      debugLog("cleanup")
      controller.abort()
    }
  },
})
