# Spec: VPN / RSD API availability on App Store builds

## Status
Proposed 2026-11-20 23:39. User approved "spec first, then implement" the same minute.
Contract revised the same minute: dependencies must answer `status: "unsupported"` through `ScriptSession` so callers are told "this build is not supported".
Implementation approved 2026-11-20 23:41 and completed the same day. Tests: `tests/api_support.ts` 20/20; existing suites unchanged and green; TypeScript diagnostics 0.
Not verified on a real App Store build (cannot be installed on this device); mock/injected coverage only.

## Restated Understanding
- 用户要求：Loopback 需要做 API 兼容处理。`RSD` 一类属于 VPN 功能的 API 在商店版（App Store 版本）不可用，所以脚本必须先判断 API 是否存在，再决定能不能用。
- 本轮交付分两步：先更新 spec（本文件），批准后再改代码。spec 阶段不动任何实现文件。
- 不在本轮扩大范围：不改配对协议、Keychain、隧道所有权、DDI 流程，也不为商店版设计另一套传输。

## Problem
商店版缺少这些 API 时，脚本不会得到一个 "false"，而是三种硬失败：

| 形态 | 触发写法 | 运行时错误 |
| --- | --- | --- |
| 全局不存在 | `VPN.xxx` | `ReferenceError: Can't find variable: VPN` |
| 中间对象不存在 | `VPN.localDevVPN.xxx` | `TypeError: undefined is not an object` |
| 方法不存在 | `localDevVPN.openRSDTunnel(...)` | `TypeError: ... is not a function` |

只有 `typeof VPN` 是安全的判定方式。第三种形态在本脚本里同样现实：`listServices({refresh, timeout})`、`cancelRSDTunnelOpening()`、`attachRSDTunnel()` 都是后加的能力，旧版本可以只缺其中一两个。

未确证商店版究竟缺的是整个 `VPN` 全局，还是只有 `VPN.localDevVPN`。**设计上不依赖这个答案**：逐层探测，三种形态都必须被覆盖。

## Inventory — 当前 16 个运行时触点

标注 `bare` 的是裸引用，`probe` 的是已有 `typeof` 守卫。

### A. 全局对象
| # | API | 调用点 |
| --- | --- | --- |
| 1 | `VPN` | `kit/vpn.ts:17` (bare, 默认参数)、`kit/hub.ts:85`、`kit/session.ts:249,257`、`client/loopback.ts:151`、`pages/CheckPage.tsx:95` (probe) |

### B. VPN 代理主干
| # | API | 调用点 |
| --- | --- | --- |
| 2 | `VPN.getState()` | `kit/vpn.ts:40` |
| 3 | `VPN.start()` | `kit/vpn.ts:46` |

`VPN.stop()` 未使用。

### C. `VPN.localDevVPN`
| # | API | 调用点 |
| --- | --- | --- |
| 4 | `.localDevVPN` | `kit/capability.ts:77`、`kit/vpn.ts:6`、`kit/hub.ts:85`、`kit/session.ts:249,257`、`client/loopback.ts:151` |
| 5 | `.getState()` | `kit/vpn.ts:33,51` |
| 6 | `.setEnabled(enabled, { expectedState })` | `kit/vpn.ts:36` |
| 7 | `.openRSDTunnel({ host, port, preSharedKey, timeout })` | `kit/session.ts:249` |
| 8 | `.attachRSDTunnel()` | `kit/hub.ts:85`、`client/loopback.ts:151` |
| 9 | `.cancelRSDTunnelOpening()` | `kit/session.ts:257` |

### D. `VPNRSDTunnel`
| # | API | 调用点 |
| --- | --- | --- |
| 10 | `.listServices({ refresh, timeout })` | `kit/session.ts:195,211` |
| 11 | `.connect({ port })` | `kit/session.ts:332`、`kit/lockdown.ts:78` |
| 12 | `.getState()` | `kit/session.ts:351` |
| 13 | `.close()` | `kit/session.ts:202,267,365` |

`resolveService()` / `closeConnections()` 未使用；以后要用需一并探测。

### E. `VPNRSDConnection`
| # | API | 调用点 |
| --- | --- | --- |
| 14 | `.read(max)` | `kit/session.ts:335`、`kit/lockdown.ts:34` |
| 15 | `.write(bytes)` | `kit/session.ts:336`、`kit/lockdown.ts:115` |
| 16 | `.close()` | `kit/session.ts:337,341`、`kit/lockdown.ts:84,92,180` |

`readData` / `writeData` / `end` 未使用。

### F. 权限 id
- `script.json:22-23`：`"vpn"`、`"localDevVPN"`
- `pages/CheckPage.tsx:81`：`Script.requestAccess(["localDevVPN", "vpn", "fileSystem"])`
- `kit/capability.ts:131`：同一组 id 的校验清单

### G. 仅类型引用（编译期擦除，无需运行时判断）
`VPNAPI`、`VPNLocalDevAPI`、`VPNLocalDevState`、`VPNState`、`VPNRSDTunnel`、`VPNRSDConnection`、`VPNRSDState`、`VPNRSDService`

### H. 不属于 VPN 家族、但同批易缺
- `Bonjour.browse/resolve/publish`：`core/bonjour.ts:74,79`、`core/pair_setup.ts:145`（已有 `typeof` 退回端口扫描的降级路径）
- `DeviceServices`：当前未使用；将来若用 `adopt()` / `openRSDSession()` 需一并探测
- `ScriptSession.serve/call`：跨脚本接入整条链路压在它上面，缺了就是另一个独立降级问题
- 错误码 `ERR_PRO_REQUIRED`：网络/VPN 类操作可能因权限或版本被拒，需映射成同一条提示

## Contract

### 1. 单一探测入口 `kit/apiSupport.ts`
新增模块，纯函数、无副作用、不发网络请求、不开隧道：

```ts
export type TunnelApi = {
  getState: boolean; connect: boolean; listServices: boolean; close: boolean;
};
export type ConnectionApi = { read: boolean; write: boolean; close: boolean };

export type VpnSupport = {
  vpn: boolean;              // typeof VPN === "object"
  proxy: { getState: boolean; start: boolean };
  localDev: {
    object: boolean; getState: boolean; setEnabled: boolean;
    openRSDTunnel: boolean; attachRSDTunnel: boolean; cancelRSDTunnelOpening: boolean;
  };
  supported: boolean;        // 建隧道所需的最小集合是否齐全
  missing: string[];         // 如 "VPN.localDevVPN.openRSDTunnel"
};

export function vpnSupport(api?: unknown): VpnSupport;       // api 可注入，便于单测
export function requireVpnSupport(api?: unknown): VpnSupport; // 不满足时抛 VpnUnsupportedError
export function tunnelSupport(tunnel: unknown): TunnelApi;    // 句柄级，首次使用时探一次
export function connectionSupport(connection: unknown): ConnectionApi;
export class VpnUnsupportedError extends Error {
  readonly code = "unsupported";
  readonly missing: string[];
}
```

- `supported` 的最小集合：`vpn` + `localDev.object` + `getState`/`setEnabled` + `openRSDTunnel` + `attachRSDTunnel`。`cancelRSDTunnelOpening` 缺了只降级（跳过取消），不算不支持。
- 探测与判定分开：`vpnSupportOf(api)` 只回答"有什么"，`assertSupported(support)` 才抛错。这样单测可以注入一份缺失的能力表，走的是真机上同一条分支。
- **离线 Node 运行时会把 `VPN` 垫成"任意属性都返回函数"的桩**（`Object.keys` 为空，但每个成员都是 function）。所以单测不能用无参探测来模拟商店版，必须注入能力表；真机上缺失的成员是 `undefined`，探测行为正确。
- 句柄级探测只能在拿到 `VPNRSDTunnel` 之后做，因此放在 `DeviceSession` 构造时执行一次并缓存，缺方法时抛 `VpnUnsupportedError` 而不是 `TypeError`。

### 2. 消除所有裸引用
- `kit/vpn.ts` 的默认参数 `control: VPNControl = VPN` 必须去掉（它在函数体之前求值，`try/catch` 兜不住）。改成 `control?: VPNControl`，函数内 `control ?? requireVpnSupport().api`。
- `kit/hub.ts`、`kit/session.ts`、`client/loopback.ts`、`pages/CheckPage.tsx` 一律先探测再取用。
- 不引入"版本号判断"作为主判据；`Device.appVersion` 只用于文案。

### 3. 错误分层
- `VpnUnsupportedError`：本版本没有该能力。**不**经过 `withLinkHint()` 改写，**不**被当成网络错误，文案固定为"当前 Scripting 版本不支持开发者通道（缺 X、Y）"。
- `VPNPreparationError`：有 API 但准备 VPN 失败（沿用现状）。
- 其余：保持现有链路提示逻辑。

### 4. 服务命令契约（不支持就明说）
凡是依赖 VPN / RSD 的命令，在当前运行时缺 API 时**统一返回 `status: "unsupported"`**，把“当前版本不支持”作为一等结果交给调用方，而不是伪装成 `error` 或 `not_paired`。

```ts
type LoopbackResult = {
  status: "paired" | "tunnel_open" | "not_paired" | "tunnel_closed" | "unsupported" | "error";
  ready?: boolean; released?: boolean;
  supported?: boolean;   // 新增；缺省视为 true
  missing?: string[];    // 新增；缺口清单，如 ["VPN.localDevVPN.openRSDTunnel"]
  message?: string;      // 不支持时固定文案，见下
};
```

固定文案（`missing` 为空时不列后缀）：

| 语言 | 文案 |
| --- | --- |
| zh | `当前 Scripting 版本不支持开发者通道相关 API（缺 {missing}）。请更新到包含 VPN / RSD 接口的版本，或改用开发版。` |
| en | `This Scripting build does not provide the developer-channel APIs (missing {missing}). Update to a build with VPN / RSD support, or use a development build.` |

逐命令行为：

| 命令 | 不支持时 | 是否仍会做别的事 |
| --- | --- | --- |
| `status` | `{ status: "unsupported", supported: false, missing, message }` | 不读设备、不建会话；`loadPairing()` 照常（只读 Keychain） |
| `ensureTunnel` | 同上，`ready: false` | 不弹配对页、不准备 VPN、不尝试连接 |
| `releaseTunnel` | 同上，`released: false` | 无隧道可放；直接返回，不做清理动作 |
| `ensureDeveloperImage` | `{ status: "unsupported", ready: false, missing, message }`，并附 `stage: "api"` | 不连设备；缓存状态照常带在 `cache` 里 |
| `developerImageStatus` / `downloadDeveloperImage` | **不返回 unsupported**（不依赖 VPN，纯 HTTP + 文件系统） | 商店版仍可下载、删除、查看进度 |

实现要点：
- 判定放在 `commandOf()` 之后、各命令分支之前：`if (needsVpn(command) && !VPN_SUPPORT.supported) return unsupportedResult(command, VPN_SUPPORT);`
- `needsVpn()` / `unsupportedReply()` 落在 `kit/serviceResult.ts`：抽成纯函数才能脱机断言契约，不必跑起 `index.tsx`（它会注册服务、可能弹页面）。
- `needsVpn()` 是纯函数白名单，避免每个分支各写一遍判断，也避免漏掉将来新增命令。
- 错误路径不得把 `VpnUnsupportedError` 降级成 `message` 里的裸错误字符串；统一走 `unsupportedResult()`。
- 该分支在 `ScriptSession.serve` 回调内同步返回，不 await 任何原生调用，因此冷启动也不会有超时风险。

### 5. 客户端公开 API
`client/loopback.ts` 是给其他脚本用的入口，绝不能把 `ReferenceError` 抛给调用方：

```ts
export type LoopbackStatus = {
  status: "paired" | "tunnel_open" | "not_paired" | "tunnel_closed" | "unsupported" | "error";
  ready?: boolean; released?: boolean; message?: string;
  supported?: boolean; missing?: string[];
};

export function loopbackSupport(): { supported: boolean; missing: string[]; message: string };
export function attachLoopbackTunnel(): Promise<VPNRSDTunnel | null>; // 不支持时返回 null，不抛
```

- 调用方拿到 `status === "unsupported"` 即可直接展示 `message`，不必自己拼文案。
- `attachLoopbackTunnel()` 返回 `null` 的两种语义（"本版本不支持"与"暂无 ready 隧道"）由 `loopbackSupport()` 区分。
- 客户端的 `loopbackStatus()` / `openLoopback()` 不做本地预判，一律以服务端返回为准（避免两边判定不一致）。

### 6. UI 降级
| 位置 | 不支持时 |
| --- | --- |
| 首页 | 顶部一条常驻说明：当前版本不支持开发者通道 + 缺口清单；「验证配对记录」按钮置灰 |
| 兼容性自检 | 「隧道接口」一项从 `fail` 细化：逐条列出缺失成员；权限项在能力缺失时改文案为"本版本无此权限"，不催用户去授权一个不存在的东西 |
| 配对页 | 入口置灰 + 说明；不进入 PIN/导入流程 |
| 开发者镜像页 | 下载/删除/状态照常；「检查并安装」置灰并说明需要开发者通道 |

### 7. 权限
- `script.json` 的 `vpn` / `localDevVPN` 保留：开发版需要，商店版忽略。
- `Script.requestAccess(...)` 必须 try/catch；`granted` 里缺 `localDevVPN` 且 `vpnSupport().supported === false` 时，结论是"版本不支持"而不是"用户没授权"。

## Scope
In:
- `kit/apiSupport.ts` 新增；`kit/serviceResult.ts` 新增（服务契约纯函数）。
- `kit/vpn.ts`、`kit/hub.ts`、`kit/session.ts`、`client/loopback.ts`、`index.tsx`、`pages/*` 接入探测与降级。
- `kit/capability.ts` 的 `checkTunnelApi` 扩成逐成员清单。
- `tests/api_support.ts` 新增纯逻辑单测（注入 mock API 对象）。
- 中英文 README、`script.json` 版本号。

Out:
- 商店版的替代传输（蓝牙 / 其它发现方式）；不支持就是不支持。
- 改 `DeviceSession` 名额模型、DDI 协议、配对协议。
- 探测 `Bonjour` / `ScriptSession` 的缺失并做降级（当前已有 `typeof Bonjour` 兜底，`ScriptSession` 属于独立议题）。

## Verification
- `tests/api_support.ts`：`undefined` / `{}` / 只有 `VPN` / 只有 `localDevVPN` / 缺单个方法 / 齐全 六类输入，断言 `supported` 与 `missing`。
- 现有回归全绿：`tests/vpn.ts` 6/6、`tests/presentation.ts` 9/9、`tests/ddi.ts` 27/27、`tests/ddi_protocol.ts` 27/27。
- 全项目 TypeScript diagnostics 为 0。
- 真机（开发版）复验：`ensureTunnel` 仍返回 `tunnel_open`；`ensureDeveloperImage` 仍返回 `already_installed`。
- `tests/api_support.ts` 另加服务层断言：注入不支持的能力表后，`status` / `ensureTunnel` / `releaseTunnel` / `ensureDeveloperImage` 四个命令都返回 `status: "unsupported"`、`supported: false`、非空 `missing`、文案含“当前 Scripting 版本不支持”；两个镜像下载命令仍正常返回。
- 商店版无法在本机构造，**只能**用 mock 覆盖：在断言里显式注明"商店版真机路径未验证"，不声称已实测。

## Validation evidence (2026-11-20)
- `tests/api_support.ts` 20/20：缺失全局 / 缺 `localDevVPN` / 成员逐个缺失 / 仅缺可选成员 / 完整可用 / 旧句柄缺 3 个成员 / 白名单命中与不命中 / 四种 unsupported 应答字段 / `prepareVPN` 原样透传 `VpnUnsupportedError` 而不包成 `VPNPreparationError` / proxyApp 不碰 API。
- 回归：`tests/vpn.ts` 6/6、`tests/presentation.ts` 9/9、`tests/ddi.ts` 27/27、`tests/ddi_protocol.ts` 27/27。
- 全项目 TypeScript diagnostics：0。
- 落地要点：`kit/vpn.ts` 去掉 `= VPN` 默认参数；`hub.open` 先探测再取句柄，`VpnUnsupportedError` 不被 `withLinkHint` 改写；`DeviceSession.open` 开头 `requireVpnSupport()`、`attach` 里 `requireTunnel()`；`cancelRSDTunnelOpening` 缺失时跳过；`client/loopback.ts` 自带零依赖探测 + `loopbackSupport()`，`attachLoopbackTunnel()` 不支持时返回 `null`；首页红条 + 配对/验证置灰；`TaskStateSection` 对 unsupported 不显示"重试"；镜像页只有"检查并安装"被门禁；自检页按能力请求权限（不支持时只请求 `fileSystem`）。
- `script.json` 版本 `1.3.0`；中英文 README 增补"版本兼容"章节与 `unsupported` 示例。

## Remaining boundaries
- 无法在开发机上模拟"商店版缺 API"的真实运行时，验收依赖注入测试 + 用户实机反馈。
- 若商店版连 `ScriptSession` 都不可用，跨脚本接入整体失效；本 spec 不处理。
- `ERR_PRO_REQUIRED` 的实际触发面未确证，只做统一文案映射。
- 未请求 Git 提交或推送。

## Handoff
实施顺序已完成：`kit/apiSupport.ts` + 单测 → 消裸引用（`kit/vpn.ts` 优先）→ 服务命令与错误分层 → UI 降级 → README 与版本号。
未做：Git 提交/推送；商店版真机验收（本机装不了商店版）。
下一处值得动的地方：若商店版连 `ScriptSession` 也缺，需要单独一份"跨脚本接入不可用"的降级设计。
