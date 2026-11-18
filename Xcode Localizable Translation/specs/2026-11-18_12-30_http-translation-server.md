# Spec: HTTP Translation Server

## Goal
- 要解决什么问题：当前只能在脚本页面内「从剪贴板粘贴 → 翻译 → 复制/导出」，其他设备或工具（Mac 终端、Shortcuts、Safari 扩展、其他 Scripting 脚本）无法复用本机已配置的 AI Provider 做翻译。需要在本机起一个局域网 HTTP 服务，把翻译能力暴露成稳定 API。
- 验收结果：脚本页面内可一键启动/停止 HTTP 服务；同一 Wi-Fi 下的设备直接调用 `POST /v1/translate`（纯文本）和 `POST /v1/xcstrings`（整份文件）拿到翻译结果；服务状态、地址、最近请求在页面可见；服务运行期间通过 BackgroundKeeper 保活，App 退到后台仍尽力保持响应；关闭页面或手动停止即释放端口。

## Done Contract
- 什么算完成：两个翻译端点 + health/languages + CORS + 异步 job 可用；UI 能启动/停止、展示地址与请求日志，并在服务运行期间持有保活；README 有 curl/Shortcuts 示例；`get_typescript_diagnostics` 为 0。
- 由什么证明：本机 `curl` 实测 200/400/202/429 等响应 + 一份小型 xcstrings 往返结果对比 + App 切后台后再次请求成功的实测 + 实机页面截图 + 用户确认。
- 哪些情况仍算未完成：服务只能在模拟器跑、局域网设备连不上、整份 xcstrings 结果损坏（丢 key / 覆盖已有译文 / JSON 不合法）、退出页面后端口未释放。

## Scope
- In：
  - 抽出与 UI 解耦的翻译服务层，UI 与 HTTP 共用同一套批处理/节流/取消逻辑。
  - 新增 `server/` 模块：HTTP 路由、CORS、请求日志、任务队列、异步 job 注册表。
  - Headless 模式：`index.tsx` 按 query parameter 进入 `server/standalone.tsx`，不打开页面；启动前用 `/v1/health` 探测是否已运行；`Script.onResume` 恢复状态页、重启或停止；新增 `/v1/shutdown`。
  - `POST /v1/translate`（纯文本，多目标语言，按索引对齐返回）。
  - `POST /v1/xcstrings`（整份 Localizable.xcstrings，同步返回；可选 `?async=1` 异步 job）。
  - `GET /v1/health`、`GET /v1/languages`、`GET /v1/jobs`、`GET /v1/jobs/:id`、`GET /v1/jobs/:id/result`、`DELETE /v1/jobs/:id`、`POST /v1/shutdown`。
  - 后台保活：抽出引用计数式 keep-alive 模块，服务运行期间持有 `BackgroundKeeper` 与可选常亮，不干扰 UI 翻译自身的保活申请。
  - 页面新增「HTTP 服务」区：启停、端口、地址复制、保活/常亮开关、最近请求列表、无鉴权风险提示。
  - 设置持久化新增 serverPort / autoStartServer / serverKeepAlive / serverKeepScreenOn；i18n 中英补齐；README 增加 API 文档与示例。
  - 翻译质量优化：去重翻译、按索引回填、纯文本/脚本文案两套 prompt profile、可选 context 词汇表。
- Out（本轮不做）：
  - HTTPS（P12）与公网暴露；Bonjour/mDNS 自动发现；WebSocket 推送进度。
  - 账号体系、多用户配额、持久化 job 历史（重启即清空）。
  - 从文件系统直接选 xcstrings（仍以 HTTP body / 剪贴板为主）。
  - 替换 Assistant Provider 体系。

## Facts / Constraints
- 已确认 API：
  - `HttpServer`：`registerAsyncHandler(path, handler)`、`registerMiddleware`、`setNotFoundHandler`、`start({port, forceIPv4, maxRequestBodySize, tls?})`、`stop()`；`state`、`port`、`isIPv4`。
  - **同一 path 只能注册一个 handler，method 必须在 handler 内自行分发**（已实测：GET/DELETE 分开注册会互相覆盖）。
  - `HttpRequest`：`method`、`path`、`target`、`headers`、`body: Data`（`toRawString("utf-8")`）、`params`、`queryParams`、`address`。
  - `HttpResponse`：`ok/badRequest/notFound/tooManyRequests/internalServerError`、`raw(status, phrase, {headers, body})`；`HttpResponseBody.text/data`。
  - `Device.networkInterfaces()` 返回 `{ [ifname]: { address, netmask, family, mac, isInternal, cidr }[] }`，可筛出 IPv4 局域网地址。
  - `BackgroundKeeper.keepAlive()` / `Device.setWakeLockEnabled()` 已用于现有翻译流程。
  - `Script.run({ name, queryParameters })` 启动新实例并等待目标 `Script.exit()`；headless 服务成功后不 exit，所以调用方**不要 await**启动调用。
  - `Script.onResume(details)` 在存活实例上接收 `scripting://run/...` 的 queryParameters；headless 模式用它在恢复时呈现状态页、重启服务或处理 `action=stop`。
  - 最小化：`Script.supportsMinimization()`、`Script.minimize()`、`Script.enableMinimize()`；全屏/overFullScreen 可用 `Navigation.present({ swipeBackBehavior: "minimize" })`。最小化不终止脚本实例，`present` promise 保持 pending；仅第一个 presented page 可最小化；多窗口模式会忽略最小化。
- 约束：
  - HTTP 服务只在脚本进程存活期间有效。页面关闭 / 脚本退出即 `stop()`；iOS 仍可能在长时间后台时挂起或终止 App，保活只能降低概率。
  - 按 2026-11-18 用户决定：服务不做鉴权、无 TLS，仅限可信局域网；同网段任何设备都可消耗 AI 额度，README 与 UI 必须显著提示「不要做公网端口映射」。
  - `BackgroundKeeper.keepAlive()` 可降低 App 被挂起的概率，但不保证进程永不被系统终止；保活必须在 App 前台申请，后台只能尽力维持。
  - UI 翻译与服务可能同时申请保活，必须用引用计数管理，避免一方 `stopKeepAlive()` 误释放另一方资源。
  - AI 请求有速率限制，HTTP 并发任务不能绕过节流；全局同一时间只跑一个翻译 job，内部再按 settings 的并发/间隔分批。
  - `Assistant.requestStructuredData` 失败会重试；HTTP 层必须把失败转成明确 JSON 错误，而不是 500 空响应。
- 已知风险：
  - iOS 本地网络隐私策略可能影响局域网访问（需实机验证；预期入站监听不弹窗，出站/发现才需要权限）。
  - 大文件同步请求可能超过客户端超时（Shortcuts/URLSession 默认约 60s），因此提供异步 job 模式。
  - 同一端口可能被占用；启动失败要回显系统错误并允许改端口。
  - 长文本/大 batch 可能触发模型输出截断；沿用长度校验 + 重试，后续可加自适应拆批。
  - 异步 job 的结果驻留内存（最多 20 个，30 分钟 TTL）；大文件 × 多语言可能带来明显内存压力，需在实现时限制单结果大小。

## Restated Understanding
- 我理解当前任务是：在保留现有页面翻译体验的前提下，把翻译内核抽成可复用服务，并加一个本机 HTTP Server，让同一局域网内的其他工具能提交文本或整份 xcstrings 并取回译文。
- 当前核心目标是：定稿 HTTP 契约、模块边界、安全与生命周期策略，并已完成获批实现与验证。
- 当前边界是：沿用 `Assistant.requestStructuredData`、现有 Provider 配置与 `xcstrings_util` 的合并规则；服务只在本机进程内存中运行。
- 暂不处理：公网部署、HTTPS、多用户、持久化任务、自动发现。

## Goal Alignment Check
- 当前动作是否仍服务于核心目标：是，已实现 HTTP 服务并完成本机验证。
- 若否，偏差在哪里：无。
- 是否需要调整本轮目标或范围：已按用户选择定稿（见 Decisions），无需再调整。

## Architecture

### 模块划分
```
index.tsx                     入口：present 页面 + 退出 cleanup（停 server / 停保活 / 关常亮）
components/TranslationApp.tsx 主页面；新增 HTTP Server 区
components/ServerPanel.tsx    服务面板（状态、地址、端口、保活、请求日志）
engine/translation_service.ts 无 UI 依赖的翻译服务：文本 / xcstrings、去重、批处理、取消
engine/job_queue.ts           全局 FIFO 队列（同一时间一个翻译 job）+ job 状态
engine/keep_alive.ts          保活/常亮引用计数，UI 翻译与服务共用
engine/runner.ts              保留，改为调用 service 的批次执行器（UI 进度回调不变）
server/http_server.ts         HttpServer 路由、CORS、异常映射、请求日志、shutdown（不做鉴权）
server/standalone.tsx         Headless 模式：已启动探测、启动、onResume、状态页
server/client.ts              localhost 健康探测与 shutdown 请求
server/routes.ts              端点实现（解析/校验/响应）
server/job_registry.ts        异步 job：状态、进度、结果、取消、TTL 清理
store.ts                      新增 serverPort / autoStartServer / serverKeepAlive / serverKeepScreenOn
translate.ts                  改为「一批文本 → 对齐数组」，新增 prompt profile
i18n.ts / languages.ts        文案与语言别名
README.md                     HTTP API 文档 + curl / Shortcuts / fetch 示例
```

### 分层原则
- `server/` 只做 HTTP 协议层：解析、校验、状态码、日志；不直接拼 prompt。
- `engine/translation_service.ts` 是唯一翻译入口，UI 和 HTTP 都调用它，避免两套节流/重试逻辑漂移。
- `translate.ts` 保持「单次模型请求」职责；重试、去重、分批、取消由 service 负责。

### 全局任务模型
- 单例 `translationQueue`：FIFO，最多 8 个等待任务；同一时间只执行 1 个 job。
- 每个 job 内部使用新的 `SchedulerController`，按 `concurrency` 与 `intervalMs` 调度批次。
- UI 的「开始翻译」也进入同一队列：若 HTTP job 正在跑，UI 日志提示「排队中」，避免两个 Assistant 负载互相抢限流。
- 队列满 → HTTP `429` + `Retry-After: 5`；UI 开始按钮禁用并提示。
- job 状态：`queued | running | completed | partial | failed | cancelled`。

### HTTP 服务生命周期
- 页面挂载时读取设置；`autoStartServer` 为真则自动 `start()`。
- 启动：`new HttpServer()` → 注册路由 → `start({ port, forceIPv4: true, maxRequestBodySize: 20 * 1024 * 1024 })`。
- 启动成功：记录 `port`、从 `Device.networkInterfaces()` 计算 `http://<IPv4>:<port>` 列表（跳过 loopback / internal）。
- 保活：服务启动后，若 `serverKeepAlive` 开启，通过 `keep_alive.acquire("server")` 申请 `BackgroundKeeper.keepAlive()`；若 `serverKeepScreenOn` 开启则 `Device.setWakeLockEnabled(true)`。UI 翻译使用同一个引用计数模块（`acquire("ui")` / `release("ui")`），任一方停止不会误释放另一方。
- 停止：`server.stop()`、清理 job（取消 running/queued）、`release("server")`、关闭常亮（仅当无其他持有者）。
- 页面切后台不主动停止服务；App 被系统挂起/终止时服务随之不可用，恢复到前台后无需重启（同一进程内 HttpServer 仍监听）。
- 页面卸载 / `index.tsx` 的 `finally` 兜底 `stop()`。
- 端口默认 `7777`，允许 1024–65535；`0` 仅内部测试用（随机端口并回显）。

### 安全模型（2026-11-18 决定：不做鉴权）
- 不校验 token，所有端点公开；同网段任何设备都可调用并消耗 Provider 额度。UI 与 README 必须明确提示，不做公网端口映射。
- 通过非鉴权手段降低误用：请求体上限 20MB；队列上限 8；`/v1/translate` 限制 500 条 / 100k 字符；单 job 串行执行。
- `Content-Type` 非 JSON（xcstrings 端点允许 `application/json` / `text/plain`）→ `415`。
- 错误统一结构：`{ ok: false, error: { code, message, details? } }`；不把 provider key、堆栈返回给客户端。
- 页面请求日志记录时间、方法、路径、状态码、耗时、客户端 IP，便于发现异常调用。
- 不做 IP 白名单（局域网 IP 会变）；不提供公网/HTTPS 能力。
- 预留：后续如需鉴权，可在 middleware 增加可选 token，不改变现有业务契约。

### CORS
- 支持浏览器 / Safari 扩展调用：所有响应带
  - `Access-Control-Allow-Origin: *`
  - `Access-Control-Allow-Methods: GET,POST,DELETE,OPTIONS`
  - `Access-Control-Allow-Headers: Content-Type,X-Target-Locales`
  - `Access-Control-Max-Age: 86400`
- 任意路径 `OPTIONS` → `204`（由 `setNotFoundHandler` 或路由前置判断统一处理）。
- 注：`registerMiddleware` 无法给下游响应追加 header，因此 CORS header 统一由 `jsonResponse()` / `emptyResponse()` 辅助函数写入。

### HTTP API 契约（v1）

Base：`http://<iPhone-IP>:7777`；无需鉴权，同网段可直接调用（风险见「安全模型」）。

#### 1) `GET /v1/health`
```json
{
  "ok": true,
  "app": "xcstrings-translation",
  "version": "1.0.0",
  "port": 7777,
  "busy": false,
  "queued": 0,
  "uptimeMs": 123456,
  "provider": "openrouter",
  "model": "anthropic/claude-..."
}
```

#### 2) `GET /v1/languages`
```json
{ "ok": true, "languages": [{ "locale": "zh-Hans", "name": "简体中文" }] }
```
另返回 `aliases`（`zh-CN → zh-Hans`、`zh-TW → zh-Hant`、`pt-BR → pt` 等常见映射）。

#### 3) `POST /v1/translate`
请求：
```json
{
  "texts": ["Hello", "Cancel"],
  "targets": ["zh-Hans", "ja"],
  "source": "en",
  "profile": "plain",
  "context": "iOS app UI strings. Scripting is a product name.",
  "batchSize": 30,
  "concurrency": 1,
  "intervalMs": 1000
}
```
- `texts` 必填，1–500 条，总字符 ≤ 100k；`targets` 必填，1–13 种；未知 locale 按原样传递（名称回退为 locale）。
- `profile`：`plain`（默认，通用 UI 文案）或 `xcstrings`（沿用现有 Scripting 术语与规则）。
- Provider / model 固定使用页面设置，请求体不可覆盖；若未选中有效 Provider 或未配置 key → 502 `provider_not_configured`。
- 去重后翻译，再按原索引回填；重复文本不重复计费。
响应 200：
```json
{
  "ok": true,
  "partial": false,
  "results": {
    "zh-Hans": ["你好", "取消"],
    "ja": ["こんにちは", "キャンセル"]
  },
  "failed": {},
  "stats": { "texts": 2, "unique": 2, "targets": 2, "batches": 2, "elapsedMs": 1234 }
}
```
部分失败：`partial: true`，失败位置为 `null`，并在 `failed` 中给出索引：
```json
{ "ok": true, "partial": true, "results": { "zh-Hans": ["你好", null] }, "failed": { "zh-Hans": [1] } }
```
全部失败：`502` + `error.code = "provider_failed"`。

#### 4) `POST /v1/xcstrings?locales=zh-Hans,ja`
- Body：原始 xcstrings JSON（`application/json` 或 `text/plain`）。
- `locales` 省略时使用 UI 当前选中的目标语言；也接受 `X-Target-Locales: zh-Hans,ja`。
- 同步（默认）返回翻译后的完整 xcstrings JSON（2 空格缩进），并带：
  - `X-Translation-Status: completed | partial`
  - `X-Translation-Summary: {"zh-Hans":{"total":120,"done":120,"failed":0},...}`（纯 ASCII）
- `?async=1` → `202 { "ok": true, "jobId": "job_xxx" }`，进度与结果通过 jobs 端点获取。
- 输入校验：必须是对象且 `strings` 为对象；孤立 `\u0000`、非 JSON → 400。
- 不修改已有 `localizations`；`shouldTranslate === false` 跳过；空 key 跳过（沿用现有规则）。
- 若所有语言都失败 → 502；部分失败仍返回 200 + partial，结果中未翻译的条目保持原样。

#### 5) Jobs（异步模式）
- `GET /v1/jobs` → `{ ok: true, jobs: JobSummary[] }`（最近 20 个）
- `GET /v1/jobs/:id` →
```json
{
  "ok": true,
  "job": {
    "id": "job_...",
    "type": "xcstrings",
    "status": "running",
    "createdAt": 0, "startedAt": 0, "finishedAt": null,
    "progress": { "zh-Hans": { "total": 120, "done": 60, "failed": 0, "status": "running" } },
    "error": null
  }
}
```
- `GET /v1/jobs/:id/result` → 成功返回翻译后的 xcstrings JSON（与同步端点一致）；未完成 → 409；失败 → 502。
- `DELETE /v1/jobs/:id` → 取消 queued/running；已结束返回 409。
- 内存最多保留 20 个 job，完成后 30 分钟 TTL 清理（定时器在 server stop 时清理）。

### 翻译服务设计
```ts
type TextTranslateInput = {
  texts: string[]
  targets: string[]
  source?: string
  profile: "plain" | "xcstrings"
  context?: string
  batchSize?: number
  concurrency?: number
  intervalMs?: number
  signal?: TranslateSignal
  onProgress?: (p: Record<string, LocaleProgress>) => void
}

type TextTranslateResult = {
  results: Record<string, (string | null)[]>
  failed: Record<string, number[]>
  stats: { texts: number; unique: number; targets: number; batches: number; elapsedMs: number }
}
```
- `translateTexts`：按 locale 拆任务，每批 `batchSize`；去重；`runTasks` 调度；部分失败不抛错，全失败抛 `ProviderError`。
- `translateXcstrings`：复用 `findKeysToTranslate` / `mergeTranslations`，包装 `runTasks` 并回传逐语言进度；返回新对象，不改调用方引用。
- `resolveSelection(settings)`：固定使用页面设置的 provider/model，校验 provider 是否存在于 `discoverProviders()`；model 为空时用默认。
- prompt profile：
  - `plain`：通用翻译指令 + 保留占位符（`%@`、`%d`、`${name}`、`{{name}}`、`<tag>`）+ 不翻译代码标识符；可选 `context`。
  - `xcstrings`：保留现有 Scripting 规则（Scripting 不译为「脚本」、Assistant = 智能助手等）。
- 重试：沿用最多 3 次；新增 300ms 指数退避，避免重试绕过 interval；长度不匹配时先整批重试，仍失败则记录该批失败。

### UI 设计
- 主页面导航栏右上角 `HTTP` 入口（`NavigationLink`）打开独立 `ServerPage`；同一右上角也提供「最小化」按钮，服务页同样提供。服务面板不再内联在主列表。
- `ServerPage`：`List` + 导航标题「HTTP 服务」，右上角「最小化」按钮（`Script.supportsMinimization()` 为假时禁用）。
- 服务面板内容：
  1. `Toggle`：启用 HTTP 服务（启动/停止；停止时释放端口）。
  2. 状态行：`已停止 / 启动中 / 停止中 / 运行中 / 错误` + 端口。
  3. 地址：每个局域网 IPv4 一行 `http://192.168.x.x:7777`，点击复制；无地址时提示检查 Wi-Fi。
  4. 端口：`TextField`（1024–65535），仅停止时可改。
  5. 保活开关：`后台保活`（默认开，调用 BackgroundKeeper）与 `保持屏幕常亮`（默认关）。
  6. 最近请求：最多 20 条（时间、方法、路径、状态码、耗时、客户端 IP），倒序。
  7. Footer：仅同一局域网可用；无鉴权，同网段任何设备都可消耗额度；关闭脚本即停止，最小化不停止；后台保活尽力维持；长任务建议用异步 job。
- 最小化行为：主页面与服务页的「最小化」都调用 `Script.minimize()`（共用 `util.minimizeCurrentScript()`）；主页面启用 `Script.enableMinimize()` 与 `swipeBackBehavior: "minimize"`，左滑/下滑隐藏 UI 但不终止脚本，HTTP 服务继续监听。显式「关闭」仍 `dismiss` 并触发 `index.tsx` 的 finally 停止服务。

设置新增：
```ts
serverPort: number          // 7777
autoStartServer: boolean    // false
serverKeepAlive: boolean    // true
serverKeepScreenOn: boolean // false
```
沿用 `xcstrings.translation.settings.v2`，读取时与默认值合并，无需迁移。

### 错误码约定
| HTTP | code | 场景 |
| --- | --- | --- |
| 400 | `invalid_json` / `invalid_request` | 解析失败、字段缺失、越界 |
| 404 | `not_found` | 路径不存在 |
| 405 | `method_not_allowed` | 方法不支持 |
| 409 | `busy` / `job_not_ready` / `job_finished` | 队列或 job 状态冲突 |
| 413 | `payload_too_large` | 超过 20MB |
| 415 | `unsupported_media_type` | Content-Type 不符 |
| 429 | `queue_full` | 队列已满 |
| 502 | `provider_failed` / `provider_not_configured` | AI 调用失败/未配置 |
| 500 | `internal_error` | 未分类异常 |

### 实施顺序（获批后）
1. `translate.ts` 改造（对齐数组 + profile + 退避），`engine/translation_service.ts` 抽取；UI 跑通回归。
2. `engine/keep_alive.ts` 引用计数 + `engine/job_queue.ts` + `server/job_registry.ts`；验证互不误释放。
3. `server/http_server.ts` + `routes.ts`：health → translate → xcstrings → jobs。
4. UI `ServerPanel` + store/i18n 增项；启动/停止/清理/保活。
5. README + 示例；`curl` 实测（含切后台）；诊断归零。

## Decisions（2026-11-18 用户已确认）
- [x] Q1 端点范围：纯文本 + 整份 xcstrings 都要。
- [x] Q2 大文件：启用异步 job（`?async=1` + 轮询）。
- [x] Q3 鉴权：**不做鉴权**；同网段可直接调用，风险由 UI/README 提示。
- [x] Q4 Provider：**只用页面设置**，HTTP 不可覆盖 provider/model。
- [x] Q5 端口：默认 7777（旧默认 8787 做一次性迁移），页面可改；不做公网/HTTPS。
- [x] Q6 UI：主页面右上角 `HTTP` 入口 + 独立 `ServerPage`（2026-11-18 修订；原方案为页面内 Section）。
- [x] Q7 存活：使用 `BackgroundKeeper` 保活；页面/进程存活期间服务有效，后台尽力维持，不承诺 24/7。
- [x] Q8 执行：先只定稿 spec（2026-11-18）；随后用户明确批准实现（2026-11-18）。
- [x] Q9 Headless：通过 `Script.run` + `mode=server` 启动；**不使用 singleMode**；启动前用 `/v1/health` 探测已运行；`Script.onResume` 负责状态页/重启/停止。

## Checkpoint Summary
- 当前任务理解：抽出翻译服务层 + 本机 HTTP Server + 页面管理面板 + 文档；先方案后实现。
- 当前核心目标：已按用户选择定稿 API 契约、模块边界、安全与生命周期；等待执行许可。
- 当前进度：已按定稿方案完成实现（service 抽取、keep-alive 引用计数、全局队列、HTTP 路由/异步 job、独立 `ServerPage`、右上角入口、最小化、i18n、README）。
- 下一步 1：用户实机验证最小化/后台保活与真实局域网设备访问。
- 下一步 2：按反馈微调（如 provider 发现缓存、鉴权开关、Bonjour 发现）。
- 涉及文件 / 模块：`translate.ts`、`engine/translation_service.ts`、`engine/keep_alive.ts`、`engine/job_queue.ts`、`engine/runner.ts`、`server/*`、`components/ServerPanel.tsx`、`components/TranslationApp.tsx`、`store.ts`、`i18n.ts`、`languages.ts`、`index.tsx`、`README.md`。
- 风险：无鉴权导致同网段滥用额度、局域网可达性、iOS 后台挂起、长任务超时、provider 限流、端口占用、保活引用计数误释放。
- 验证方式：TS 诊断 0；本机 `curl` 验证 health/languages/translate/xcstrings/jobs/400/404/405/OPTIONS；真实翻译往返；页面截图。后台保活仍需实机确认。
- Execution Approval: `Approved`（2026-11-18）

## Change Log
- 2026-11-18: 初始 standard spec：现状梳理、HttpServer 等 API 核实、HTTP 契约与模块方案、Open Questions、实施顺序。
- 2026-11-18: 按用户选择定稿：双端点、异步 job、无鉴权、provider 只读、BackgroundKeeper 引用计数保活、UI 独立 Section；用户要求先只定稿 spec，未实现。
- 2026-11-18: 用户批准实现。完成 `translate.ts` 对齐数组+profile+退避、`engine/translation_service.ts`、`engine/keep_alive.ts`、`engine/job_queue.ts`、`server/*`、`ServerPanel`、store/i18n/README；修复 HttpServer 同 path 多 method 覆盖问题。
- 2026-11-18: UI 调整：主页面右上角 `HTTP` 入口打开独立 `ServerPage`；新增「最小化」按钮，`index.tsx` 启用 `Script.enableMinimize()` 与 `swipeBackBehavior: "minimize"`，最小化后服务继续运行。
- 2026-11-18: 按用户反馈：最小化覆盖整个脚本（主页面与服务页都有入口），不再只限服务页；默认端口改为 7777，并迁移旧默认 8787；README 补充完整 HTTP Server 使用/排错说明。
- 2026-11-18: 新增 headless 模式：`index.tsx` 按 `mode=server` 分支，`server/standalone.tsx` 负责启动/探测/onResume/状态页；新增 `/v1/shutdown`；不使用 singleMode。

## Validation
- Self-check: 方案覆盖「其他位置通过 HTTP 翻译内容」的核心诉求，并保留现有 UI 能力。
- Static checks: 基线 `get_typescript_diagnostics` = 0。
- Runtime / Test: `scripting-ts run` smoke 通过：`/v1/health` 200、`/v1/languages` 200、非法 translate 400、未知路径 404、OPTIONS 204；异步 xcstrings 202 + job 查询/结果/取消 409；真实翻译 `Good morning → おはようございます`；纯文本去重 `Hello`×2 对齐且 `unique=2`。
- UI: `scripting-ts project` 页面正常渲染且右上角出现 `HTTP` 入口；`preview_ui` 验证 `ServerPage`（含「最小化」按钮、端口、保活、请求日志）渲染正常。全局最小化按钮已加到主页面与服务页。
- Headless: `scripting-ts project --queryparameters '{"mode":"server","port":8877}'` 启动后不出页面，`/v1/health` 返回 `standalone:true`；再次启动返回 `{"alreadyRunning":true}`；`action=stop` 与 `POST /v1/shutdown` 均能让实例退出并释放端口。
- onResume: 代码已接入（状态页/重启/`action=stop`），但 CLI 启动的实例无法用 `scripting://run` 触发，需实机验证。
- Minimize: 已按文档接入；最小化后的后台服务保持与恢复仍需实机确认。
- Human confirmation: 方案与实现均已获批（2026-11-18）。
- 结果汇总：核心功能已实现并由 curl + 截图证明；后台保活/真实局域网设备访问待用户实机确认。
- 核心目标是否已由证据证明完成：是（前台与异步链路已验证）；后台常驻为尽力而为。
- 若未完成，当前剩余差距：后台保活实际效果、局域网跨设备访问。
- 剩余风险：见 Facts / Constraints。

## Resume / Handoff
- 当前状态：UI 与 headless 两种模式均已实现；headless 启动/重复检测/stop/shutdown 已实测；诊断 0。
- 当前卡点：无硬性卡点；onResume 页面呈现、后台保活与跨设备访问需实机验证。
- 下一步唯一动作：用户在实机上用 `Script.run` 或 URL scheme 启动 headless 服务，然后从运行列表恢复，验证状态页与停止逻辑。
- 下一轮核心目标：根据实机反馈修正（onResume 呈现时机、外部服务状态展示、保活策略）。
