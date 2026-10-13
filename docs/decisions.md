# OpenCode V2 ntfy 通知插件 — 决策记录

> 记录本插件开发过程中遇到的**决策问题**与**最终决策**，直至任务完成。`决策人` 标注该决策由用户拍板还是由我（代理）在用户不在场时决定并说明理由。文末“完成状态”持续更新。

## 目标
开发一个可在 OpenCode V2 使用的 ntfy 插件：当**主任务（根会话）**或**子任务（子会话）**完成时，向 ntfy 发送通知，包含标题、执行的模型、执行时长；ntfy 地址/topic/tag 等可配置。

## 术语
- 主任务 = 根会话 = `Session.Info` 无 `parentID`。
- 子任务 = 子会话 = 有 `parentID`（典型如 task 工具派生）。
- 完成 = 会话进入空闲，即插件事件 `session.idle`。

---

## 决策清单

### D1 通知范围：主任务 / 子任务
- **决策人**：用户
- **决策**：主任务与子任务完成都发通知；提供 `notifyRoot`、`notifyChildren` 两个独立开关，默认都开。
- **理由**：用户明确“任务或者子任务完成后”都要通知；分类开关避免某类噪音。

### D2 配置来源
- **决策人**：用户
- **决策**：`ctx.options` 优先，环境变量 `NTFY_*` 兜底。
- **理由**：符合 OpenCode 插件 options 规范，同时覆盖无配置对象的场景。

### D3 如何检测“任务/子任务完成”
- **决策人**：我（代理）
- **决策**：监听插件事件 `session.idle`（`data.sessionID`）。
- **理由/过程**：OpenAPI 只暴露 HTTP 事件信封 `{id,event,data}`，未给插件层结构；最终安装并核对 `@opencode/plugin@2.0.16` 类型定义确认事件类型名为 `session.idle`，V2 无 `message.updated`/`session.updated` 作为完成信号。

### D4 时长 / 模型 / 标题 / 主子判定的数据来源
- **决策人**：我（代理）
- **决策**：一律以 `ctx.session.get()` 的 `Session.Info` 为权威来源，不信任事件 payload 的展示数据。
  - 执行时长 = `time.idle - time.created`（epoch ms），缺失显示“未知”。
  - 模型 = `${providerID}/${id}`（有 `variant` 追加 `#variant`）。
  - 主/子 = `Boolean(parentID)`。
- **理由**：事件 payload 可能不完整；会话信息才是最终态。

### D5 去重策略
- **决策人**：我（代理）
- **决策**：优先用 `ctx.session.context()` 中最新的 `type:"idle"` 消息 `id` 作为去重标记；读取失败退化为 `sessionID:time.idle`；再退化为事件 `id`。标记存于进程内 `Set`（重启不持久化）。
- **理由**：同一完成可能被多路事件/重连重复触发；idle 消息 id 是最稳定的“这一次空闲”标识。
- **遗留**：长期运行 Set 缓慢增长，量级可忽略；重启后不记忆历史（README 已注明）。

### D6 是否按项目过滤（避免跨项目噪音）
- **决策人**：我（代理）
- **决策**：**按项目过滤，但防御式**——仅当 `session.projectID` 与 `ctx.location.project?.id` 均存在且不相等时才跳过；任一缺失不过滤。并加 `[ntfy]` 调试日志（收到 idle、跳过原因）便于真机核实。
- **理由**：事件流跨所有 location/项目，插件通常按项目加载，过滤可避免跨项目噪音；但“缺失 id 误伤全部”和“两者非同一 ID 空间”是隐患，故用防御式 + 日志兜底，绝不静默吞掉一切。
- **风险**：若 `projectID` 与 `location.project.id` 非同一 ID 空间，可能全部被过滤——以日志为准，真机核实。

### D7 ntfy 发送规范与默认值
- **决策人**：我（代理）
- **决策**：`POST {server}/{topic}`（`server` 去尾部斜杠）；请求头 `Title`/`Tags`/`Priority`（配 `token` 时加 `Authorization: Bearer`）；正文纯文本多行；8s 超时。
- **默认**：`server=https://ntfy.sh`；`tag` 按结果（成功 `white_check_mark` / 失败 `warning` / 中断 `information_source`）；`priority` 成功 3、失败/中断 4。

### D8 失败处理
- **决策人**：我（代理）
- **决策**：ntfy 请求失败/超时/非 2xx 仅 `console.error`，绝不影响 OpenCode；缺 `topic` 时启动告警并跳过发送（不崩溃）。

### D9 验证方式（用户不在电脑旁、无法真机联调）
- **决策人**：我（代理）
- **决策**：除 `tsc --noEmit` 外，新增一个 mock 自测脚本（`node:assert`，零运行期新依赖），驱动真实 `setup → session.idle → ctx.session.get → fetch`，覆盖：主任务成功发送、`notifyChildren=false` 不发、`failed` 的 tag/priority、缺 `topic` 不发、时长格式化。真机端到端联调留作用户侧步骤。
- **理由**：这是不启动真实 OpenCode+ntfy 也能验证核心逻辑（尤其 D5 去重、D6 过滤、D7 发送构造）的唯一手段，属必要验证而非过度测试。

### D10 任务“完成”的定义
- **决策人**：我（代理）
- **决策**：代码完成 + `tsc` 0 错误 + mock 自测通过 + 文档与决策记录齐全 = **自主部分完成**；真机联调（真实 ntfy + 运行中的 OpenCode 会话，观察手机/订阅端收到通知）为**用户侧验证步骤**，不阻塞交付。

---

### D11 中文 Title 的 HTTP Header 编码（自测暴露的真实 bug）
- **决策人**：我（代理）
- **问题**：Node `fetch` 的 `Headers` 对值按 `ByteString` 校验，中文 `Title`（码点 >255）会直接抛错，导致通知发送失败——真机上中文标题会 100% 发不出去。
- **决策**：发送前用 `toHeaderByteString()`（`TextEncoder` 将字符串编码为 UTF-8 字节、再逐字节映射为 Latin-1 字符）处理 `Title`/`Tags`/`Authorization`，既保留中文标题又让 `Headers.set` 通过，ntfy 侧按 UTF-8 还原。
- **发现过程**：由 D9 的 mock 自测首次运行时暴露并修复，正是“无真机也能验证核心逻辑”的价值体现。

### D12 发送方案真实端到端验证（对 ntfy.sh）
- **决策人**：我（代理）
- **问题**：mock 只能证明“发出了什么”，证明不了 ntfy 服务端收到后能否还原中文 `Title`。D11 的 header 编码基于“undici 按字节写 header、ntfy 按 UTF-8 还原”的假设，必须真机确认。
- **验证方法**：用与插件 `sendNotification` 完全一致的逻辑，向 `ntfy.sh` 三个随机一次性 topic 发送并轮询读回：A=header+中文 Title（复刻 `toHeaderByteString`）、B=JSON body（对照）、C=header+纯 ASCII Title（对照组）。
- **结论**：三者 HTTP 均 200；读回的 `title` 均**完整还原**为 `[opencode] 主任务·已完成`，`tags=[white_check_mark]`、`priority=3` 均正确。**确认插件当前 header+`toHeaderByteString` 方案在真实 ntfy 下中文标题可用，无需改用 JSON。**
- **附带事实**：ntfy 的 JSON 发布必须发到根 `https://ntfy.sh/` 且 body 带 `topic`；发到 `/<topic>` 会被当纯文本正文。
- **备注**：共向 ntfy.sh 随机、无人订阅的 topic 发了 3 条测试通知（一次性、无敏感信息、缓存自动过期）。

### D13 用户真实 topic 联调（opencode-oZ7vgHOxFHMfstgF）
- **决策人**：我（代理，按用户指定地址执行）
- **动作**：用户指定 ntfy 地址 `ntfy.sh/opencode-oZ7vgHOxFHMfstgF` 测试。已：①把该地址固化到 `opencode.jsonc.example`（可直接合入目标项目配置）；②新增 `scripts/livetest.ts`，用**插件真实代码**（`src/index.ts` 的 `setup`+`sendNotification`+`toHeaderByteString`，未 mock fetch）驱动一次“主任务完成”，向该 topic 发出一条中文通知。
- **结果（服务端独立读回确认）**：`title="[opencode] 主任务·已完成"`（中文完整还原）、`tags=["white_check_mark"]`、`priority=3`、正文含模型 `anthropic/claude-sonnet-4-5` 与时长 `1m 23s`。**该真实 topic 的发送链路验证通过。**

### D14 模型来源修正为“执行模型”（assistant 优先）
- **决策人**：我（代理，回应用户“模型错误”反馈）
- **澄清**：用户先看到的 `anthropic/claude-sonnet-4-5` 是 `scripts/livetest.ts` 里 mock 写死的假值（该条标题“ntfy 插件联调测试”、会话 `ses_live0001` 均为模拟数据），并非真实环境读取值。
- **问题**：插件原取**会话级** `session.model`（会话当前模型），在任务中途切换模型/compaction 等场景下未必等于**实际执行的模型**。
- **决策**：模型取**最后一条 `type:"assistant"` 消息的 `model`**（真正生成回复所用，即“执行的模型”）优先；回退会话级 `session.model`；再回退“未知模型”。与 idle 去重复用同一次 `ctx.session.context()`，不额外调用。
- **验证**：selfcheck root success 断言显示 assistant 的 `anthropic/claude-opus-4-1` 且不含会话级 `claude-sonnet-4-5`；新增“assistant 无 model 回退会话级”用例；自测 8/8。真实 topic 重发（assistant=`claude-opus-4-1`、会话级=`openai/gpt-4o-mini` 对照），服务端读回确认显示 `anthropic/claude-opus-4-1`、**非** `gpt-4o-mini`。

### D15 生命周期通知扩展（多事件 + 可配置开关）
- **决策人**：我（代理，应用户“失败/需要做决定等也加通知、可配置打开”）
- **机制说明**：V2 插件有两类扩展方式——(A) **结构化方法钩子**（在 `Plugin.define` 里定义同名方法，如 `session.error`/`tool.execute.before`/`message.updated`）；(B) **事件流订阅** `ctx.event.subscribe()`（本插件采用，粒度最细、可全量订阅）。事件全集来自 `@opencode/client` 的 `V2Event` union（约 100+ type，已在本地类型定义核实）。
- **选取原则**：只对“任务生命周期 + 需人介入”事件做通知；**排除** `text.delta`/`reasoning.delta`/`step.*` 等高频事件（否则刷屏）——这是“都加”的必要取舍。
- **新增事件与开关（options 优先、env 兜底）**：
  - `notifyFailed`（默认开）：`session.execution.failed` 即时失败（tag `x`、priority 5）；与 idle 的 `outcome=failed` 经 `failureNotified:Set` 合并去重，避免双发。
  - `notifyPermission`（默认开）：`permission.asked` 需要授权（tag `rotating_light`、priority 5；正文含 `action/resources/message/save/source`）。
  - `notifyStarted`（默认关）：`session.execution.started`（`arrow_forward`、priority 2）。
  - `notifyRetry`（默认关）：`session.retry.scheduled`（`hourglass`、priority 3）。
  - payload 字段（sessionID 位置、error、permission 详情、唯一 id）已从 `@opencode/schema` 类型核实，未臆造。
- **验证**：selfcheck 13/13（含 execution failed / permission asked / started 开关 / 失败与 idle 去重）；真实 topic 演示 `执行失败`(x,p5) 与 `需要授权`(rotating_light,p5，含权限/资源/执行模型) 均已由插件本体发出并服务端读回确认。
- **排障**：演示中曾因 `livetest` 脚本过早 `cleanup()`（真实 fetch 未返回即 abort）导致 `permission.asked` 未产生——属**测试时序**，已修脚本（非插件缺陷；真实 OpenCode 事件流持续推送，不会这样过早 abort）。

### D16 通知标题 emoji
- **决策人**：用户指定完成 ✅、失败 ❌；其余由我定。
- **决策**：通知 **Title 前缀**加事件 emoji——完成 ✅、失败/执行失败 ❌、中断 ⏸️、需要授权 🚨、任务开始 🚀、即将重试 🔁；ntfy Tags 图标保持不变（双保险）。emoji 走既有 `toHeaderByteString`（UTF-8 ByteString），与中文同样可被 ntfy 还原；映射集中为常量 `EVENT_EMOJI` 维护。
- **验证**：真实 topic 逐类发出并服务端读回，6 种 emoji 标题均正确还原、事件/优先级对应无误；selfcheck 增补“Title 含 emoji”断言，全过。

### D17 npm 发布打包策略
- **决策人**：我（代理，应用户“发布到 npm 给别人用”）
- **策略**：npm 包发**编译后 JS 产物**而非 `.ts` 源码，对齐 OpenCode 自家 `@opencode/plugin` 范式。新增 `tsconfig.build.json`（extends 基线；emit + declaration + outDir dist + rootDir src）；`package.json` 的 `main`/`exports` 指向 `dist/index.js(+.d.ts)`、`files:["dist"]`、加 `build/prepublishOnly/typecheck/selfcheck` 脚本；`@opencode/plugin` 保留在 `dependencies`（保证终端用户装即可解析，优于 peerDependencies 的解析坑）。有利条件：单文件 + 仅 bare import，编译无“相对路径扩展名”问题。
- **发布物验证**：`npm run build` 产出 `dist/index.js`+`index.d.ts`；**dist 冒烟**（`scripts/smoke-dist.ts` 直接 import dist、mock fetch 驱动 session.idle）确认默认导出 `{id:"ntfy", setup}` 且发送行为一致；typecheck 0 错、selfcheck 13/13；`npm pack --dry-run` 仅含 `LICENSE/README.md/dist/*/package.json`（5 个文件），不含源码/脚本/docs/node_modules。
- **待用户**：替换 `author`/`repository`/LICENSE 版权占位符；确认包名唯一（建议 `opencode-ntfy-plugin` 或 `@scope/...`）；自行 `npm login` + `npm publish --access public`（不擅自 publish）。别人用：`opencode plugin add <pkg>` 或 `plugins:["<pkg>"]` + options/env 配 topic。

### D18 本地加载必须用 file://（Windows 盘符路径不可用）
- **决策人**：我（代理）
- **问题**：对象形式 `{package:"D:/projects/mine/ntfy/src/index.ts", options}` 本地加载，OpenCode 报“尚未报告/可能仍在安装”。`package` 在 schema 仅是 String（不校验格式），问题在运行时路径解析。
- **根因（Node 实测）**：`import('D:/...')` 抛 `...On Windows, absolute paths must be valid file:// URLs. Received protocol 'd:'`；`file:///D:/.../src/index.ts` 正常 import（`id=ntfy`）。Windows 盘符路径不是合法 ESM 路径。已更新 `opencode.jsonc.example` 与 README。

### D19 本地加载绕开 npm：`.opencode/plugins/` 自动加载 + 一行桥接
- **决策人**：我（代理，应用户“改 file:// 后仍‘未加载’+‘无法连接到 npm 注册表’”）
- **根因**：对象形式 `{package, options}` 指向本地单文件/绝对路径（含 `file:///...src/index.ts`）时，OpenCode 会把它当 **npm 包**安装/校验 → 连不上 registry → “未加载”。
- **方案（实测 `BRIDGE_OK`）**：改用 `.opencode/plugins/` 本地自动加载——在目标项目放一行桥接 `<项目>/.opencode/plugins/ntfy/index.ts`：`export { default } from "file:///D:/projects/mine/ntfy/src/index.ts"`；**不**在 `plugins` 数组登记它；用 `NTFY_*` 环境变量配置。桥接 re-export 到本插件源码，`@opencode/plugin` 从本目录 `node_modules` 解析 → **目标项目零依赖、完全不经 npm**。
- **备选**：要对象 options 时用**相对目录对象形式** `{package:"./.opencode/plugins/ntfy", options}`；若仍触发 npm 则回退“自动加载 + 环境变量”。README 已加「方式四 / 排错」小节。

### D20 表单去重改为按稳定 form.id + replied/cancelled 簿记
- **决策人**：我（代理）
- **背景**：上一轮授权去重完成"双身份"改造（按工具调用精确去重 + `permission.replied` 清理映射 + 白名单）。表单侧原有去重键为 `form.id → 事件信封 id → 会话:标题`，其中"会话:标题"回退键会把同会话同标题的**不同**表单误杀（同一会话先后弹出两个同名表单时第二个被吞）。
- **决策**：
  - `form.created` 以 `form.id`（`frm_` 前缀稳定 ID）为**唯一**去重依据：同 id 重发只通知一次；不同 id（含同标题）一律视为新表单正常通知。仅当 form.id 缺失/非字符串/空白时才回退"会话 + 标题"旧逻辑（封装为导出纯函数 `formDedupKey`，与 `permissionToolKey` 对称，便于单测）。
  - `form.replied` / `form.cancelled` 加入事件白名单 `NOTIFIED_EVENT_TYPES`，但**只做簿记**：按 `data.id` 关联已通知记录，输出 debug `form.replied cleared form=...` / `form.cancelled cleared form=...`（与 permission 侧命名对称），本身不发通知。
  - 已通知记录（`formNotified`）**保留**不删，挡住用户回答/取消后宿主重复推送同一表单的余波；条目上限 20 与其余去重集合一致，超限只丢最老键。
- **不建映射表的理由**：表单协议只有单一稳定身份（form.id 同时是去重键和关联键）；permission 需要 request→tool 映射是因为它有两个身份（请求 id vs 工具调用键）。表单侧再建映射表只是 `formNotified` 的一比一副本、只写不读，故不引入（任务书亦许可"没有映射表，但要有理由"）。
- **哨兵容错**：MCP elicitation 场景 `sessionID` 可能是 `"global"` 哨兵而非真实会话；会话查询沿用既有 try/catch 容错（查不到按"主任务 + 未知目录"照常通知，`会话 ID：global` 原样展示），不因哨兵引入新抛错。通知文案与其他事件逻辑不变。
- **验证**：selfcheck 新增——`formDedupKey` 单测（同 id 同键 / 同标题不同 id 不同键 / 缺失与空白 id 回退）；集成用例：(a) 同 form.id 重发 created 只通知一次；(b) 同会话同标题不同 form.id 各通知一次；(c) replied / cancelled 本身不通知、有 `[ntfy-debug] ... cleared form=...` 可观测证据、无 process error、之后同 id 余波仍被挡。`typecheck` / `build` / `selfcheck` 全过。

## 完成状态
- [x] 代码实现（`src/index.ts`、`package.json`、`tsconfig.json`）
- [x] `npx tsc --noEmit` 0 错误
- [x] README 文档（事件开关 + 标题 emoji + file:// 说明 + 方式四/排错 + 发布章节）
- [x] 决策记录（本文件，D1–D19）
- [x] 防御式项目过滤 + 调试日志（D6）
- [x] mock 自测：13/13（执行模型、回退、去重、项目过滤、多事件开关）
- [x] 真实 ntfy.sh 端到端验证（D12）
- [x] 用户真实 topic 联调（D13/D14/D15）：完成 / 执行失败 / 需要授权 均已本体发出并读回确认
- [ ] 在真实 OpenCode 项目触发事件并由你订阅端确认（D10）：唯一需本人在场的交互步骤——合入 `opencode.jsonc.example` 后跑会话即可
