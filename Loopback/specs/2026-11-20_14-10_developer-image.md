# Spec: Developer Image Download and Install

## Status
Proposed 2026-11-20 14:10. Scope and client contract approved by user 2026-11-20 14:18.
Phase A approved 2026-11-20 14:19, implemented and accepted on device the same day.
Phase B approved 2026-11-20 14:51 and implemented the same day.
Real-device check passed: `ensureDeveloperImage` returned `already_installed` (27.2.52.0), cache 5/5, and debug services were visible. The actual upload/install path was not exercised because the device already had an image.
Implementation approval: Phase A `Done`; Phase B `Done (code) / idempotent device path accepted; fresh install upload still unverified`.
Reference implementation: `scripts/SideInstaller` (`lib/ddi/*`, `lib/ui/ddi-manager.ts`, `lib/ui/settings.tsx`). This is a port/adaptation of that code, not a new DDI design; see “与 SideInstaller 的复用关系”.

## Restated Understanding
- 参考 SideInstaller 的开发者镜像能力：下载 5 个 Cryptex1 镜像文件、缓存到本脚本 Documents、显示进度、可删除；在设备上检查/安装开发者镜像。
- 当前核心目标：让 Loopback 从「只准备隧道」扩展为「也能准备开发者镜像」，并把结果通过现有 ScriptSession 服务交给其他脚本。
- 当前边界：不改配对、Keychain、VPN 来源和隧道所有权模型；不在 `ensureTunnel` 中隐式安装镜像；不实现 iOS 26.4 以前的旧式镜像挂载。
- 本轮只更新 spec 与验收标准；实现等明确批准后再开始。

## Goal
- 用户能在 Loopback UI 内下载、查看、删除开发者镜像缓存。
- 已配对且系统为 iOS 26.4+ 时，能检查并安装开发者镜像，安装后刷新 RSD 服务表。
- 其他脚本能通过 ScriptSession 预取镜像、查询状态、请求确保镜像。
- 所有失败都有阶段、原因和可重试路径；不向其他脚本暴露配对记录、私钥或 PSK。

## Done Contract
- 完成：5 个镜像文件可下载到 `Documents/Loopback/DDI`（与 SideInstaller 的 `Documents/DDI` 隔离）；UI 显示 `n/5`、总大小、下载进度；删除后可重新下载；已配对 iOS 26.4+ 设备上 `ensureDeveloperImage` 返回 `installed` / `already_installed` / `already_mounted`，`cryptexd copy-installed` 能看到 `com.apple.MobileAsset.DDI`，刷新后服务表出现镜像提供的服务。
- 证明：Loopback 全量 TypeScript diagnostics 无错误；`tests/ddi.ts` 等纯逻辑单测通过；真机 iOS 26.4+ 手工验收日志（下载、安装、刷新服务、失败重试）。
- 未完成：只有 mock 测试、下载成功但安装未验证、安装后未刷新服务表、错误只显示“失败”。

## Scope
In:
- Phase A：镜像文件清单、下载队列、缓存检测、进度、删除、页面、权限、`developerImageStatus` / `downloadDeveloperImage` 命令。
- Phase B：RemoteXPC 会话、BuildManifest 解析、TSS 票据、cryptexd 调用、image mounter 检测、安装与验证、服务表刷新、`ensureDeveloperImage` 命令。
- 中英文 README、兼容性自检权限项、`script.json` 权限与版本号。

Out:
- iOS 26.4 以前的 Personalized DMG 挂载方式。
- 在 `ensureTunnel` 内自动安装；不改变现有客户端行为。
- 跨脚本共享镜像文件；缓存归 Loopback 自己所有。
- 镜像内容的额外签名/哈希校验（TSS 票据与设备安装结果作为验证）。
- 自定义镜像源的复杂镜像站管理（仅保留一个可覆盖的 base URL 设置项，见下）。

## Facts / Constraints
- SideInstaller 使用 5 个文件：`BuildManifest.plist`、`Image.dmg`、`Image.dmg.trustcache`、`Image.dmg.cryptex_info`、`Image.dmg.root_hash`。
- 默认源：`https://github.com/doronz88/DeveloperDiskImage/raw/refs/heads/main/PersonalizedImages/Xcode_iOS_DDI_Cryptex`。实测可访问；`Image.dmg` 约 17.2 MB，`BuildManifest.plist` 约 804 KB。
- SideInstaller 的安装流程：`copy-installed` 查 cryptex → image mounter `CopyDevices` 查已挂载 → iOS 版本门禁 → 下载 → 解析 BuildManifest → `read-personalization-id` → `get-nonce` → TSS `Cryptex1` 票据 → `install` 五路 XPC file transfer → `copy-installed` 验证。
- 安装后设备服务表会变化；SideInstaller 选择重连。Loopback 需要 `DeviceSession.refreshServices()`，并提示其他脚本自行 `listServices({ refresh: true })`。
- `ScriptSession.call` 的 timeout 上限是 300000 ms，reply 上限 64 KiB；服务处理器串行。下载 17 MB 可能超过 5 分钟，因此不能把“下载 + 安装”都塞进一个同步命令。
- loopback 现有 `core/xpc.ts` 支持 RSD 握手所需的对象编解码，但没有 `fileTransfer` 类型；现有 `core/http2.ts` 是面向 RSD 握手的简化客户端，不处理发送侧流控。
- `FileManager` 的 `documentsDirectory` 是脚本自己的目录；`DownloadManager` 只在 main App（`Script.env === "index"`）可用，Loopback 符合。
- per-script 权限开启时，文件系统需要 `fileSystem`；当前 Loopback 只请求 `localDevVPN`、`vpn`。
- 安装镜像需要设备保持前台执行时间；Scripting 后台会挂起 JS，真机验收必须在 Loopback 页面停留。

## Proposed Architecture

### 与 SideInstaller 的复用关系
这不是重新设计一套 DDI 协议，而是把 SideInstaller 已有的实现搬进 Loopback。Scripting 脚本之间不能直接 `import`，而且两边的底层传输栈不同：SideInstaller 用自己的 `DeviceLink` + `lib/rsd` + `lib/rpp`，Loopback 已有 `DeviceSession` + `VPNRSDTunnel` + `PlistServiceClient`。因此处理原则是：**协议、常量、阶段编排原样照搬；只替换传输/类型适配层。**

| SideInstaller | Loopback | 处理方式 |
| --- | --- | --- |
| `lib/ddi/cache.ts` | `kit/ddi/cache.ts` | 逐行移植；文件系统与 Downloader 改为可注入，URL 常量保留并增加可覆盖 base URL |
| `lib/ddi/manifest.ts` | `kit/ddi/manifest.ts` | 逐行移植；`PlistValue` 换成 Loopback `kit/plist` / `core/bplist` 的类型 |
| `lib/ddi/tss.ts` | `kit/ddi/tss.ts` | 逐行移植；`randomBytes`/`fromUtf8` 换成 `core/bytes`，`fetch` 用法保持一致 |
| `lib/ddi/mounter.ts` | `kit/ddi/mounter.ts` | 协议照搬；`PlistStream` + `rsdCheckin` 换成现有 `PlistServiceClient.request` |
| `lib/ddi/cryptexd.ts` | `kit/ddi/cryptexd.ts` | XPC routine 与参数照搬；`DeviceLink` 换成 `DdiLink` 适配器，XPC 类型换成 `core/xpc` |
| `lib/ddi/install.ts` | `kit/ddi/install.ts` | 阶段顺序、版本门禁、错误包装照搬；`DeviceLink` 换成 `DeviceSession` 适配 |
| `lib/rsd/remote-xpc.ts` | `kit/remoteXpc.ts` | 移植整个会话类，保留发送侧流控与五路 file transfer；`ByteStream.read` 改为传 `MAX_CHUNK` |
| `lib/rpp/xpc.ts` 的帧部分 | `core/http2frames.ts` | 只搬 HTTP/2 帧编码/解析与 RSD 服务端口握手；不搬配对、SRP、TLV |
| `lib/ui/ddi-manager.ts` | `kit/developerImage.ts` | 状态机与进度汇总照搬；React hooks 改成 Loopback 的页面状态 + 订阅 |
| `lib/ui/settings.tsx` 的 DDI 区块 | `pages/DeveloperImagePage.tsx` | UI 结构参考，文案改成 `tx()` 双语，入口放到首页 |
| `lib/engine.ts` 的 DDI 调用点 | `index.tsx` / 页面 | 安装成功后刷新服务表，其余流程不变 |

不直接把 SideInstaller 的 `lib/ddi` + `lib/rsd` + `lib/rpp` + `lib/util` 整棵子树复制进来，原因：会引入第二套 RSD/配对/流实现、重复数千行代码，并绕过 Loopback 的连接配额与会话所有权。除非后续明确要“完全独立、零适配”，否则按上表做最小适配。

### 新增模块


| 文件 | 职责 |
| --- | --- |
| `kit/ddi/cache.ts` | 5 个文件的 URL、缓存目录、存在性/大小检测、DownloadManager 队列、删除下载记录 |
| `kit/ddi/manifest.ts` | 从 BuildManifest 找 cryptex identity、payload 路径、nonce domain、properties、TSS tags、nonce/UDID 编码 |
| `kit/ddi/tss.ts` | 向 `gs.apple.com/TSS/controller?action=2` 请求 `Cryptex1` 票据并解析 |
| `kit/ddi/mounter.ts` | 通过 `com.apple.mobile.mobile_image_mounter.shim.remote` 的 `CopyDevices` 检测已挂载镜像 |
| `kit/ddi/cryptexd.ts` | `com.apple.security.cryptexd.remote` 的 `copy-installed` / `read-personalization-id` / `get-nonce` / `install` |
| `kit/ddi/install.ts` | `ensureDeveloperImage` 阶段编排、版本门禁、错误包装、安装后校验 |
| `kit/ddi/index.ts` | 对外导出 |
| `kit/remoteXpc.ts` | RemoteXPC 服务会话：HTTP/2 帧、XPC 消息、五路 file transfer、发送侧流控 |
| `kit/developerImage.ts` | 页面/服务共用的镜像状态机：缓存状态、下载进度、安装阶段、失败信息、并发去重 |
| `pages/DeveloperImagePage.tsx` | 开发者镜像页面 |

修改：

| 文件 | 改动 |
| --- | --- |
| `core/xpc.ts` | 增加 `fileTransfer` 类型（0x0001a000）的编码/解码；保持现有类型不变 |
| `core/http2frames.ts`（新）或 `kit/remoteXpc.ts` 内部 | 提供 SETTINGS / WINDOW_UPDATE / HEADERS / DATA 的编码与解析、RSD 服务端口握手帧 |
| `kit/session.ts` | 增加 `DeviceSession.refreshServices()`，重新 `listServices({ refresh: true })` 并替换 map |
| `kit/capability.ts` / `pages/CheckPage.tsx` | 权限检查加入 `fileSystem` |
| `index.tsx` | 首页入口、服务命令分发 |
| `script.json` | `permissions` 增加 `fileSystem`；版本升到 1.1.0（实现时） |
| `client/loopback.ts` | 新增 `ensureLoopbackTunnel`、`ensureLoopbackDeveloperImage`、下载/状态类型与轮询封装 |
| `README.md` / `README-zh.md` | 新增镜像章节、命令表、客户端用法和限制 |
| `tests/ddi.ts` / `tests/xpc.ts` | 纯逻辑单测 |

### Data flow
1. 页面或 `developerImageStatus` 读取磁盘状态：`present/total/bytes/ready/progress`。
2. 下载：`DownloadManager.open({ identifier: "loopback-ddi" })`，逐文件下载到 `Documents/Loopback/DDI`；已存在且大小 > 0 的文件跳过；总进度按 `(index + fraction) / 5` 汇总。
3. 安装：
   - `deviceHub.get()` 取当前会话；未配对直接返回 `not_paired`，不打开 UI。
   - `copy-installed` 查 `com.apple.MobileAsset.DDI`；有则 `already_installed`。
   - image mounter `CopyDevices`；有任何条目则 `already_mounted`（避免 cryptex 覆盖已挂载镜像导致 `mkdir custom mount path`）。
   - 检查 iOS >= 26.4；否则 `unsupported`。
   - 缓存未齐时先自动下载缺失文件，再继续安装；不要求用户去页面点下载。
   - 解析 BuildManifest；读取设备识别码与 nonce；请求 TSS；通过 RemoteXPC `install` 上传五路 payload。
   - `copy-installed` 验证；成功后 `session.refreshServices()`。
4. 任何阶段失败都包成 `DdiError(stage, message)`，页面显示中文阶段，服务返回 `stage`。

## Service contract
现有 `status`、`ensureTunnel`、`releaseTunnel` 不变，`ensureTunnel` 不隐式安装镜像。
新增三个命令；均为 JSON，reply < 64 KiB。

| 命令 | 是否连设备 | 行为 | 结果 |
| --- | --- | --- | --- |
| `developerImageStatus` | 否 | 读缓存状态；Phase B 可增加最近一次安装状态 | `{ status:"ok", cache }` |
| `downloadDeveloperImage` | 否 | 启动/复用后台下载后立即返回，不等待完成 | `{ status:"started"|"already_ready"|"busy"|"error", cache, message? }` |
| `ensureDeveloperImage` | 是 | 缓存缺失时自动下载，然后检查/安装；未配对/版本不支持才快速返回 | 见下 |

`cache`：
```ts
{
  present: number; total: number; bytes: number; ready: boolean;
  missing: string[];
  files: Array<{ file: string; size: number; present: boolean }>;
  progress: number | null; busy: boolean; failure: string;
  baseUrl: string;
}
```

`ensureDeveloperImage` 结果：
```ts
{
  status: "installed" | "already_installed" | "already_mounted"
        | "not_paired" | "unsupported" | "busy" | "error";
  ready: boolean;              // installed/already_* 为 true
  version?: string;            // cryptex 版本；already_mounted 时为挂载类型拼接
  mountedTypes?: string[];
  stage?: DdiStage;
  cache: CacheState;
  message?: string;
}
```

客户端推荐流程：
1. 需要镜像时直接调用 `ensureDeveloperImage`；缺失文件由它自动下载，不需要用户去页面点按钮。
2. timeout 建议 `300000`（服务上限）；下载较慢时调用方可能超时，但下载会在后台继续，之后可再用 `developerImageStatus` / `ensureDeveloperImage` 核实。
3. 成功后自行 `tunnel.listServices({ refresh: true })`，再打开镜像提供的服务。
4. 只有需要显示进度或提前缓存时，才单独用 `developerImageStatus` / `downloadDeveloperImage`。

并发与超时：
- 服务处理器串行；`ensureDeveloperImage` 执行期间，`status`/`ensureTunnel` 会排队。
- 下载由 DownloadManager 独立继续，不因服务 handler 返回而取消。
- `ensureDeveloperImage` 负责“缺就下载，再安装”；下载和安装共用同一个串行槽位。
- 同一时刻只允许一个下载/安装；重复请求返回 `busy` 或复用同一 progress。

## 其他脚本怎么用

原则：**镜像不是隧道的必经步骤。** 先拿隧道，按需判断目标服务是否存在；只有确实缺调试类服务时才安装镜像。不要把 `ensureDeveloperImage` 塞进每个客户端的启动流程。

### 推荐调用顺序
1. `ensureTunnel`（已有配对时也可跳过；未配对时它负责打开配对页）。
2. 自己 `attachRSDTunnel()` 取得独立句柄，`listServices({ refresh: true })` 看目标服务是否存在。
3. 目标服务不存在时，再调用 `ensureDeveloperImage`；它会在缺文件时自动下载。
4. 安装成功后，**调用方自己**再 `listServices({ refresh: true })`；Loopback 只刷新它自己的服务表。
5. 打开服务，正常使用；清理时只关自己的连接/句柄，不卸载镜像。

### 客户端封装
在 `client/loopback.ts` 增加：

```ts
// 确保隧道并 attach 自己的句柄；失败时抛错。
export async function ensureLoopbackTunnel(timeout = 180_000): Promise<VPNRSDTunnel>;

// 查询缓存状态，不连设备。
export function developerImageStatus(timeout = 10_000): Promise<DeveloperImageStatus>;

// 启动/复用后台下载，立即返回。
export function downloadDeveloperImage(timeout = 10_000): Promise<DeveloperImageDownloadResult>;

// Phase A：缺文件时自动下载并等待完成；只准备缓存，不安装。
export async function ensureLoopbackImageFiles(options?: {
  pollMs?: number;       // 默认 2000
  timeoutMs?: number;    // 默认 300000
}): Promise<DeveloperImageCache>;

// Phase B：缺文件时自动下载，然后安装；不需要 allowDownload 开关。
export async function ensureLoopbackDeveloperImage(options?: {
  timeoutMs?: number;    // 默认 300000
}): Promise<EnsureDeveloperImageResult>;
```

`ensureLoopbackImageFiles` 的行为：
- `developerImageStatus` 已 `cache.ready`：直接返回。
- 未就绪：`downloadDeveloperImage` 后每 `pollMs` 查一次 `developerImageStatus`，直到 `ready` 或 `failure`；失败/超时抛错。
- 这是“需要镜像就主动下载”的 Phase A 客户端入口；页面按钮只用于手动管理。

`ensureLoopbackDeveloperImage`（Phase B）的行为：
- 直接调用 `ensureDeveloperImage`；服务端负责缺文件时下载，再安装。
- `not_paired`：调用方应先 `ensureLoopbackTunnel`（会走配对 UI），再重试。
- 不再提供 `allowDownload` 开关；需要镜像的脚本不应要求用户手动下载。

### 示例：只在缺服务时装镜像
```ts
import { ensureLoopbackTunnel, ensureLoopbackDeveloperImage } from "./kit/loopback";

const DEBUG_SERVICE = "com.apple.instruments.dtservicehub";

async function main() {
  const tunnel = await ensureLoopbackTunnel(); // ensureTunnel + attach
  try {
    let services = await tunnel.listServices({ refresh: true });
    if (!services.some(service => service.name === DEBUG_SERVICE)) {
      const image = await ensureLoopbackDeveloperImage();
      if (!image.ready) {
        throw new Error(`开发者镜像未就绪：${image.status}${image.message ? ` — ${image.message}` : ""}`);
      }
      services = await tunnel.listServices({ refresh: true });
    }
    if (!services.some(service => service.name === DEBUG_SERVICE)) {
      throw new Error(`设备仍未提供 ${DEBUG_SERVICE}`);
    }
    // 打开目标服务……
  } finally {
    await tunnel.close(); // 只释放自己的句柄，不调用 releaseTunnel
  }
}
```

### 结果处理
| `ensureDeveloperImage` 结果 | 调用方动作 |
| --- | --- |
| `installed` / `already_installed` / `already_mounted` | `refresh` 服务表，继续 |
| `not_paired` | 先 `ensureLoopbackTunnel` 完成配对，再重试 |
| `unsupported` | 停止重试，提示需要 iOS 26.4+ |
| `busy` | 等待后重试；不要并发重复调用 |
| `error` | 按 `stage` 提示；`download` 阶段检查网络/权限/镜像源，`ticket` / `install` 类失败可重试 |

### 边界
- 调用方不需要提示用户去页面下载；`ensureDeveloperImage` 会主动补齐缓存。删除缓存仍由 Loopback 页面负责。
- 调用方不卸载镜像；镜像持续到设备重启。
- 调用方不需要、也拿不到配对记录或 PSK；仍然用自己的 `localDevVPN` 权限 attach。
- 服务处理器串行：`ensureDeveloperImage` 执行期间，其他 Loopback 命令会排队；不要在等待安装时轮询 `status`。
- 下载默认不消耗蜂窝；自动下载同样遵守这一点，蜂窝下会明确报错，不会静默卡住。

## UI
首页新增 `开发者镜像` 入口，打开 `DeveloperImagePage`：

1. 状态区：iOS 版本、是否 26.4+、缓存 `n/5`、总大小。
2. 下载区：进度条、`下载` / `删除文件`；删除前 `Dialog.confirm`。
3. 安装区：`检查并安装` 按钮；显示阶段（检查/下载/识别/nonce/票据/安装/验证）、成功后版本。
4. 来源区：镜像 base URL 文本框（默认 SideInstaller 的 GitHub raw 地址），仅存本脚本 Storage；留空恢复默认；改 URL 后旧下载记录清理。
5. 说明：安装后镜像保持到设备重启；iOS < 26.4 不支持；下载默认不走蜂窝。

`CheckPage` 的 `run()` 请求 `["localDevVPN","vpn","fileSystem"]`，`checkAccess` 也把 `fileSystem` 算进必需项。

## Technical decisions
- **不直接复用 SideInstaller 的 `DeviceLink`**：Loopback 已有 `DeviceSession`、`PlistServiceClient`、四连接配额和隧道所有权；用 `DdiLink` 适配器复用这些能力，避免再把配对/隧道生命周期复制一份。
- **RemoteXPC 独立模块**：cryptexd 的 `install` 需要发送侧 HTTP/2 流控和五路 file transfer，现有 `Http2Client` 不处理这些；新模块不修改现有 RSD 握手路径。
- **mounter 走现有 PlistServiceClient**：`CopyDevices` 就是 RSDCheckin + 长度前缀 plist，和现有 shim 服务一致。
- **XPC file transfer 只扩展 `core/xpc.ts`**：增加一种类型，不重写现有编码器。
- **缓存层可注入 `FileSystem`/`Downloader`**：单测用内存实现，不依赖真机全局。
- **FileManager 只用异步 API**：`exists/stat/createDirectory/remove` 全部返回 Promise；状态机保存最近一次快照，页面和服务通过 `refresh()` 异步读盘，不在 getter 里做文件 I/O。
- **镜像源可覆盖**：默认值与 SideInstaller 一致；国内网络下可换成可达镜像，避免 GitHub raw 不可用。只接受 `https://`，并去掉尾部 `/`。

## Risks / Mitigations
| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 第三方镜像仓库变更/删除 | 下载失败或版本不匹配 | 默认 URL 常量 + UI 可覆盖；下载后解析 BuildManifest 校验 cryptex identity；失败信息带 URL |
| 镜像与 iOS 版本不匹配 | TSS 拒绝或安装失败 | 保留 SideInstaller 的同一镜像源；返回 TSS/cryptexd 原文；真机验收 |
| iOS < 26.4 | 无法安装 | 快速返回 `unsupported`；缓存仍可下载 |
| 17 MB 读入内存 + XPC 复制 | 内存峰值 | 与 SideInstaller 相同；记录风险，后续可改分块流式 |
| 安装期间 App 进入后台 | JS 挂起，安装中断 | 页面提示保持前台；失败可重试；不自动在后台执行 |
| 服务表未刷新 | 其他脚本看不到新服务 | Loopback 安装后 `refreshServices()`；README 要求调用方 `listServices({ refresh: true })` |
| 下载队列记录与已删文件不一致 | 重复下载得到旧记录 | 下载前检查 `getTaskByURL`，completed 但目标不存在时 `remove()` |
| 蜂窝网络默认禁止下载 | 用户以为下载坏了 | 错误文案明确“默认仅 Wi-Fi”；后续可加开关 |
| `fileSystem` 权限被拒 | 无法读写 Documents | 自检与页面明确提示；`Script.requestAccess` 提前请求 |
| 实例以“无权限运行”启动 | `requestAccess` 可能返回已授权，但文件操作仍报“本次脚本运行没有该权限” | 从 Scripting 手动打开 Loopback 并允许 `fileSystem`；不要在受限的 `Script.run` 实例里下载 |
| 服务命令超时 | 调用方以为失败，实际已安装 | `ensure` 只做安装；超时不清除状态；调用方可再调 status/ensure 核实 |
| 与已挂载镜像冲突 | cryptex 安装被拒 | 先查 mounter，发现任何条目返回 `already_mounted` |

## Implementation Phases
### Phase A — 下载与缓存（先交付）
1. `kit/ddi/cache.ts`：文件清单、目录、存在/大小检测、`ensureDdiFiles`、`nativeDdiDownloader`、`forgetDdiDownloads`、base URL 设置。
2. `kit/developerImage.ts`：状态机、下载并发去重、进度、删除、失败。
3. `pages/DeveloperImagePage.tsx` + 首页入口。
4. `kit/capability.ts` / `CheckPage` / `script.json` 权限。
5. `index.tsx`：`developerImageStatus`、`downloadDeveloperImage`。
6. `tests/ddi.ts`：缓存检测、进度汇总、删除记录、URL 规范化。
7. README 双语更新。

### Phase B — 安装与确保（随后交付）
1. `core/xpc.ts` fileTransfer + `core/http2frames.ts` / `kit/remoteXpc.ts`。
2. `kit/ddi/manifest.ts`、`tss.ts`、`mounter.ts`、`cryptexd.ts`、`install.ts`。
3. `DeviceSession.refreshServices()`。
4. `index.tsx`：`ensureDeveloperImage`。
5. 页面安装按钮与阶段显示。
6. `tests/xpc.ts` / `tests/ddi.ts` 扩展：manifest、ticket tags、nonce/UDID、TSS 响应、版本门禁、mounter 短路、阶段错误。
7. README 双语更新命令表。

Phase A 可独立验收；Phase B 依赖 Phase A 的缓存和页面。

## Validation Matrix
Static:
- `get_typescript_diagnostics` for Loopback: no issues.
- Existing `tests/presentation.ts`、`tests/vpn.ts` 全部通过，确认未回归。
- New unit tests:
  - cache: missing/partial/complete, zero-size file, progress aggregation, delete records, base URL normalization.
  - manifest: find cryptex identity, payload paths, properties, ticket tags, nonce unwrap, UDID bytes.
  - tss: success with `REQUEST_STRING=`, refusal without ticket, malformed plist.
  - xpc: fileTransfer round-trip, wrapper consumed length, HTTP/2 frame encode/parse.
  - install: unsupported version, already mounted short-circuit, automatic download failure, DdiError stage.
- Runtime (manual, iOS 26.4+):
  1. Fresh install: no cache → download 5 files → `n/5` and size correct → ensure `installed` → `copy-installed` version → refresh services → debug service visible.
  2. Already installed: ensure returns `already_installed` without re-download.
  3. Already mounted by mounter: ensure returns `already_mounted`.
  4. Delete cache → files gone → download again works; old queue records removed.
  5. Unpaired: ensure returns `not_paired`, no UI.
  6. iOS < 26.4: ensure returns `unsupported`.
  7. Failure injection: wrong base URL, no network, TSS refusal; page shows stage + reason; retry works.
- Regression:
  - `status`/`ensureTunnel`/`releaseTunnel` unchanged; cold start/service invocation behavior unchanged.
  - VPN source policy and pairing Keychain boundary unchanged.

## Decisions (approved 2026-11-20 14:18)
- [x] 范围：Phase A + Phase B，作为 Loopback 的可选补充能力；`ensureTunnel` 不自动安装。
- [x] 复用方式：最小适配。协议/常量/阶段原样照搬 SideInstaller，只替换 `DeviceSession`、`PlistServiceClient`、`core/xpc` 适配层；不整棵复制 `lib/ddi + lib/rsd + lib/rpp + lib/util`。
- [x] 服务命令：新增 `developerImageStatus`、`downloadDeveloperImage`、`ensureDeveloperImage`；现有 `status` / `ensureTunnel` / `releaseTunnel` 不变。
- [x] 镜像源：默认 SideInstaller 的 GitHub raw 地址，页面提供 base URL 覆盖；只接受 `https://`。
- [x] 其他脚本用法：按需补装。先取隧道并查目标服务，缺失时才 `ensureDeveloperImage`；安装后由调用方自己 `listServices({ refresh: true })`。
- [x] 下载策略：需要镜像时由 `ensureDeveloperImage` / `ensureLoopbackImageFiles` **主动自动下载**，不要求用户去页面点按钮；页面下载按钮只用于手动管理/重试。默认仍不走蜂窝。
- [x] 删除策略：页面只删除缓存文件与下载记录，不卸载设备上的镜像；不提供跨脚本卸载命令。
- [x] 客户端封装：`client/loopback.ts` 增加 `ensureLoopbackTunnel`、`ensureLoopbackDeveloperImage`、状态/下载类型与轮询逻辑。

## Checkpoint Summary
- 当前任务理解：参考 SideInstaller，为 Loopback 补可选的开发者镜像下载与安装能力；Phase A 先交付缓存/下载。
- 当前核心目标：Phase A 已交付；当前轮次的核心目标是确保缓存/下载可验证、可交接。
- 当前进度：Phase A 已实现（cache、状态机、页面、权限、两个新服务命令、客户端查询/下载函数、单测、README）；Phase B 未开始。
- 下一步 1：等待用户批准 Phase B。
- 下一步 2：批准后实现 RemoteXPC/安装/确保/服务刷新。
- 下一步 3：真机 iOS 26.4+ 验收安装流程。
- 涉及文件 / 模块：`kit/ddi/*`、`kit/remoteXpc.ts`、`kit/developerImage.ts`、`core/xpc.ts`、`kit/session.ts`、`pages/DeveloperImagePage.tsx`、`index.tsx`、`script.json`、README、tests。
- 风险：第三方镜像源、iOS 版本门禁、17 MB 内存峰值、服务串行阻塞、安装期间后台挂起、服务表刷新。
- 验证方式：类型检查 + 新单测 + 现有回归 + 真机 iOS 26.4+ 手工验收。
- Execution Approval: Phase A `Approved` / `Done`; Phase B `Pending`

## Change Log
- 2026-11-20: 创建 spec；记录 SideInstaller 参考实现、Loopback 适配方案、命令契约、风险与分阶段计划。未改代码。
- 2026-11-20: 补充 SideInstaller → Loopback 的逐文件复用映射，明确协议原样照搬、只替换传输/类型适配层。
- 2026-11-20 14:18: 用户确认补充能力定位与客户端用法；锁定 Phase A+B、三个新命令、最小适配、默认源可覆盖、按需补装、客户端自行 refresh。未改代码。
- 2026-11-20 14:19: 用户批准开始 Phase A。
- 2026-11-20: Phase A 实现完成：新增 `kit/ddi/cache.ts`、`kit/ddi/index.ts`、`kit/developerImage.ts`、`pages/DeveloperImagePage.tsx`、`tests/ddi.ts`；修改 `index.tsx`、`kit/capability.ts`、`pages/CheckPage.tsx`、`client/loopback.ts`、`script.json`、双语 README。
- 2026-11-20: 真机验收通过服务层：缓存 5/5、约 16.7 MB、`downloadDeveloperImage` 幂等；补充每文件大小 `files` 字段，单测增至 26。
- 2026-11-20: 发现 `FileManager.documentsDirectory` 是 app 级共享目录，原 `Documents/DDI` 会和 SideInstaller 的缓存互相覆盖/误删。缓存改到 `Documents/Loopback/DDI`；不删除 SideInstaller 的 `Documents/DDI`。此前真机看到的 5/5 可能来自共享目录，不能算 Loopback 独立缓存验收。
- 2026-11-20: 按用户要求移除所有 `FileManager.*Sync` 调用，改用异步 `exists/stat/createDirectory/remove`；`ddiFileState`、`deleteDdiFiles` 改为异步，状态机增加 `refresh()`，服务命令与页面打开时 await 读盘。单测仍为 27/27。
- 2026-11-20: 按用户要求改为“需要镜像就主动下载”：新增 `client/loopback.ts` 的 `ensureLoopbackImageFiles`（status → download → 轮询到 ready），移除 `allowDownload` 手动开关；真机隔离目录重新下载 5/5、`18,045,645` 字节并通过该入口返回 ready。
- 2026-11-20: Phase B 实现：新增 `core/http2frames.ts`、`kit/remoteXpc.ts`、`kit/ddi/manifest.ts`、`tss.ts`、`mounter.ts`、`cryptexd.ts`、`install.ts`、`link.ts`；`core/xpc.ts` 增加 fileTransfer；`DeviceSession.refreshServices()`；管理器加入安装状态与 `ensure()`；新增 `ensureDeveloperImage` 服务命令、页面安装按钮与客户端 `ensureLoopbackDeveloperImage`。单测新增 `tests/ddi_protocol.ts` 27/27。
- 2026-11-20 15:03: 真机 Phase B 检查通过：`ensureDeveloperImage` 返回 `already_installed`、版本 `27.2.52.0`；缓存 5/5；`listServices({refresh:true})` 共 85 项，包含 `com.apple.instruments.dtservicehub` 与 `com.apple.coredevice.debugserverproxy`。设备本已安装镜像，未执行实际上传/安装。脚本版本升到 `1.2.0`。

## Validation
- Self-check: Phase A 不改变配对/Keychain/VPN/隧道所有权；新增命令不打开 UI；下载走专用队列。
- Static checks: Loopback 全量 TypeScript diagnostics 无问题。
- Runtime / Test: `tests/ddi.ts` 27/27；`tests/ddi_protocol.ts` 27/27；`tests/presentation.ts` 9/9；`tests/vpn.ts` 6/6；`preview_ui` 临时入口渲染成功。
- 真机服务探测（2026-11-20）：隔离前 `developerImageStatus` 曾返回 `5/5`、`16,702,540` 字节；后发现这可能是 app 级共享的 `Documents/DDI`（SideInstaller 缓存），不作为 Loopback 独立缓存证据。
- 隔离后真机重新下载（2026-11-20）：`0/5` → `5/5`，总大小 `18,045,645` 字节；逐文件：BuildManifest 804,097、Image.dmg 17,239,040、trustcache 1,851、cryptex_info 428、root_hash 229；`ensureLoopbackImageFiles` 返回 `ready:true`。
- 用户要求：需要镜像时不能要求用户手动去页面下载；`ensureLoopbackImageFiles` 已实现自动下载并轮询，Phase B 的 `ensureDeveloperImage` 也会自动补齐缓存。
- Phase B 真机（2026-11-20 15:03）：`ensureDeveloperImage` 返回 `already_installed`、版本 `27.2.52.0`；缓存 5/5；客户端 `listServices({ refresh: true })` 返回 85 项，包含 `com.apple.instruments.dtservicehub` 和 `com.apple.coredevice.debugserverproxy`。设备已有镜像，五路 upload/TSS 安装路径未执行。
- Human confirmation: 范围与客户端契约已确认 2026-11-20 14:18；Phase A 实现已获批准。
- 结果汇总：Phase A 完成；Phase B（安装/确保）未实现。
- 核心目标是否已由证据证明完成：Phase A 是；整体 DDI 能力否。
- 若未完成，当前剩余差距：Phase B 安装链路、服务表刷新、真机安装验收。
- 剩余风险：见 Risks / Mitigations。Phase B 的 `copy-installed` / 服务表已由真机证明；`install` 五路 file transfer 与 TSS personalization 因设备已有镜像而未实际执行，仍需全新安装验证。

## Resume / Handoff
- 当前状态：Phase A 已验收；Phase B 代码完成，类型/单测/页面预览通过；真机 idempotent 路径已验收（already_installed + 调试服务可见）。
- 当前卡点：设备已有开发者镜像，无法在不卸载的前提下验证全新上传/安装路径；卸载/重装需单独的真机实验。
- 下一步唯一动作：如需验证全新安装，在可接受重启/重装的设备上删除镜像后运行 `tests/accept_phase_b.ts`；否则保持现状。
- 下一轮核心目标：确认 `install` 五路 file transfer 与 TSS personalization 在全新镜像上的真实表现。
