// Loopback 客户端：通过 ScriptSession 请求 A 准备/释放隧道，
// 然后由当前脚本独立 attach 自己的 VPNRSDTunnel 句柄。
// 不读取、不返回、不保存配对记录或任何密钥。

export const LOOPBACK_SCRIPT = "Loopback";

export type LoopbackStatus = {
  status: "paired" | "tunnel_open" | "not_paired" | "tunnel_closed" | "unsupported" | "error";
  ready?: boolean;
  released?: boolean;
  /** 本版本是否有 VPN / RSD 接口；缺省视为 true。 */
  supported?: boolean;
  /** 不支持时的缺口清单。 */
  missing?: string[];
  message?: string;
};

type LoopbackCommand =
  | "status"
  | "ensureTunnel"
  | "releaseTunnel"
  | "developerImageStatus"
  | "downloadDeveloperImage"
  | "ensureDeveloperImage";

/** Loopback 自己缓存的开发者镜像文件状态。 */
export type DeveloperImageCache = {
  present: number;
  total: number;
  bytes: number;
  ready: boolean;
  missing: string[];
  files: Array<{ file: string; size: number; present: boolean }>;
  /** 0..1；没有下载时为 null。 */
  progress: number | null;
  busy: boolean;
  failure: string;
  baseUrl: string;
};

export type DeveloperImageStatusResult = {
  status: "ok";
  cache: DeveloperImageCache;
};

export type DeveloperImageDownloadResult = {
  status: "started" | "already_ready" | "busy" | "error";
  cache: DeveloperImageCache;
  message?: string;
};

export type EnsureDeveloperImageResult = {
  status: "installed" | "already_installed" | "already_mounted"
    | "not_paired" | "unsupported" | "busy" | "error";
  ready: boolean;
  version?: string;
  stage?: string;
  cache: DeveloperImageCache;
  message?: string;
  supported?: boolean;
  missing?: string[];
};

async function call(command: LoopbackCommand, timeout = 180_000): Promise<LoopbackStatus> {
  return ScriptSession.call<LoopbackStatus>({
    name: LOOPBACK_SCRIPT,
    message: { command },
    timeout,
  });
}

/** 查询 A 当前是否已有配对/隧道。 */
export function loopbackStatus(): Promise<LoopbackStatus> {
  return call("status");
}

/** 请求 A 串行确保隧道就绪；成功后本脚本仍须 attach 自己的句柄。 */
export function openLoopback(timeout = 180_000): Promise<LoopbackStatus> {
  return call("ensureTunnel", timeout);
}

/** 请求 A 释放 A 自己的隧道句柄，不影响已经 attach 的其他脚本。 */
export function closeLoopback(): Promise<LoopbackStatus> {
  return call("releaseTunnel");
}

/** 查询 A 缓存的开发者镜像文件；不连设备、不打开 UI。 */
export function developerImageStatus(timeout = 10_000): Promise<DeveloperImageStatusResult> {
  return ScriptSession.call<DeveloperImageStatusResult>({
    name: LOOPBACK_SCRIPT,
    message: { command: "developerImageStatus" },
    timeout,
  });
}

/** 请求 A 启动/复用后台下载；立即返回，进度用 developerImageStatus 查询。 */
export function downloadDeveloperImage(timeout = 10_000): Promise<DeveloperImageDownloadResult> {
  return ScriptSession.call<DeveloperImageDownloadResult>({
    name: LOOPBACK_SCRIPT,
    message: { command: "downloadDeveloperImage" },
    timeout,
  });
}

/**
 * 确保镜像文件在 Loopback 的缓存里；缺失时自动下载并等待完成。
 *
 * 这是给“需要开发者镜像”的脚本用的：不要提示用户去页面点下载，直接调用它。
 * 默认最多等 5 分钟；下载本身在 Loopback 的后台队列里，调用方超时不会撤销已接受的工作。
 */
export async function ensureLoopbackImageFiles(options: {
  pollMs?: number;
  timeoutMs?: number;
} = {}): Promise<DeveloperImageCache> {
  const pollMs = options.pollMs ?? 2_000;
  const deadline = Date.now() + (options.timeoutMs ?? 300_000);

  let cache = (await developerImageStatus()).cache;
  if (cache.ready) return cache;

  if (!cache.busy) {
    const started = await downloadDeveloperImage();
    if (started.status === "error") {
      throw new Error(started.message ?? started.cache.failure ?? "开发者镜像下载启动失败");
    }
    cache = started.cache;
  }

  while (Date.now() < deadline) {
    if (cache.ready) return cache;
    if (!cache.busy && cache.failure) throw new Error(cache.failure);
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs, undefined));
    cache = (await developerImageStatus()).cache;
  }

  throw new Error(
    cache.failure ||
      `开发者镜像下载超时：${cache.present}/${cache.total}，${cache.bytes} 字节`,
  );
}

/**
 * 检查并安装开发者镜像；缺文件时 Loopback 会自动下载，不需要用户去页面点按钮。
 *
 * 建议 timeout 使用 300000；安装会串行占用 Loopback 的服务。
 */
export function ensureLoopbackDeveloperImage(timeout = 300_000): Promise<EnsureDeveloperImageResult> {
  return ScriptSession.call<EnsureDeveloperImageResult>({
    name: LOOPBACK_SCRIPT,
    message: { command: "ensureDeveloperImage" },
    timeout,
  });
}

/** 取得当前 ready tunnel 的独立句柄，不需要配对密钥。
 *
 * 商店版没有这套接口时返回 null（不抛），和"暂无 ready 隧道"用 [loopbackSupport] 区分。
 */
export function attachLoopbackTunnel(): Promise<VPNRSDTunnel | null> {
  const probe = probeVpn();
  if (!probe.localDev || typeof probe.localDev.attachRSDTunnel !== "function") return Promise.resolve(null);
  return probe.localDev.attachRSDTunnel();
}

// ── 版本能力 ─────────────────────────────────────────────────────────────
//
// 这个文件是要被别的脚本直接拿走的，所以探测自己写一份、不 import Loopback 内部模块。

type VpnProbe = {
  /** `VPN` 全局；不存在时为 undefined。 */
  api?: any;
  /** `VPN.localDevVPN`；不存在时为 undefined。 */
  localDev?: any;
  missing: string[];
};

const REQUIRED_LOCAL_DEV = ["getState", "setEnabled", "openRSDTunnel", "attachRSDTunnel"];

function probeVpn(): VpnProbe {
  // 只允许用 `typeof`：裸引用在没有该全局的版本上是 ReferenceError。
  const api = typeof VPN === "undefined" ? undefined : (VPN as any);
  if (!api) return { missing: ["VPN"] };
  const localDev = api.localDevVPN;
  if (!localDev || typeof localDev !== "object") return { api, missing: ["VPN.localDevVPN"] };
  const missing: string[] = [];
  for (const name of REQUIRED_LOCAL_DEV) {
    if (typeof localDev[name] !== "function") missing.push(`VPN.localDevVPN.${name}`);
  }
  return { api, localDev, missing };
}

/** 在调用任何 VPN / RSD 接口之前先问一句：这个版本到底支不支持。 */
export function loopbackSupport(): { supported: boolean; missing: string[]; message: string } {
  const missing = probeVpn().missing;
  if (missing.length === 0) return { supported: true, missing, message: "" };
  const zh = /^zh(?:[-_]|$)/i.test(Device.systemLocale);
  const list = missing.join(zh ? "、" : ", ");
  return {
    supported: false,
    missing,
    message: zh
      ? `当前 Scripting 版本不支持开发者通道相关 API（缺 ${list}）。请更新到包含 VPN / RSD 接口的版本，或改用开发版。`
      : `This Scripting build does not provide the developer-channel APIs (missing ${list}). Update to a build with VPN / RSD support, or use a development build.`,
  };
}
