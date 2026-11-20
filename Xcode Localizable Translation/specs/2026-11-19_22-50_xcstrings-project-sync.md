# Spec: XCStrings 项目级批量翻译同步

## Goal
- 要解决什么问题：现在只有「剪贴板粘贴 → 翻译 → 复制/导出」的单文件流程，无法处理真实项目（`~/work/scripting-ios`，58 个 `.xcstrings`、7,267 个 key、12 种目标语言、38,364 个待翻译槽位）。每次人工搬文件既慢又容易覆盖已有译文。
- 验收结果：我说一句「把 scripting-ios 的待翻译内容补一下」，代理即可自动完成「连 Mac → 拉取全部 xcstrings → 在脚本内翻译 → 保风格写回 → 校验 diff」，并且重复执行幂等、失败可续跑、写回不产生无关 diff。

## Done Contract
- 什么算完成：
  - 脚本新增 `mode=batch` 无界面模式：输入一个目录，扫描全部 `*.xcstrings`，按目标语言补齐缺失译文，只插入不重排，返回 JSON 报告。
  - 写回使用「保风格文本补丁」：自动识别 `"k" : v` / `"k": v` 两种风格，保留原有 key 顺序、字段顺序、缩进与末尾换行；补丁后 JSON 解析结果与预期对象深度一致才允许落盘。
  - 支持 stale 清理（`off` / `all` / `file` 白名单三档），删除同样走文本补丁。
  - 支持全局去重（同一 source 文案在一次运行内只翻译一次，再散布回所有文件/语言）。
  - 支持分片：`maxRequests` 限制单次运行的模型请求数，未完成的留到下次运行，重新扫描即可续跑（无独立状态文件）。
  - `index.tsx` 可被 `scripting-ts project "<项目名>" --queryparameters ...` 直接驱动，`Script.exit` 返回精简报告。
- 由什么证明：本地合成用例（含 `"k" : v` 与 `"k": v`、含 stale、含中文/占位符/引号转义）跑两遍，第二遍 `changed=false`；真实项目跑 zh-Hans 307 条后 `git diff --stat` 只出现新增行，JSON 仍可被 Xcode 解析。
- 哪些情况仍算未完成：写回后文件出现重排/缩进变化；已存在译文被覆盖；删除 stale 后 JSON 不合法；中断后无法续跑。

## Scope
- In：
  - 新增 `xcstrings_patch.ts`：JSON 文本扫描器 + 插入/删除补丁 + 结果校验。
  - 新增 `engine/batch.ts`：目录扫描、清理、统计、全局去重、分片翻译、回填、写回、报告。
  - 升级 `xcstrings_util.findKeysToTranslate`：`localizations[locale]` 缺失、`stringUnit.value` 为空、`state === "new"` 都算待翻译。
  - `index.tsx` 增加 `mode=batch` 分支；`store.ts` 无需新设置（参数全部来自 query）。
  - README 增加「项目级批量同步」章节（参数、流程、curl/CLI 示例、风险）。
  - 代理侧流程（Mac 拉取/回写、stale 源码核对）写进 README 便于复用。
- Out（本轮不做）：
  - 复数 `variations` 翻译（本项目当前 0 条；遇到时跳过并在报告中计数，不写坏文件）。
  - 复数/设备变体的自动生成。
  - 直接读写 Mac 上的文件（仍通过 SSH/SFTP 中转，脚本只认本地目录）。
  - 增量 git 提交、PR 创建。

## Facts / Constraints

### 真实项目数据（2026-11-19 只读体检）
- 58 个 `.xcstrings`，7,267 个 key，`sourceLanguage` 全为 `en`。
- 待翻译槽位 38,364；去重后唯一英文 6,835 条。
- 各语言待翻译（槽位 / 去重后）：zh-Hans 307/307、zh-Hant 2,337/2,183、zh-HK 7,188/6,813、ja 3,130/2,917、de 3,130/2,917、es 3,168/2,932、fr 3,168/2,932、it 3,191/2,955、ko 3,168/2,932、pt 3,194/2,958、ru 3,194/2,958、en-GB 3,189/2,953。
- `state` 分布：`translated` 51,249、`new` 74（全部挂在 `shouldTranslate: false` 条目上）。
- `variations`：0 条。
- `extractionState: "stale"` 682 条；在 3,214 个 Swift 文件中按「占位符归一化 + 最长字面片段」核对，227 条完全找不到（可安全删除的候选）。
- 序列化风格混用：28 个文件 `"key" : value`（Xcode 原生），30 个文件 `"key": value`（紧凑）。字段顺序有 5 种变体，其中 21 条是 `localizations` 在前的历史手改条目。
- Xcode 会按字典序排 key 与 locale；因此**只插入、不重排**才能得到干净 diff。

### 传输约束（已实测）
- 系统 `ssh`（Bash 栈）在本机被代理隧道干扰：TCP 可连但 banner 交换超时 → 改用 App Tailscale 的 SSH 服务（已保存 `mac`，用户 `thomfang`）。
- `tailscale ssh_exec` 只返回文本，预览 ≤ 64KiB → 不能传文件。
- `tailscale sftp`：单文件 ≤ 64MiB，**不允许覆盖同名文件** → 每次用时间戳命名，远端解包后再删包。
- Tailscale 隧道在 App 退到后台时会失效，每次操作前需 `connect`；失败提示 `capabilityUnavailable` 时重连即可。
- 脚本侧文件 API：`FileManager.readDirectory(path, recursive)`、`readAsString`、`writeAsString`、`exists`、`remove`、`createDirectory`。
- `scripting-ts project "<项目名>" --queryparameters '<json>' --timeout <s>` 运行在**项目作用域**，可读取 provider/model 配置（`run`/`eval` 作用域会误判缺失）。

### 约束
- 模型请求成本受 Provider 限流影响；并发/间隔沿用 `SchedulerController` 的全局节流语义。
- 单次 CLI 运行不能太长（容易被系统挂起或超时），必须分片。
- 写回必须是「最小 diff」：否则 58 个文件会产生不可评审的变更。
- 不能破坏已有译文；`shouldTranslate: false` 一律跳过。

## Restated Understanding
- 我理解当前任务是：把脚本从「单文件交互工具」升级为「项目级批量翻译引擎」，并配一条固定的 Mac 双向同步流程，由代理按需驱动。
- 当前核心目标是：批量模式 + 保风格写回 + 分片续跑 + stale 清理四件事可用，并用真实项目验证 diff 干净。
- 当前边界是：脚本只处理本地临时目录；Mac 交互由代理用 Tailscale SSH/SFTP 完成。
- 暂不处理：复数变体、自动 git 提交、增量文件监听。

## Decisions（2026-11-19 用户确认）
| 决策 | 选择 |
|---|---|
| 目标语言 | 除 `zh-HK` 外 11 种：zh-Hans、zh-Hant、ja、de、es、fr、it、ko、pt、ru、en-GB |
| stale 清理 | `safe`：只删「源码里找不到字面片段」的 227 条（清单由代理侧 Python 生成后传入） |
| 去重范围 | 按文件去重（2026-11-19 追加：逐个文件翻译，不把多个文件合并成一批，避免限流） |
| 写回方式 | 直接改工作区，改前自动备份，改后由代理给 `git diff --stat` |
| 并发/间隔 | 串行：并发 1、请求间隔 1000ms（2026-11-19 追加：一个文件翻完再下一个） |
| 首次验证 | 只跑 zh-Hans 的 307 条 |

## Architecture

### 模块
```
xcstrings_patch.ts        JSON 文本扫描 + 插入/删除补丁 + 深度校验（新增）
engine/batch.ts           目录流水线：扫描/清理/统计/去重/分片翻译/回填/写回/报告（新增）
xcstrings_util.ts         findKeysToTranslate 升级（空值、state=new），保留旧合并函数
engine/translation_service.ts  复用 translateTexts / translate
index.tsx                 新增 mode=batch 分支（无 UI，Script.exit 返回报告）
README.md                 项目级同步流程与参数说明
```

### 数据流
```
dir ──scan──▶ files[{relPath, raw, data, style}]
        │
        ├─ prune ──▶ 删除 stale（可选，文本补丁）
        │
        ├─ pending ──▶ 按文件切片：一次只处理一个文件
        │                └─ 文件内按 locale 去重 ──▶ tasks
        │
        ├─ 分片：当前文件取剩余额度内的 batch ──▶ translate() × concurrency(默认 1)
        │
        ├─ scatter ──▶ per-file edits[(key, locale, value)]
        │
        └─ patch(file) ──▶ 校验 JSON 深度一致 ──▶ writeAsString（备份原文件）
                                              └─▶ report.json + Script.exit(摘要)
```

### 补丁器设计（`xcstrings_patch.ts`）
- 单遍扫描生成结构：`strings` 对象成员（key、值 span）、每个条目的字段 span、`localizations` 成员的 locale span。
- 插入：按字典序找到锚点成员，在该成员行首插入 `"<locale>" : { "stringUnit": { state, value } }`，并补逗号；尾部追加时在最后一个成员后插 `,\n<indent>`。
- 删除：按 span 从后往前删除，处理首/尾成员的逗号边界。
- 风格：文件前部检测 `" : "` → Xcode 风格，否则紧凑风格；生成的片段与外层缩进保持一致（每层 2 空格）。
- 校验：补丁后 `JSON.parse`，与内存中期望对象做深度比较；不一致则不写盘并报错。
- 幂等：无新增/删除则 `changed=false`，不触碰文件。

### 参数（`mode=batch`）
| 参数 | 说明 |
|---|---|
| `dir` | 必填，本地目录（递归） |
| `targets` | 目标 locale，逗号分隔或数组；默认取设置里的语言 |
| `source` | 源语言，默认取文件 `sourceLanguage` |
| `prune` | `off`(默认) / `all` / `file` |
| `pruneFile` | `prune=file` 时的白名单 JSON：`{ "<relPath>": ["key", ...] }` |
| `write` | 默认 true；false 时只统计不改文件 |
| `backup` | 默认 true，写到 `<dir>/.backup/<timestamp>/` |
| `maxRequests` | 单次运行最多发起的模型请求数，默认 60 |
| `batchSize` / `concurrency` / `intervalMs` | 覆盖默认值（30 / 5 / 500） |
| `filter` | 只处理相对路径包含该子串的文件 |
| `reportPath` | 报告输出路径，默认 `<dir>/.batch-report.json` |

### 报告结构
```json
{
  "ok": true, "dir": "...", "files": 58, "targets": ["zh-Hans"],
  "pendingBefore": 307, "translated": 307, "failed": 0, "remaining": 0,
  "requests": 11, "stoppedBy": "done", "pruned": 0, "changedFiles": 42,
  "elapsedMs": 123456, "errors": []
}
```

## 验收与验证
1. 合成用例：两份文件分别使用两种风格，包含换行、引号、`%@`、CJK、空 key、stale 条目。
2. 跑两遍：第一遍产生新增行；第二遍 `changedFiles=[]`（幂等）。
3. `prune=file` 删除指定 stale 后 JSON 合法且其它条目字节不变。
4. 真实项目：先 `write=false` 出统计，再跑 zh-Hans 307 条，`git diff --stat` 只增不减，抽查 3 个文件 JSON 合法。
5. 分片：`maxRequests=2` 连跑多次，最后一次 `remaining=0`。

## 风险
- 9MB 的 `Localizable.xcstrings` 全量读写内存峰值约 40MB，可接受；补丁扫描为线性。
- 全局去重会让同一句在不同页面共用译文；若出现语境冲突，可用 `dedupe=false` 重跑该语言。
- 代理侧 stale 清单依赖源码扫描启发式；误删风险由「备份目录 + git」兜底。

## 执行记录（2026-11-19）

### 第一轮：zh-Hans
- 58 文件扫描，307 槽位，11 次请求，179s，失败 0（一次输出解析失败自动重试成功）。
- 写回 `Localizable.xcstrings` +285、`Resources/InfoPlist.xcstrings` +22。
- 发现并修复补丁器缺陷：`"key" : {\n    }` 这类空条目插入 `localizations` 后多出 4 空格行（569 处）。
  修法：空条目改为替换 `{` 与 `}` 之间的整段空白；新增 `empty body` 回归用例。
  - 副作用：`retries` 触发的重试会把模型输出打进日志，已把错误摘要截断到 300 字符。

### 第二轮（修复后重跑 + 删除 stale）
- zh-Hans 重跑：307 条，11 次请求，271s，失败 0。
- stale 删除：代理在 Mac 上用「占位符归一化 + 最长字面片段」筛出 227 条（9 个文件），
  以 `prune=file` 传入，删除 227 条，耗时 1.7s。
- 最终校验（Mac 上对比运行前快照）：
  - `zh-Hans added=307`、`stale removed=227`、`changedExisting=0`、`fieldDiffs=0`、`problems=0`
  - 9 个文件 sha256 与手机侧完全一致（sftp 传输无损）。
  - `git diff --stat` 的大数字来自用户工作区原有未提交改动，不是本轮产生的。

### 待办
- 其余 10 种语言（zh-Hant/ja/de/es/fr/it/ko/pt/ru/en-GB）本轮未跑，用户选择「今天先到这」。
- `zh-HK` 仍按决策不处理。
- 复数 `variations` 未支持（当前项目为 0 条）。
