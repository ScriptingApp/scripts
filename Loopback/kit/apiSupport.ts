// API 兼容层。
//
// 为什么要有这个文件：`VPN` / `VPN.localDevVPN` / `VPNRSDTunnel` 这一套属于
// VPN 功能的接口，商店版不一定有；旧版本也会缺其中一两个（`listServices`、
// `cancelRSDTunnelOpening` 都是后加的）。
//
// 三条规矩：
// 1. **只用 `typeof` 探测**，绝不对可能不存在的全局做裸引用。裸引用是
//    `ReferenceError`，而且写在默认参数位置时连 try/catch 都兜不住。
// 2. 结果是**结构化的缺口清单**，UI、错误文案、服务命令共用同一份，不各写各的。
// 3. 「不支持」是一等结果，不是错误：服务命令返回 `unsupported`，页面给说明。

import { tx } from "../core/i18n";

/** 建隧道必需：缺任何一个都算不支持。 */
export const REQUIRED_LOCAL_DEV = ["getState", "setEnabled", "openRSDTunnel", "attachRSDTunnel"] as const;

/** 有了更好；缺了只是少一条清理路径。 */
export const OPTIONAL_LOCAL_DEV = ["cancelRSDTunnelOpening"] as const;

/** 本脚本实际用到的隧道句柄成员。 */
export const REQUIRED_TUNNEL = ["getState", "connect", "listServices", "close"] as const;

/** 本脚本实际用到的连接成员。 */
export const REQUIRED_CONNECTION = ["read", "write", "close"] as const;

export type LocalDevSupport = {
  object: boolean;
  getState: boolean;
  setEnabled: boolean;
  openRSDTunnel: boolean;
  attachRSDTunnel: boolean;
  cancelRSDTunnelOpening: boolean;
};

export type VpnSupport = {
  /** `typeof VPN !== "undefined"`。 */
  vpn: boolean;
  proxy: { getState: boolean; start: boolean };
  localDev: LocalDevSupport;
  /** 建隧道所需的最小集合是否齐全。 */
  supported: boolean;
  /** 缺口清单，如 `["VPN.localDevVPN.openRSDTunnel"]`。 */
  missing: string[];
  /** 存在但缺失的可选成员；不影响 `supported`。 */
  optional: string[];
  /** 通过探测的全局对象；不支持时为 undefined，调用方不必再裸引用 `VPN`。 */
  api: VPNAPI | undefined;
};

export type TunnelSupport = Record<(typeof REQUIRED_TUNNEL)[number], boolean>;
export type ConnectionSupport = Record<(typeof REQUIRED_CONNECTION)[number], boolean>;

function has(object: unknown, name: string): boolean {
  return typeof object === "object" && object !== null && typeof (object as Record<string, unknown>)[name] === "function";
}

/** 当前运行时的 `VPN` 全局；不存在时返回 undefined。这是唯一允许碰 `VPN` 的地方。 */
export function currentVpnApi(): unknown {
  return typeof VPN === "undefined" ? undefined : (VPN as unknown);
}

/** 没有 VPN 接口时给用户看的话。`missing` 为空时省略括号。 */
export function unsupportedMessage(missing: string[]): string {
  return tx(
    `当前 Scripting 版本不支持开发者通道相关 API${missing.length > 0 ? `（缺 ${missing.join("、")}）` : ""}。请更新到包含 VPN / RSD 接口的版本，或改用开发版。`,
    `This Scripting build does not provide the developer-channel APIs${missing.length > 0 ? ` (missing ${missing.join(", ")})` : ""}. Update to a build with VPN / RSD support, or use a development build.`,
  );
}

/** 本版本不支持开发者通道。与网络错误区分开，调用方不要改写文案。 */
export class VpnUnsupportedError extends Error {
  readonly code = "unsupported";

  constructor(
    readonly missing: string[],
    message: string = unsupportedMessage(missing),
  ) {
    super(message);
    this.name = "VpnUnsupportedError";
  }
}

/** 对任意对象做一次能力探测；测试与降级页面都走这里，避免各处自己拼判断。 */
export function vpnSupportOf(api: unknown): VpnSupport {
  const present = typeof api === "object" && api !== null;
  const root = present ? (api as Record<string, unknown>) : undefined;
  const rawLocal = root ? root.localDevVPN : undefined;
  const hasLocal = typeof rawLocal === "object" && rawLocal !== null;

  const localDev: LocalDevSupport = {
    object: hasLocal,
    getState: has(rawLocal, "getState"),
    setEnabled: has(rawLocal, "setEnabled"),
    openRSDTunnel: has(rawLocal, "openRSDTunnel"),
    attachRSDTunnel: has(rawLocal, "attachRSDTunnel"),
    cancelRSDTunnelOpening: has(rawLocal, "cancelRSDTunnelOpening"),
  };

  const missing: string[] = [];
  if (!present) {
    missing.push("VPN");
  } else if (!localDev.object) {
    missing.push("VPN.localDevVPN");
  } else {
    for (const name of REQUIRED_LOCAL_DEV) {
      if (!localDev[name]) missing.push(`VPN.localDevVPN.${name}`);
    }
  }

  const optional = localDev.object
    ? OPTIONAL_LOCAL_DEV.filter((name) => !localDev[name]).map((name) => `VPN.localDevVPN.${name}`)
    : [];

  return {
    vpn: present,
    proxy: { getState: has(root, "getState"), start: has(root, "start") },
    localDev,
    supported: missing.length === 0,
    missing,
    optional,
    api: missing.length === 0 ? (api as VPNAPI) : undefined,
  };
}

/** 探测当前运行时。 */
export function vpnSupport(): VpnSupport {
  return vpnSupportOf(currentVpnApi());
}

/** 不满足就抛 `VpnUnsupportedError`。与探测分开，便于注入一份"缺失"的能力表来断言。 */
export function assertSupported(support: VpnSupport): VpnSupport {
  if (!support.supported) throw new VpnUnsupportedError(support.missing);
  return support;
}

/** 探测并返回可用的全局对象；不满足时抛 `VpnUnsupportedError`。 */
export function requireVpnSupport(api?: unknown): VpnSupport {
  return assertSupported(api === undefined ? vpnSupport() : vpnSupportOf(api));
}

/** 列出 `prefix` 对象上缺失的成员；`object` 不存在时全部算缺。 */
export function missingMembers(prefix: string, object: unknown, names: readonly string[]): string[] {
  const out: string[] = [];
  for (const name of names) {
    if (!has(object, name)) out.push(`${prefix}.${name}`);
  }
  return out;
}

export function tunnelSupport(tunnel: unknown): TunnelSupport {
  return {
    getState: has(tunnel, "getState"),
    connect: has(tunnel, "connect"),
    listServices: has(tunnel, "listServices"),
    close: has(tunnel, "close"),
  };
}

/** 句柄级探测：旧版本可能没有 `listServices` 之类的后加成员。 */
export function requireTunnel(tunnel: unknown): void {
  const missing = missingMembers("VPNRSDTunnel", tunnel, REQUIRED_TUNNEL);
  if (missing.length > 0) throw new VpnUnsupportedError(missing);
}

export function connectionSupport(connection: unknown): ConnectionSupport {
  return {
    read: has(connection, "read"),
    write: has(connection, "write"),
    close: has(connection, "close"),
  };
}

export function requireConnection(connection: unknown): void {
  const missing = missingMembers("VPNRSDConnection", connection, REQUIRED_CONNECTION);
  if (missing.length > 0) throw new VpnUnsupportedError(missing);
}
